// RelayBox core routes — Media Link Parse & Save + Telegram Bot Auto-Save Webhook (v3.9.0).
// Pure Web APIs, zero Node built-in deps.

import { readJsonBody, log } from '../lib/util.js';
import { isAuthed, clientMeta } from '../lib/auth.js';
import { recordAudit } from '../lib/audit.js';
import { decryptSecret } from '../lib/crypto.js';
import { getTelegramConfig, escapeTgHtml, fmtBytes } from '../lib/notify.js';
import {
  extractShareUrl,
  getMediaParserConfig,
  getMediaParserPublicConfig,
  saveMediaParserConfig,
  parseMediaLink,
  downloadAndSaveMedia,
} from '../lib/media-parser.js';

function constantTimeStrEqual(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa || sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

async function tgApiCall(fetchFn, apiBase, botToken, method, payload) {
  const res = await fetchFn(`${apiBase}/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
}

export function registerMedia(app) {
  // Read parser & Telegram webhook config (admin-only)
  app.get('/api/media/config', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const origin = new URL(c.req.url).origin;
    const config = await getMediaParserPublicConfig(deps, origin);
    return c.json({ ok: true, config });
  });

  // Update parser & Telegram webhook config (admin-only)
  app.put('/api/media/config', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const saved = await saveMediaParserConfig(deps, body);
    if (!saved.ok) return c.json({ ok: false, error: saved.error }, 400);
    await recordAudit(deps, c, 'media_config', 'media_parser', `webhook=${saved.config.tgWebhookEnabled}`);
    const origin = new URL(c.req.url).origin;
    return c.json({ ok: true, config: await getMediaParserPublicConfig(deps, origin) });
  });

  // One-click register Telegram Bot Webhook (admin-only)
  app.post('/api/media/tg-webhook/register', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const tgCfg = await getTelegramConfig(deps);
    if (!tgCfg.botTokenEnc) {
      return c.json({ ok: false, error: '请先在「Telegram 推送」中配置 Bot Token' }, 400);
    }
    let botToken;
    try { botToken = await decryptSecret(tgCfg.botTokenEnc, deps.config.uploadPassword); }
    catch { return c.json({ ok: false, error: 'Bot Token 解密失败，请重新保存' }, 400); }

    // Ensure webhook secret exists and webhook is enabled
    const saved = await saveMediaParserConfig(deps, { tgWebhookEnabled: true });
    if (!saved.ok) return c.json({ ok: false, error: saved.error }, 400);
    const origin = new URL(c.req.url).origin;
    const webhookUrl = `${origin}/api/tg/webhook`;
    const fetchFn = deps.fetch || fetch;
    const out = await tgApiCall(fetchFn, tgCfg.apiBase, botToken, 'setWebhook', {
      url: webhookUrl,
      secret_token: saved.config.tgWebhookSecret,
      allowed_updates: ['message', 'channel_post'],
    });
    if (!out || !out.ok) {
      return c.json({ ok: false, error: '注册 Webhook 失败：' + ((out && out.description) || '未知错误') }, 502);
    }
    await recordAudit(deps, c, 'tg_webhook_register', webhookUrl, 'ok');
    return c.json({ ok: true, webhookUrl });
  });

  // Web UI: Parse Douyin / short-video share text and save directly to storage pool (admin-only)
  app.post('/api/media/parse-save', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录' }, 401);
    const body = await readJsonBody(c);
    const rawText = String(body.text || body.url || '').trim();
    if (!rawText) return c.json({ ok: false, error: '请粘贴抖音分享口令或视频链接' }, 400);

    const fetchFn = deps.fetch || fetch;
    const parsed = await parseMediaLink(deps, rawText, fetchFn);
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, parsed.status || 502);

    const cfg = await getMediaParserConfig(deps);
    const { uploadIp, uploadGeo } = clientMeta(c, deps);
    const saved = await downloadAndSaveMedia(deps, {
      mediaUrl: parsed.mediaUrl,
      customName: body.name || '',
      title: parsed.title,
      author: parsed.author,
      platform: parsed.platform,
      shareUrl: parsed.shareUrl,
      headers: parsed.headers,
      folderId: body.folderId || null,
      poolId: body.poolId || '',
      visibility: body.visibility === 'public' ? 'public' : 'private',
      expires: body.expires || '0',
      maxBytes: cfg.maxBytes,
      uploadIp,
      uploadGeo,
      fetchFn,
    });
    if (!saved.ok) return c.json({ ok: false, error: saved.error }, saved.status || 502);

    await recordAudit(deps, c, 'media_save', saved.file.name, `${parsed.platform}/${parsed.engine} (${saved.file.size} B)`);
    log('media saved:', saved.file.name, parsed.platform, parsed.engine);
    return c.json({
      ok: true,
      file: saved.file,
      parsed: {
        platform: parsed.platform,
        title: parsed.title,
        author: parsed.author,
        engine: parsed.engine,
      },
    });
  });

  // Telegram Bot Webhook: send a Douyin share link -> auto-parse & save to RelayBox!
  app.post('/api/tg/webhook', async (c) => {
    const deps = c.get('deps');
    const cfg = await getMediaParserConfig(deps);
    if (!cfg.tgWebhookEnabled || !cfg.tgWebhookSecret) {
      return c.json({ ok: false, error: 'webhook disabled' }, 403);
    }
    const headerSecret = c.req.header('x-telegram-bot-api-secret-token') || '';
    if (!constantTimeStrEqual(headerSecret, cfg.tgWebhookSecret)) {
      return c.json({ ok: false, error: 'invalid secret token' }, 403);
    }

    const update = await readJsonBody(c);
    const msg = update && (update.message || update.channel_post);
    if (!msg || !msg.chat || msg.chat.id === undefined) {
      return c.json({ ok: true, ignored: 'no_message' });
    }
    const chatId = String(msg.chat.id);
    const text = String(msg.text || msg.caption || '').trim();
    if (!text) return c.json({ ok: true, ignored: 'empty_text' });

    const tgCfg = await getTelegramConfig(deps);
    const allowedRaw = cfg.tgAllowedChats || tgCfg.chatId || '';
    const allowedSet = new Set(allowedRaw.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean));
    const isAllowed = allowedSet.size > 0 && allowedSet.has(chatId);

    // /start or /id helper: replies with current Chat ID & whitelist status for instant troubleshooting
    if (/^\/(?:start|id)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
      let tok = '';
      if (tgCfg.botTokenEnc) {
        try { tok = await decryptSecret(tgCfg.botTokenEnc, deps.config.uploadPassword); } catch {}
      }
      if (tok) {
        const fetchFn = deps.fetch || fetch;
        const chatType = (msg.chat && msg.chat.type) || 'unknown';
        const info = [
          '🤖 <b>RelayBox 自动存视频助手</b>',
          `当前 Chat ID：<code>${escapeTgHtml(chatId)}</code>（${escapeTgHtml(chatType)}）`,
          `白名单状态：${isAllowed ? '✅ 已允许（直接发抖音/短视频分享口令即可自动转存）' : '⚠️ 未在白名单中，请将上方 Chat ID 填入 RelayBox「允许的 Chat ID 白名单」并保存'}`,
        ].join('\n');
        await tgApiCall(fetchFn, tgCfg.apiBase, tok, 'sendMessage', {
          chat_id: chatId,
          text: info,
          parse_mode: 'HTML',
          reply_to_message_id: msg.message_id,
        }).catch(() => {});
      }
      return c.json({ ok: true, command: 'id', chatId, allowed: isAllowed });
    }

    if (!isAllowed) {
      return c.json({ ok: true, ignored: 'chat_not_allowed' });
    }

    const shareUrl = extractShareUrl(text);
    if (!shareUrl) return c.json({ ok: true, ignored: 'no_url' });

    let botToken = '';
    if (tgCfg.botTokenEnc) {
      try { botToken = await decryptSecret(tgCfg.botTokenEnc, deps.config.uploadPassword); } catch {}
    }
    const fetchFn = deps.fetch || fetch;
    const origin = new URL(c.req.url).origin;
    const replyTo = msg.message_id;

    const work = (async () => {
      let statusMsgId = null;
      if (botToken) {
        const sent = await tgApiCall(fetchFn, tgCfg.apiBase, botToken, 'sendMessage', {
          chat_id: chatId,
          text: '⏳ 正在解析并转存视频到 RelayBox…',
          reply_to_message_id: replyTo,
        }).catch(() => null);
        if (sent && sent.ok && sent.result) statusMsgId = sent.result.message_id;
      }

      const replyUpdate = async (htmlText) => {
        if (!botToken) return;
        if (statusMsgId) {
          await tgApiCall(fetchFn, tgCfg.apiBase, botToken, 'editMessageText', {
            chat_id: chatId,
            message_id: statusMsgId,
            text: htmlText,
            parse_mode: 'HTML',
            disable_web_page_preview: false,
          }).catch(() => {});
        } else {
          await tgApiCall(fetchFn, tgCfg.apiBase, botToken, 'sendMessage', {
            chat_id: chatId,
            text: htmlText,
            parse_mode: 'HTML',
            reply_to_message_id: replyTo,
          }).catch(() => {});
        }
      };

      const parsed = await parseMediaLink(deps, text, fetchFn);
      if (!parsed.ok) {
        await replyUpdate(`❌ <b>解析失败</b>\n${escapeTgHtml(parsed.error)}`);
        return;
      }

      const saved = await downloadAndSaveMedia(deps, {
        mediaUrl: parsed.mediaUrl,
        title: parsed.title,
        author: parsed.author,
        platform: parsed.platform,
        shareUrl: parsed.shareUrl,
        headers: parsed.headers,
        folderId: cfg.tgFolderId || null,
        poolId: cfg.tgPoolId || '',
        visibility: cfg.tgVisibility,
        expires: '0',
        maxBytes: cfg.maxBytes,
        fetchFn,
      });
      if (!saved.ok) {
        await replyUpdate(`❌ <b>转存失败</b>\n${escapeTgHtml(saved.error)}`);
        return;
      }

      await recordAudit(deps, null, 'tg_media_save', saved.file.name, `chat=${chatId} ${parsed.platform}/${parsed.engine}`);
      const fileUrl = `${origin}/f/${saved.file.id}`;
      const lines = [
        '✅ <b>已转存到 RelayBox</b>',
        `文件：<code>${escapeTgHtml(saved.file.name)}</code>`,
        `大小：${fmtBytes(saved.file.size)} · 可见性：${saved.file.visibility === 'public' ? '公开' : '私密'}`,
        `直链：<a href="${escapeTgHtml(fileUrl)}">${escapeTgHtml(fileUrl)}</a>`,
      ];
      await replyUpdate(lines.join('\n'));
    })();

    try {
      if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
        c.executionCtx.waitUntil(work);
        return c.json({ ok: true, queued: true });
      }
    } catch {}
    await work;
    return c.json({ ok: true, processed: true });
  });
}
