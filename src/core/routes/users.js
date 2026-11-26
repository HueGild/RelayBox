// RelayBox core routes — sub-accounts & temporary test accounts management (v3.8.0).
// All routes strictly require main admin (isAuthed). Pure Web APIs, zero Node deps.

import { readJsonBody, safeName, newId, log } from '../lib/util.js';
import { isAuthed } from '../lib/auth.js';
import { hashPassword } from '../lib/crypto.js';
import { recordAudit } from '../lib/audit.js';

const USERNAME_RE = /^[A-Za-z0-9_-]{2,32}$/;

function parseExpiresInput(body) {
  if (!body || typeof body !== 'object') return { provided: false, value: null };
  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null || body.expiresAt === '' || body.expiresAt === 0) {
      return { provided: true, value: null };
    }
    if (typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt) && body.expiresAt > 0) {
      return { provided: true, value: Math.floor(body.expiresAt) };
    }
    const ms = new Date(body.expiresAt).getTime();
    if (Number.isFinite(ms) && ms > 0) return { provided: true, value: Math.floor(ms) };
    return { provided: true, value: null };
  }
  if (body.expiresHours !== undefined) {
    const h = Number(body.expiresHours);
    if (!Number.isFinite(h) || h <= 0) return { provided: true, value: null };
    const clamped = Math.min(87600, h);
    return { provided: true, value: Math.floor(Date.now() + clamped * 3600 * 1000) };
  }
  return { provided: false, value: null };
}

function userView(u, usedBytes = 0, folderMap = null) {
  const rootFolder = folderMap ? folderMap.get(u.rootFolderId) : null;
  const now = Date.now();
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName || '',
    role: u.role === 'guest' ? 'guest' : 'user',
    rootFolderId: u.rootFolderId,
    rootFolderName: rootFolder ? rootFolder.name : '',
    quotaBytes: Number(u.quotaBytes) > 0 ? Number(u.quotaBytes) : 0,
    usedBytes: Number(usedBytes) || 0,
    canUpload: !!u.canUpload,
    canDelete: !!u.canDelete,
    canShare: !!u.canShare,
    enabled: !!u.enabled,
    expiresAt: u.expiresAt || null,
    expired: !!(u.expiresAt && u.expiresAt <= now),
    note: u.note || '',
    createdAt: u.createdAt || 0,
    lastLoginAt: u.lastLoginAt || null,
  };
}

