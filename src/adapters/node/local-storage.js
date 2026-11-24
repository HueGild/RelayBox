// RelayBox Node adapter — LocalStorage (VPS target).
// Implements the StorageStore contract on the local disk (files/ flat layout,
// thumbs/ for thumbnails). Keys are the v2.8.4 flat `${id}_${name}` format;
// `thumbs/<id>.jpg` keys map to the thumbs directory.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { MIME } from '../../core/lib/util.js';

export class LocalStorage {
  constructor(filesDir, thumbsDir) {
    this.filesDir = filesDir;
    this.thumbsDir = thumbsDir;
    fs.mkdirSync(filesDir, { recursive: true });
    fs.mkdirSync(thumbsDir, { recursive: true });
  }

  get enabled() {
    return true;
  }

  _keyPath(key) {
    if (key.startsWith('thumbs/')) return path.join(this.thumbsDir, key.slice('thumbs/'.length));
    return path.join(this.filesDir, key);
  }

  /** Small-file / thumbnail / assembled-chunk put. Body: Buffer, Uint8Array, string or stream. */
  async put(key, body, contentType) {
    const p = this._keyPath(key);
    if (body && typeof body.pipe === 'function') {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(p);
        ws.on('error', reject);
        ws.on('finish', resolve);
        body.pipe(ws);
      });
      return;
    }
    fs.writeFileSync(p, body);
  }

  /** Copy a local file to a key (contract parity with R2Storage.putFile). */
  async putFile(key, filePath, contentType) {
    fs.copyFileSync(filePath, this._keyPath(key));
  }

  /**
   * Download: returns a Web Response (200 full, 206 ranged, 416 unsatisfiable)
   * or null when the object is missing.
   * opts: { start, end, contentType, disposition } — start/end from a Range header.
   */
  async get(key, opts = {}) {
    const p = this._keyPath(key);
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      return null;
    }
    const mime = opts.contentType || MIME['.' + key.split('.').pop().toLowerCase()] || 'application/octet-stream';
    const baseHeaders = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
    };
    if (opts.disposition) baseHeaders['Content-Disposition'] = opts.disposition;
    let { start, end } = opts;
    if (start !== undefined || end !== undefined) {
      // Suffix range (bytes=-N): start from size-N, same as v2.8.4.
      if ((start === null || start === undefined) && end !== null && end !== undefined) start = Math.max(0, stat.size - end);
      if (start === null || start === undefined) start = 0;
      if (end === null || end === undefined || end >= stat.size) end = stat.size - 1;
      if (start >= stat.size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
      }
      const headers = {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': String(end - start + 1),
      };
      const stream = Readable.toWeb(fs.createReadStream(p, { start, end }));
      return new Response(stream, { status: 206, headers });
    }
    const stream = Readable.toWeb(fs.createReadStream(p));
    return new Response(stream, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(stat.size) } });
  }

  async head(key) {
    try {
      const stat = fs.statSync(this._keyPath(key));
      return { size: stat.size };
    } catch {
      return null;
    }
  }

  async delete(key) {
    try { fs.unlinkSync(this._keyPath(key)); } catch { /* missing is fine */ }
  }

  async copy(srcKey, dstKey) {
    fs.copyFileSync(this._keyPath(srcKey), this._keyPath(dstKey));
  }

  async rename(srcKey, dstKey) {
    fs.renameSync(this._keyPath(srcKey), this._keyPath(dstKey));
  }

  // Local storage has no presigned URLs / multipart (those are R2-only).
  async presignedPutUrl() {
    throw new Error('presigned URLs are not supported by LocalStorage');
  }
  async presignedGetUrl() {
    throw new Error('presigned URLs are not supported by LocalStorage');
  }
  async createMultipartUpload() {
    throw new Error('multipart upload is not supported by LocalStorage');
  }
  async presignedPartUrl() {
    throw new Error('multipart upload is not supported by LocalStorage');
  }
  async completeMultipartUpload() {
    throw new Error('multipart upload is not supported by LocalStorage');
  }
  async abortMultipartUpload() {
    throw new Error('multipart upload is not supported by LocalStorage');
  }

  // ---- thumbnails (thumbs/<id>.jpg) ----
  async putThumb(id, buffer) {
    fs.writeFileSync(path.join(this.thumbsDir, id + '.jpg'), buffer);
  }
  async getThumb(id) {
    try {
      return fs.readFileSync(path.join(this.thumbsDir, id + '.jpg'));
    } catch {
      return null;
    }
  }
  async deleteThumb(id) {
    try { fs.unlinkSync(path.join(this.thumbsDir, id + '.jpg')); } catch { /* missing is fine */ }
  }

  // ---- temp-file helpers (multipart upload + chunk assembly) ----
  /** Full path for a temp file inside files/ (e.g. `.tmp-<id>`). */
  tempFilePath(name) {
    return path.join(this.filesDir, name);
  }
  /** Move an assembled/temp file to its final key (fs.rename, no copy). */
  async importTempFile(tmpPath, key) {
    fs.renameSync(tmpPath, this._keyPath(key));
  }

  /** Delete a temp file (multipart upload rejected after receipt). */
  async removeTempFile(tmpPath) {
    try { fs.unlinkSync(tmpPath); } catch { /* missing is fine */ }
  }

  // ---- disk space (v2.8.4 freeBytes / diskTotalBytes) ----
  freeBytes() {
    try {
      const s = fs.statfsSync(this.filesDir);
      return s.bavail * s.bsize;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }
  totalBytes() {
    try {
      const s = fs.statfsSync(this.filesDir);
      return s.blocks * s.bsize;
    } catch {
      return 0;
    }
  }
}
