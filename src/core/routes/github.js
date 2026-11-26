// RelayBox core routes — GitHub Release manual pull & scheduled auto-watch (v3.7.0).
// Pure Web Standard APIs, zero Node dependencies.
// Covers:
//   GET    /api/github/config          — check if encrypted GitHub token is configured
//   PUT    /api/github/config          — save or clear encrypted GitHub token
//   GET    /api/github/release?repo=   — inspect latest GitHub release & assets
//   POST   /api/github/pull            — manually pull selected release assets to R2/S3
//   GET    /api/github/watches         — list all auto-watch subscriptions
//   POST   /api/github/watches         — create a new auto-watch subscription
//   PUT    /api/github/watches/:id     — update watch settings (enabled, replaceOld, pattern, etc.)
//   DELETE /api/github/watches/:id     — delete watch subscription
//   POST   /api/github/watches/:id/check — immediately check & pull one watch

import { readJsonBody, newId, safeName, extOf, kindOf, keyOf, MIME, log } from '../lib/util.js';
import { isAuthed } from '../lib/auth.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { recordAudit } from '../lib/audit.js';
import { sendTelegramMessage, getTelegramConfig, fmtBytes, escapeTgHtml } from '../lib/notify.js';
import { resolveUploadTarget } from './pools.js';
import { moveFileToTrash } from './trash.js';

export const SETTING_GITHUB_TOKEN_ENC = 'github_token_enc';
const DEFAULT_MAX_ASSET_BYTES = 150 * 1024 * 1024; // 150 MB safe Workers streaming ceiling
const MAX_ASSETS_PER_PULL = 5;
const WATCH_CHECK_INTERVAL_MS = 6 * 3600 * 1000; // 6h interval per watch on Cron
const MAX_WATCHES_PER_CRON = 3;
const FETCH_TIMEOUT_MS = 45000;

/** Normalize `owner/repo` or `https://github.com/owner/repo/...` -> `owner/repo`, or '' if invalid. */
export function parseRepoInput(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\/(?:www\.)?github\.com\//i, '');
  s = s.replace(/\.git$/i, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  const candidate = `${parts[0]}/${parts[1]}`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) return '';
  return candidate;
}

/** Convert comma/newline-separated glob pattern(s) (e.g. `*.apk, *win64*.exe`) to matcher function. */
export function buildAssetMatcher(patternStr) {
  const raw = String(patternStr || '*').trim();
  const tokens = raw.split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);
  if (!tokens.length || tokens.includes('*')) return () => true;
  const regexes = tokens.map((tok) => {
    const escaped = tok.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
  });
  return (name) => regexes.some((re) => re.test(String(name || '')));
}

function isAllowedGithubAssetUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'github.com' || h === 'api.github.com' || h.endsWith('.githubusercontent.com') || h.endsWith('.github.com');
  } catch {
    return false;
  }
}

async function getGithubToken(deps) {
  if (!deps || !deps.meta || typeof deps.meta.getSetting !== 'function') return '';
  const enc = await deps.meta.getSetting(SETTING_GITHUB_TOKEN_ENC);
  if (!enc) return '';
  try {
    return await decryptSecret(enc, deps.config.uploadPassword);
  } catch {
    return '';
  }
}