export function registerUsers(app) {
  // List all sub-accounts / test accounts with aggregated storage usage and root folder name.
  app.get('/api/users', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录管理员账号' }, 401);
    const [users, usageMap, folders] = await Promise.all([
      deps.meta.listUsers(),
      deps.meta.getUserUsageMap(),
      deps.meta.listFolders(),
    ]);
    const folderMap = new Map((folders || []).map((f) => [f.id, f]));
    const list = (users || []).map((u) => userView(u, usageMap.get(u.id) || 0, folderMap));
    return c.json({ ok: true, users: list });
  });

  // Create a new sub-account or temporary test account.
  app.post('/api/users', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录管理员账号' }, 401);
    const body = await readJsonBody(c);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!USERNAME_RE.test(username)) {
      return c.json({ ok: false, error: '用户名需为 2–32 位字母、数字、下划线或短横线' }, 400);
    }
    if (username.toLowerCase() === 'admin') {
      return c.json({ ok: false, error: '用户名不能为保留名称 admin' }, 400);
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 4 || password.length > 128) {
      return c.json({ ok: false, error: '密码长度需在 4–128 位之间' }, 400);
    }
    const existing = await deps.meta.getUserByUsername(username);
    if (existing) {
      return c.json({ ok: false, error: '该用户名已存在' }, 409);
    }

    const role = body.role === 'guest' ? 'guest' : 'user';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 64) : '';
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
    const quotaBytes = (Number.isFinite(Number(body.quotaBytes)) && Number(body.quotaBytes) > 0)
      ? Math.floor(Number(body.quotaBytes))
      : 0;
    const canUpload = body.canUpload !== undefined ? !!body.canUpload : true;
    const canDelete = body.canDelete !== undefined ? !!body.canDelete : true;
    const canShare = body.canShare !== undefined ? !!body.canShare : true;
    const enabled = body.enabled !== undefined ? !!body.enabled : true;
    const expParsed = parseExpiresInput(body);
    const expiresAt = expParsed.provided ? expParsed.value : null;

    let rootFolderId = (typeof body.rootFolderId === 'string' && body.rootFolderId.trim()) ? body.rootFolderId.trim() : '';
    let createdFolder = null;
    const folders = await deps.meta.listFolders();
    const folderMap = new Map((folders || []).map((f) => [f.id, f]));

    if (body.autoCreateFolder) {
      const parentId = (typeof body.parentFolderId === 'string' && body.parentFolderId.trim())
        ? body.parentFolderId.trim()
        : null;
      if (parentId && !folderMap.has(parentId)) {
        return c.json({ ok: false, error: '父文件夹不存在' }, 400);
      }
      const rawFolderName = (typeof body.folderName === 'string' && body.folderName.trim())
        ? body.folderName.trim()
        : (displayName || username);
      let cleanFolder = safeName(rawFolderName);
      if (!cleanFolder || cleanFolder === 'file') cleanFolder = username;
      let candidate = cleanFolder;
      let seq = 2;
      while (folders.some((f) => (f.parentId || null) === parentId && f.name === candidate)) {
        candidate = `${cleanFolder}-${seq++}`;
      }
      createdFolder = await deps.meta.createFolder({
        id: newId(),
        name: candidate,
        parentId,
        createdAt: new Date().toISOString(),
      });
      rootFolderId = createdFolder.id;
      folderMap.set(createdFolder.id, createdFolder);
    } else {
      if (!rootFolderId || !folderMap.has(rootFolderId)) {
        return c.json({ ok: false, error: '请指定有效的绑定根目录，或开启自动新建目录' }, 400);
      }
    }

    const passwordHash = await hashPassword(password);
    const user = await deps.meta.createUser({
      id: newId(),
      username,
      displayName,
      passwordHash,
      role,
      rootFolderId,
      quotaBytes,
      canUpload,
      canDelete,
      canShare,
      enabled,
      expiresAt,
      note,
      createdAt: Date.now(),
    });
    await recordAudit(deps, c, 'user_create', username, `role=${role}, folder=${rootFolderId}`);
    log('user created:', username, role);
    return c.json({
      ok: true,
      user: userView(user, 0, folderMap),
      ...(createdFolder ? { folder: createdFolder } : {}),
    });
  });

  // Atomic partial update of a sub-account (revokes sessions on disable or password reset).
  app.put('/api/users/:id', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录管理员账号' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const cur = await deps.meta.getUser(id);
    if (!cur) return c.json({ ok: false, error: '账号不存在' }, 404);
    const body = await readJsonBody(c);
    const patch = {};
    let shouldRevokeSessions = false;

    if (typeof body.displayName === 'string') patch.displayName = body.displayName.trim().slice(0, 64);
    if (body.role === 'user' || body.role === 'guest') patch.role = body.role;
    if (body.quotaBytes !== undefined) {
      const q = Number(body.quotaBytes);
      patch.quotaBytes = (Number.isFinite(q) && q > 0) ? Math.floor(q) : 0;
    }
    if (typeof body.canUpload === 'boolean') patch.canUpload = body.canUpload;
    if (typeof body.canDelete === 'boolean') patch.canDelete = body.canDelete;
    if (typeof body.canShare === 'boolean') patch.canShare = body.canShare;
    if (typeof body.enabled === 'boolean') {
      patch.enabled = body.enabled;
      if (body.enabled === false) shouldRevokeSessions = true;
    }
    if (typeof body.note === 'string') patch.note = body.note.trim().slice(0, 200);
    if (typeof body.rootFolderId === 'string' && body.rootFolderId.trim()) {
      const rf = await deps.meta.getFolder(body.rootFolderId.trim());
      if (!rf) return c.json({ ok: false, error: '指定的根目录不存在' }, 400);
      patch.rootFolderId = rf.id;
    }
    const expParsed = parseExpiresInput(body);
    if (expParsed.provided) {
      patch.expiresAt = expParsed.value;
      if (expParsed.value && expParsed.value <= Date.now()) shouldRevokeSessions = true;
    }
    if (typeof body.password === 'string' && body.password.length > 0) {
      if (body.password.length < 4 || body.password.length > 128) {
        return c.json({ ok: false, error: '新密码长度需在 4–128 位之间' }, 400);
      }
      patch.passwordHash = await hashPassword(body.password);
      shouldRevokeSessions = true;
    }

    const updated = await deps.meta.updateUser(id, patch);
    if (!updated) return c.json({ ok: false, error: '账号不存在' }, 404);
    if (shouldRevokeSessions) {
      await deps.meta.deleteUserSessions(id);
    }
    const [usedBytes, folders] = await Promise.all([
      deps.meta.getUserUsedBytes(id),
      deps.meta.listFolders(),
    ]);
    const folderMap = new Map((folders || []).map((f) => [f.id, f]));
    await recordAudit(deps, c, 'user_update', updated.username, Object.keys(patch).filter((k) => k !== 'passwordHash').join(',') + (patch.passwordHash ? ',reset_pw' : ''));
    return c.json({ ok: true, user: userView(updated, usedBytes, folderMap) });
  });

  // Delete a sub-account and revoke all its sessions (optionally trash its uploaded files).
  app.delete('/api/users/:id', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录管理员账号' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const cur = await deps.meta.getUser(id);
    if (!cur) return c.json({ ok: false, error: '账号不存在' }, 404);
    const trashFiles = c.req.query('trashFiles') === 'true' || c.req.query('trashFiles') === '1';
    let trashedCount = 0;
    if (trashFiles && typeof deps.meta.trashFilesByOwner === 'function') {
      trashedCount = await deps.meta.trashFilesByOwner(id, Date.now());
    }
    await deps.meta.deleteUserSessions(id);
    await deps.meta.deleteUser(id);
    await recordAudit(deps, c, 'user_delete', cur.username, trashFiles ? `trashFiles=${trashedCount}` : 'keepFiles');
    log('user deleted:', cur.username);
    return c.json({ ok: true, trashedCount });
  });

  // Force-kick all active sessions of a sub-account.
  app.post('/api/users/:id/kick', async (c) => {
    const deps = c.get('deps');
    if (!(await isAuthed(c, deps))) return c.json({ ok: false, error: '请先登录管理员账号' }, 401);
    const id = decodeURIComponent(c.req.param('id'));
    const cur = await deps.meta.getUser(id);
    if (!cur) return c.json({ ok: false, error: '账号不存在' }, 404);
    const kicked = await deps.meta.deleteUserSessions(id);
    await recordAudit(deps, c, 'user_kick', cur.username, `sessions=${kicked}`);
    return c.json({ ok: true, kicked });
  });
}
