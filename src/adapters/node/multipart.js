// RelayBox Node adapter — busboy multipart parser (VPS-only upload path).
// Streams the file part straight to a temp file (never into memory), exactly
// like v2.8.4's handleUpload. The password field may arrive AFTER the file
// part, so the whole body is consumed first and auth is checked by the route
// afterwards; on auth failure the route deletes the temp file.
//
// IMPORTANT: this reads `c.env.incoming` (the raw Node request). That is safe
// because @hono/node-server builds its Request lazily — the body stream is
// only touched when a handler calls c.req.json()/arrayBuffer()/etc., and the
// upload route never does that before this parser runs.

import busboy from 'busboy';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeName, extOf } from '../../core/lib/util.js';

/**
 * Parse a multipart/form-data upload.
 * Returns { fields, file, failed, tmpPath } where file is
 * { tmpPath, name, size, ext, id } or null when no file part arrived.
 * `failed` means the stream errored (route answers 400 '上传失败').
 */
export async function parseMultipartUpload(c, { maxFileSize, filesDir }) {
  const incoming = c.env && c.env.incoming;
  if (!incoming) throw new Error('no raw incoming request available for multipart parsing');
  return new Promise((resolve) => {
    let bb;
    try {
      bb = busboy({ headers: incoming.headers, limits: { files: 1, fileSize: maxFileSize } });
    } catch (e) {
      resolve({ fields: {}, file: null, failed: true, tmpPath: null });
      return;
    }
    const fields = {};
    let tmpPath = null;
    let saved = null;
    let failed = false;
    let responded = false;
    let bbFinished = false;
    let fileFinished = true; // no file part yet: treat as finished

    function finish() {
      if (responded || !bbFinished || !fileFinished) return;
      responded = true;
      resolve({ fields, file: saved, failed, tmpPath });
    }

    bb.on('field', (name, val) => {
      fields[name] = String(val || '');
    });
    bb.on('file', (name, file, info) => {
      if (name !== 'file') { file.resume(); return; }
      fileFinished = false;
      const filename = safeName(info.filename);
      const ext = extOf(filename);
      const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      tmpPath = path.join(filesDir, `.tmp-${id}`);
      const ws = fs.createWriteStream(tmpPath);
      let size = 0;
      let limited = false;
      file.on('data', (chunk) => { size += chunk.length; });
      file.on('limit', () => { limited = true; });
      file.on('error', () => { failed = true; fileFinished = true; finish(); });
      ws.on('error', () => { failed = true; fileFinished = true; finish(); });
      file.pipe(ws);
      ws.on('finish', () => {
        if (!limited) saved = { tmpPath, name: filename, size, ext, id };
        fileFinished = true;
        finish();
      });
    });
    bb.on('error', () => { failed = true; bbFinished = true; fileFinished = true; finish(); });
    bb.on('finish', () => { bbFinished = true; finish(); });
    incoming.pipe(bb);
  });
}