function githubApiHeaders(token) {
  const h = {
    'User-Agent': 'RelayBox-GitHubPull/3.7.2',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

/** Parse human-readable size like "68.3 MB" / "512 KB" / "1.2 GB" / "940 Bytes" into bytes. */
export function parseHumanSize(raw) {
  const m = String(raw || '').trim().match(/^(\d+(?:\.\d+)?)\s*(B|Bytes|KB|KiB|MB|MiB|GB|GiB)$/i);
  if (!m) return 0;
  const val = Number(m[1]);
  if (!Number.isFinite(val) || val < 0) return 0;
  const unit = m[2].toLowerCase();
  if (unit === 'b' || unit === 'bytes') return Math.round(val);
  if (unit === 'kb' || unit === 'kib') return Math.round(val * 1024);
  if (unit === 'mb' || unit === 'mib') return Math.round(val * 1024 * 1024);
  if (unit === 'gb' || unit === 'gib') return Math.round(val * 1024 * 1024 * 1024);
  return 0;
}

/** Parse GitHub expanded_assets HTML fragment into release asset entries. */
export function parseExpandedAssetsHtml(cleanRepo, html) {
  const assets = [];
  const seen = new Set();
  const text = String(html || '');
  const escapedRepo = cleanRepo.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const dlRe = new RegExp(`href="(\\/${escapedRepo}\\/releases\\/download\\/[^"]+)"`, 'gi');
  // Prefer per-<li> blocks so we can associate human-readable file size with each asset
  const liBlocks = text.match(/<li\b[\s\S]*?<\/li>/gi) || [text];
  for (const block of liBlocks) {
    dlRe.lastIndex = 0;
    const m = dlRe.exec(block);
    if (!m) continue;
    const relHref = m[1];
    const downloadUrl = `https://github.com${relHref}`;
    if (seen.has(downloadUrl)) continue;
    seen.add(downloadUrl);
    const segs = relHref.split('/');
    let name = segs[segs.length - 1] || 'asset';
    try { name = decodeURIComponent(name); } catch {}
    const sizeMatch = block.match(/>\s*(\d+(?:\.\d+)?\s*(?:Bytes|KB|KiB|MB|MiB|GB|GiB|B))\s*</i);
    const size = sizeMatch ? parseHumanSize(sizeMatch[1]) : 0;
    assets.push({
      id: 0,
      name,
      size,
      contentType: 'application/octet-stream',
      downloadUrl,
      apiUrl: '',
      downloadCount: 0,
    });
  }
  return assets;
}

/**
 * Fallback for public repos when unauthenticated api.github.com hits 403/429 on shared CF egress IPs.
 * Follows github.com/<owner>/<repo>/releases/latest redirect to discover tag, then parses expanded_assets HTML.
 */
export async function fetchLatestReleaseViaHtml(cleanRepo, fetchFn, signal) {
  const webHeaders = {
    'User-Agent': 'Mozilla/5.0 (compatible; RelayBox-GitHubPull/3.7.2)',
    'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  };
  const latestRes = await fetchFn(`https://github.com/${cleanRepo}/releases/latest`, {
    headers: webHeaders,
    redirect: 'follow',
    signal,
  });
  if (latestRes.status === 404) {
    return { ok: false, status: 404, error: '未找到该仓库或仓库尚无正式 Release' };
  }
  if (!latestRes.ok) {
    return { ok: false, status: 502, error: `GitHub 网页解析失败（HTTP ${latestRes.status}）` };
  }
  const latestHtml = await latestRes.text();
  let tag = '';
  const finalUrl = String(latestRes.url || '');
  const urlTagMatch = finalUrl.match(/\/releases\/tag\/([^/?#]+)/i);
  if (urlTagMatch) {
    try { tag = decodeURIComponent(urlTagMatch[1]); } catch { tag = urlTagMatch[1]; }
  }
  if (!tag) {
    const expMatch = latestHtml.match(/\/releases\/expanded_assets\/([^"'?#\s]+)/i);
    if (expMatch) {
      try { tag = decodeURIComponent(expMatch[1]); } catch { tag = expMatch[1]; }
    }
  }
  if (!tag) {
    return { ok: false, status: 404, error: '未找到该仓库或仓库尚无正式 Release' };
  }

  let publishedAt = null;
  const timeMatch = latestHtml.match(/<relative-time[^>]+datetime="([^"]+)"/i);
  if (timeMatch) publishedAt = timeMatch[1];

  const expRes = await fetchFn(
    `https://github.com/${cleanRepo}/releases/expanded_assets/${encodeURIComponent(tag)}`,
    { headers: webHeaders, redirect: 'follow', signal },
  );
  if (!expRes.ok) {
    return { ok: false, status: 502, error: `GitHub 资产列表解析失败（HTTP ${expRes.status}）` };
  }
  const expHtml = await expRes.text();
  const assets = parseExpandedAssetsHtml(cleanRepo, expHtml);
  return {
    ok: true,
    repo: cleanRepo,
    tag,
    name: tag,
    publishedAt,
    htmlUrl: `https://github.com/${cleanRepo}/releases/tag/${encodeURIComponent(tag)}`,
    body: '',
    assets,
    fallback: 'html',
  };
}

export async function fetchLatestRelease(deps, repo) {
  const cleanRepo = parseRepoInput(repo);
  if (!cleanRepo) return { ok: false, status: 400, error: 'GitHub 仓库格式不正确（应为 owner/repo）' };
  const token = await getGithubToken(deps);
  const fetchFn = (deps && typeof deps.fetch === 'function') ? deps.fetch : fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetchFn(`https://api.github.com/repos/${cleanRepo}/releases/latest`, {
      headers: githubApiHeaders(token),
      signal: controller.signal,
    });
    if (res.status === 404) {
      return { ok: false, status: 404, error: '未找到该仓库或仓库尚无正式 Release' };
    }
    if (res.status === 403 || res.status === 429) {
      // Unauthenticated CF Workers egress IP often hits GitHub API rate limit; fall back to public HTML parsing
      if (!token) {
        try {
          const fb = await fetchLatestReleaseViaHtml(cleanRepo, fetchFn, controller.signal);
          if (fb && fb.ok) return fb;
        } catch {}
      }
      const rem = res.headers.get('x-ratelimit-remaining');
      return {
        ok: false,
        status: 429,
        error: rem === '0'
          ? 'GitHub API 已触发匿名速率限制且网页兜底解析失败，请在下方配置只读 GitHub Token 提升至 5,000 次/小时'
          : `GitHub API 拒绝访问（HTTP ${res.status}）`,
      };
    }
    if (!res.ok) {
      return { ok: false, status: 502, error: `GitHub API 返回 HTTP ${res.status}` };
    }
    const data = await res.json();
    const assets = Array.isArray(data.assets) ? data.assets.map((a) => ({
      id: a.id,
      name: a.name || 'asset',
      size: Number(a.size || 0),
      contentType: a.content_type || 'application/octet-stream',
      downloadUrl: a.browser_download_url || '',
      apiUrl: a.url || '',
      downloadCount: Number(a.download_count || 0),
    })).filter((a) => a.downloadUrl) : [];
    return {
      ok: true,
      repo: cleanRepo,
      tag: data.tag_name || '',
      name: data.name || data.tag_name || '',
      publishedAt: data.published_at || null,
      htmlUrl: data.html_url || `https://github.com/${cleanRepo}/releases`,
      body: typeof data.body === 'string' ? data.body.slice(0, 600) : '',
      assets,
    };
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    return { ok: false, status: isTimeout ? 504 : 502, error: isTimeout ? '连接 GitHub API 超时' : ('请求 GitHub 失败：' + ((e && e.message) || '网络错误')) };
  } finally {
    clearTimeout(timer);
  }
}

async function pullSingleAsset(deps, asset, opts) {
  const { repo, tag, folderId, poolId, visibility, c } = opts;
  const maxBytes = Math.min(
    DEFAULT_MAX_ASSET_BYTES,
    Number(deps.config && deps.config.maxUploadSize) > 0 ? Number(deps.config.maxUploadSize) : DEFAULT_MAX_ASSET_BYTES,
  );
  if (Number(asset.size || 0) > maxBytes) {
    return { ok: false, name: asset.name, error: `超过单文件上限（最大 ${(maxBytes / 1024 / 1024).toFixed(0)} MB）` };
  }
  const downloadUrl = asset.downloadUrl || '';
  if (!isAllowedGithubAssetUrl(downloadUrl)) {
    return { ok: false, name: asset.name, error: '仅允许拉取 GitHub 官方资产链接' };
  }
  const target = await resolveUploadTarget(deps, poolId || '');
  if (!target.ok) return { ok: false, name: asset.name, error: target.error };

  const token = await getGithubToken(deps);
  const fetchFn = (deps && typeof deps.fetch === 'function') ? deps.fetch : fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // Use API asset URL with token for private repos; public browser_download_url otherwise
    const useApiUrl = !!(token && asset.apiUrl && isAllowedGithubAssetUrl(asset.apiUrl));
    const reqUrl = useApiUrl ? asset.apiUrl : downloadUrl;
    const headers = {
      'User-Agent': 'RelayBox-GitHubPull/3.7.0',
      'Accept': useApiUrl ? 'application/octet-stream' : '*/*',
    };
    if (useApiUrl) headers['Authorization'] = `Bearer ${token}`;

    const remoteRes = await fetchFn(reqUrl, { headers, redirect: 'follow', signal: controller.signal });
    if (!remoteRes.ok) {
      try { if (remoteRes.body && typeof remoteRes.body.cancel === 'function') await remoteRes.body.cancel(); } catch {}
      return { ok: false, name: asset.name, error: `下载资产失败（HTTP ${remoteRes.status}）` };
    }

    const filename = safeName(asset.name || 'release-asset');
    const ext = extOf(filename);
    const mime = MIME[ext] || (asset.contentType || 'application/octet-stream').split(';')[0].trim();
    const id = newId();
    const storageKey = keyOf(id, filename);
    const headerLen = Number(remoteRes.headers.get('content-length') || asset.size || 0);
    if (headerLen > maxBytes) {
      try { if (remoteRes.body && typeof remoteRes.body.cancel === 'function') await remoteRes.body.cancel(); } catch {}
      return { ok: false, name: asset.name, error: `超过单文件上限（最大 ${(maxBytes / 1024 / 1024).toFixed(0)} MB）` };
    }

    let finalSize = headerLen;
    // Prefer direct stream write into built-in R2 Binding when length is known; else buffer safely
    const canDirectStreamR2 = !!(
      target.storage === 'r2' &&
      !target.poolId &&
      target.driver &&
      target.driver.proxySupported !== false &&
      remoteRes.body &&
      headerLen > 0
    );

    if (canDirectStreamR2) {
      await target.driver.put(storageKey, remoteRes.body, mime);
    } else {
      const ab = await remoteRes.arrayBuffer();
      if (ab.byteLength > maxBytes) {
        return { ok: false, name: asset.name, error: `超过单文件上限（最大 ${(maxBytes / 1024 / 1024).toFixed(0)} MB）` };
      }
      if (ab.byteLength <= 0) {
        return { ok: false, name: asset.name, error: '下载结果为空（0 字节）' };
      }
      finalSize = ab.byteLength;
      const bytes = new Uint8Array(ab);
      if (target.storage === 'r2' && target.driver.proxySupported === false && target.driver.presignEnabled) {
        const putUrl = await target.driver.presignedPutUrl(storageKey, { contentLength: bytes.byteLength, expiresIn: 300 });
        const putRes = await fetchFn(putUrl, { method: 'PUT', headers: { 'Content-Type': mime }, body: bytes });
        if (!putRes.ok) throw new Error(`presign PUT HTTP ${putRes.status}`);
      } else {
        await target.driver.put(storageKey, bytes, mime);
      }
    }

    const note = `GitHub ${repo}${tag ? ' ' + tag : ''}`.slice(0, 200);
    const created = await deps.meta.createFile({
      id,
      name: filename,
      size: finalSize,
      ext,
      kind: kindOf(ext),
      storage: target.storage,
      storageKey,
      folderId: folderId || null,
      visibility: visibility === 'private' ? 'private' : 'public',
      expiresAt: null,
      downloads: 0,
      uploadedAt: new Date().toISOString(),
      poolId: target.poolId || null,
      note,
    });
    if (c) await recordAudit(deps, c, 'gh_pull', filename, `${repo} ${tag || ''}`.trim());
    return { ok: true, file: created };
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    return { ok: false, name: asset.name, error: isTimeout ? '拉取超时' : ((e && e.message) || '拉取失败') };
  } finally {
    clearTimeout(timer);
  }
}

export async function runSingleGithubWatch(deps, watch, { c = null, force = false } = {}) {
  const now = Date.now();
  const rel = await fetchLatestRelease(deps, watch.repo);
  if (!rel.ok) {
    await deps.meta.updateGithubWatch(watch.id, { lastCheckedAt: now, lastError: rel.error });
    return { ok: false, error: rel.error };
  }
  if (!force && watch.lastTag && rel.tag === watch.lastTag) {
    await deps.meta.updateGithubWatch(watch.id, { lastCheckedAt: now, lastError: '' });
    return { ok: true, updated: false, tag: rel.tag, message: `已是最新 ${rel.tag}` };
  }
  const matcher = buildAssetMatcher(watch.assetPattern);
  const matched = rel.assets.filter((a) => matcher(a.name)).slice(0, MAX_ASSETS_PER_PULL);
  if (!matched.length) {
    const msg = `版本 ${rel.tag} 中无匹配「${watch.assetPattern || '*'}」的资产`;
    await deps.meta.updateGithubWatch(watch.id, { lastCheckedAt: now, lastError: msg });
    return { ok: false, error: msg, tag: rel.tag };
  }

  const pulledFiles = [];
  const errors = [];
  for (const a of matched) {
    const r = await pullSingleAsset(deps, a, {
      repo: watch.repo,
      tag: rel.tag,
      folderId: watch.folderId || null,
      poolId: watch.poolId || null,
      visibility: watch.visibility || 'public',
      c,
    });
    if (r.ok && r.file) pulledFiles.push(r.file);
    else errors.push(`${a.name}: ${r.error}`);
  }

  if (!pulledFiles.length) {
    const errTxt = errors.join('; ').slice(0, 200) || '拉取失败';
    await deps.meta.updateGithubWatch(watch.id, { lastCheckedAt: now, lastError: errTxt });
    return { ok: false, error: errTxt, tag: rel.tag };
  }

  // Optional: move previous release files pulled by this watch to Recycle Bin
  let replacedCount = 0;
  if (watch.replaceOld && Array.isArray(watch.lastFileIds) && watch.lastFileIds.length) {
    for (const oldId of watch.lastFileIds) {
      try {
        const oldItem = await deps.meta.getFile(oldId);
        if (oldItem && !oldItem.deletedAt) {
          await moveFileToTrash(deps, oldItem, c);
          replacedCount++;
        }
      } catch {}
    }
  }

  const nextIds = pulledFiles.map((f) => f.id);
  const updatedWatch = await deps.meta.updateGithubWatch(watch.id, {
    lastTag: rel.tag,
    lastFileIds: nextIds,
    lastCheckedAt: now,
    lastError: errors.length ? `部分失败：${errors.join('; ').slice(0, 160)}` : '',
  });

  // Notify via Telegram if enabled
  try {
    const tg = await getTelegramConfig(deps);
    if (tg && tg.enabled) {
      const names = pulledFiles.map((f) => `• ${escapeTgHtml(f.name)} (${fmtBytes(f.size)})`).join('\n');
      const msg = [
        `📦 <b>GitHub 新版本已自动拉取</b>`,
        `仓库：<b>${escapeTgHtml(watch.repo)}</b> (${escapeTgHtml(rel.tag)})`,
        names,
        replacedCount ? `旧版本：已将 ${replacedCount} 个旧文件移入回收站` : '',
      ].filter(Boolean).join('\n');
      await sendTelegramMessage(deps, msg);
    }
  } catch {}

  log('github watch pulled:', watch.repo, rel.tag, pulledFiles.length, 'files');
  return {
    ok: true,
    updated: true,
    tag: rel.tag,
    pulledCount: pulledFiles.length,
    replacedCount,
    errors,
    watch: updatedWatch,
    files: pulledFiles,
  };
}

/** Called from scheduled cleanupExpired() — checks up to 3 due watches per Cron tick. */
export async function runScheduledGithubWatches(deps) {
  if (!deps || !deps.meta || typeof deps.meta.listGithubWatches !== 'function') return;
  try {
    const watches = await deps.meta.listGithubWatches();
    const now = Date.now();
    const due = watches
      .filter((w) => w.enabled && (!w.lastCheckedAt || (now - new Date(w.lastCheckedAt).getTime()) >= WATCH_CHECK_INTERVAL_MS))
      .slice(0, MAX_WATCHES_PER_CRON);
    for (const w of due) {
      try {
        await runSingleGithubWatch(deps, w, { c: null, force: false });
      } catch (e) {
        log('scheduled github watch failed:', w.repo, e && e.message);
      }
    }
  } catch (e) {
    log('runScheduledGithubWatches error:', e && e.message);
  }
}

export function registerGithub(app) {
  app.get('/api/github/config', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const enc = await deps.meta.getSetting(SETTING_GITHUB_TOKEN_ENC);
    return c.json({ ok: true, hasToken: !!enc });
  });

  app.put('/api/github/config', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    if (body.clear === true || body.token === '') {
      await deps.meta.setSetting(SETTING_GITHUB_TOKEN_ENC, '');
      await recordAudit(deps, c, 'gh_config', 'GitHub Token', '已清除');
      return c.json({ ok: true, hasToken: false });
    }
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token || token.length < 10) return c.json({ ok: false, error: '请输入有效的 GitHub Token' }, 400);
    const enc = await encryptSecret(token, deps.config.uploadPassword);
    await deps.meta.setSetting(SETTING_GITHUB_TOKEN_ENC, enc);
    await recordAudit(deps, c, 'gh_config', 'GitHub Token', '已加密保存');
    return c.json({ ok: true, hasToken: true });
  });

  app.get('/api/github/release', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const repo = c.req.query('repo') || '';
    const rel = await fetchLatestRelease(deps, repo);
    if (!rel.ok) return c.json({ ok: false, error: rel.error }, rel.status || 400);
    return c.json(rel);
  });

  app.post('/api/github/pull', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const repo = parseRepoInput(body.repo);
    if (!repo) return c.json({ ok: false, error: 'GitHub 仓库格式不正确' }, 400);
    const tag = typeof body.tag === 'string' ? body.tag.trim().slice(0, 64) : '';
    const rawAssets = Array.isArray(body.assets) ? body.assets.slice(0, MAX_ASSETS_PER_PULL) : [];
    if (!rawAssets.length) return c.json({ ok: false, error: '请至少选择一个安装包资产' }, 400);
    const folderId = (typeof body.folderId === 'string' && body.folderId.trim()) ? body.folderId.trim() : null;
    if (folderId && !(await deps.meta.getFolder(folderId))) {
      return c.json({ ok: false, error: '目标文件夹不存在' }, 400);
    }
    const poolId = (typeof body.poolId === 'string' && body.poolId.trim()) ? body.poolId.trim() : null;
    const visibility = body.visibility === 'private' ? 'private' : 'public';

    const files = [];
    const errors = [];
    for (const a of rawAssets) {
      const r = await pullSingleAsset(deps, a, { repo, tag, folderId, poolId, visibility, c });
      if (r.ok && r.file) files.push(r.file);
      else errors.push(`${a.name || 'asset'}: ${r.error}`);
    }
    if (!files.length) return c.json({ ok: false, error: errors.join('；') || '拉取失败' }, 502);
    return c.json({ ok: true, count: files.length, files, errors });
  });

  app.get('/api/github/watches', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const [watches, enc] = await Promise.all([
      deps.meta.listGithubWatches(),
      deps.meta.getSetting(SETTING_GITHUB_TOKEN_ENC),
    ]);
    return c.json({ ok: true, watches, hasToken: !!enc });
  });

  app.post('/api/github/watches', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const repo = parseRepoInput(body.repo);
    if (!repo) return c.json({ ok: false, error: 'GitHub 仓库格式不正确（应为 owner/repo）' }, 400);
    const assetPattern = (typeof body.assetPattern === 'string' && body.assetPattern.trim())
      ? body.assetPattern.trim().slice(0, 160) : '*';
    const folderId = (typeof body.folderId === 'string' && body.folderId.trim()) ? body.folderId.trim() : null;
    if (folderId && !(await deps.meta.getFolder(folderId))) {
      return c.json({ ok: false, error: '目标文件夹不存在' }, 400);
    }
    const poolId = (typeof body.poolId === 'string' && body.poolId.trim()) ? body.poolId.trim() : null;
    const visibility = body.visibility === 'private' ? 'private' : 'public';
    const replaceOld = body.replaceOld === true;
    const enabled = body.enabled !== false;

    const created = await deps.meta.createGithubWatch({
      id: newId(),
      repo,
      assetPattern,
      folderId,
      poolId,
      visibility,
      replaceOld,
      enabled,
      createdAt: Date.now(),
    });
    await recordAudit(deps, c, 'gh_watch', repo, `pattern=${assetPattern}, replaceOld=${replaceOld}`);
    return c.json({ ok: true, watch: created });
  });

  app.put('/api/github/watches/:id', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const existing = await deps.meta.getGithubWatch(id);
    if (!existing) return c.json({ ok: false, error: '订阅不存在' }, 404);
    const body = await readJsonBody(c);
    const patch = {};
    if (body.repo !== undefined) {
      const repo = parseRepoInput(body.repo);
      if (!repo) return c.json({ ok: false, error: 'GitHub 仓库格式不正确' }, 400);
      patch.repo = repo;
    }
    if (body.assetPattern !== undefined) {
      patch.assetPattern = (typeof body.assetPattern === 'string' && body.assetPattern.trim())
        ? body.assetPattern.trim().slice(0, 160) : '*';
    }
    if (body.folderId !== undefined) {
      const fid = (typeof body.folderId === 'string' && body.folderId.trim()) ? body.folderId.trim() : null;
      if (fid && !(await deps.meta.getFolder(fid))) return c.json({ ok: false, error: '目标文件夹不存在' }, 400);
      patch.folderId = fid;
    }
    if (body.poolId !== undefined) {
      patch.poolId = (typeof body.poolId === 'string' && body.poolId.trim()) ? body.poolId.trim() : null;
    }
    if (body.visibility !== undefined) patch.visibility = body.visibility === 'private' ? 'private' : 'public';
    if (typeof body.replaceOld === 'boolean') patch.replaceOld = body.replaceOld;
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    const updated = await deps.meta.updateGithubWatch(id, patch);
    return c.json({ ok: true, watch: updated });
  });

  app.delete('/api/github/watches/:id', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const existing = await deps.meta.getGithubWatch(id);
    if (!existing) return c.json({ ok: false, error: '订阅不存在' }, 404);
    await deps.meta.deleteGithubWatch(id);
    await recordAudit(deps, c, 'gh_watch', existing.repo, '删除自动追更订阅');
    return c.json({ ok: true });
  });

  app.post('/api/github/watches/:id/check', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const watch = await deps.meta.getGithubWatch(id);
    if (!watch) return c.json({ ok: false, error: '订阅不存在' }, 404);
    const body = await readJsonBody(c);
    const res = await runSingleGithubWatch(deps, watch, { c, force: body.force === true });
    if (!res.ok) return c.json({ ok: false, error: res.error, tag: res.tag || '' }, 502);
    return c.json(res);
  });
}
