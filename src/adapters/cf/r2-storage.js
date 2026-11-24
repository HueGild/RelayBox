// RelayBox Cloudflare adapter — R2Storage (Workers target).
// Implements the StorageStore contract against Cloudflare R2.
//
// Adaptive dual transfer modes (v3.1.6):
// - 'presign': 302 redirect to aws4fetch presigned URL (requires R2 S3 secrets + CORS).
// - 'proxy':   zero-copy streaming through native env.R2 Binding with full HTTP Range
//              (200/206/416) & Cache-Control support (zero S3 secrets, zero CORS).
// When S3 secrets are absent, get() automatically falls back to 'proxy'.

import { AwsClient } from 'aws4fetch';
import { MIME, R2_FREE_BYTES } from '../../core/lib/util.js';

const THUMB_PREFIX = 'thumbs/';
const CHUNK_TMP_PREFIX = 'chunks/';

/** R2 S3 endpoint host for presigned URLs. */
function s3Host(accountId) {
  return `${accountId}.r2.cloudflarestorage.com`;
}

/** Build the S3 URL for a key, encoding each path segment (keys may hold CJK). */
function s3Url(accountId, bucket, key) {
  const encoded = String(key).split('/').map(encodeURIComponent).join('/');
  return `https://${s3Host(accountId)}/${bucket}/${encoded}`;
}

export class R2Storage {
  constructor(opts = {}) {
    this.binding = opts.binding || null;
    this.bucket = opts.bucket || '';
    this.accountId = opts.accountId || '';
    this.accessKeyId = opts.accessKeyId || '';
    this.secretAccessKey = opts.secretAccessKey || '';
    this._aws = null;
  }

  get enabled() {
    return !!this.binding;
  }

  /** Whether S3 credentials + bucket name are present for presigned URLs. */
  get presignEnabled() {
    return !!(this.binding && this.accessKeyId && this.secretAccessKey && this.accountId && this.bucket);
  }

  /** Whether native R2 Binding streaming proxy mode is supported. */
  get proxySupported() {
    return !!this.binding;
  }

  /** Lazily build the aws4fetch client; throws a clear error when secrets are missing. */
  _awsClient() {
    if (this._aws) return this._aws;
    if (!this.accessKeyId || !this.secretAccessKey || !this.accountId || !this.bucket) {
      const e = new Error('R2_S3_CREDENTIALS_MISSING');
      e.code = 'R2_S3_CREDENTIALS_MISSING';
      throw e;
    }
    this._aws = new AwsClient({
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
    return this._aws;
  }

  _needBinding() {
    if (!this.binding) {
      const e = new Error('R2_NOT_CONFIGURED');
      e.code = 'R2_NOT_CONFIGURED';
      throw e;
    }
  }

  async _presign(method, key, { expiresIn, query = {} } = {}) {
    const client = this._awsClient();
    const url = new URL(s3Url(this.accountId, this.bucket, key));
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    url.searchParams.set('X-Amz-Expires', String(expiresIn || 86400));
    const signed = await client.sign(url, { method, aws: { signQuery: true } });
    return signed.url;
  }

  // ---- blob ops (R2 Binding) ----

  async put(key, body, contentType) {
    this._needBinding();
    await this.binding.put(key, body, {
      httpMetadata: { contentType: contentType || 'application/octet-stream' },
    });
  }

  /** Stream a local file to R2 (Node-only path; on CF there is no local file). */
  async putFile() {
    throw new Error('putFile is not supported on Cloudflare Workers (no local disk)');
  }

  /**
   * Direct streaming download via R2 Binding (zero-copy ReadableStream, full Range 206/416).
   * opts: { start, end, contentType, disposition, cacheControl }
   */
  async getStream(key, opts = {}) {
    this._needBinding();
    const hasRange = opts.start !== undefined || opts.end !== undefined;
    const baseHeaders = {
      'Content-Type': opts.contentType || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    };
    if (opts.disposition) baseHeaders['Content-Disposition'] = opts.disposition;
    if (opts.cacheControl) baseHeaders['Cache-Control'] = opts.cacheControl;

    if (hasRange) {
      const head = await this.binding.head(key);
      if (!head) return null;
      const totalSize = head.size;
      if (totalSize === 0) {
        return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */0' } });
      }
      let s = opts.start;
      let e = opts.end;
      if ((s === null || s === undefined) && e !== null && e !== undefined) {
        if (e <= 0) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${totalSize}` } });
        }
        s = Math.max(0, totalSize - e);
        e = totalSize - 1;
      } else {
        if (s === null || s === undefined) s = 0;
        if (e === null || e === undefined || e >= totalSize) e = totalSize - 1;
      }
      if (s < 0 || s >= totalSize || s > e) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${totalSize}` } });
      }
      const len = e - s + 1;
      const obj = await this.binding.get(key, { range: { offset: s, length: len } });
      if (!obj) return null;
      const headers = {
        ...baseHeaders,
        'Content-Range': `bytes ${s}-${e}/${totalSize}`,
        'Content-Length': String(len),
      };
      if (obj.httpEtag) headers['ETag'] = obj.httpEtag;
      return new Response(obj.body, { status: 206, headers });
    }

    const obj = await this.binding.get(key);
    if (!obj) return null;
    const headers = {
      ...baseHeaders,
      'Content-Length': String(obj.size),
    };
    if (obj.httpEtag) headers['ETag'] = obj.httpEtag;
    return new Response(obj.body, { status: 200, headers });
  }

  /**
   * Download: adaptive between 'proxy' (Worker Binding streaming) and 'presign' (302 to R2).
   * Falls back to 'proxy' automatically if S3 presign credentials are not configured.
   */
  async get(key, opts = {}) {
    if (opts.mode === 'proxy' || !this.presignEnabled) {
      return this.getStream(key, opts);
    }
    const url = await this.presignedGetUrl(key, opts);
    return Response.redirect(url, 302);
  }

  async head(key) {
    this._needBinding();
    const obj = await this.binding.head(key);
    return obj ? { size: obj.size } : null;
  }

  async delete(key) {
    this._needBinding();
    await this.binding.delete(key);
  }

  async copy(srcKey, dstKey) {
    this._needBinding();
    const obj = await this.binding.get(srcKey);
    if (!obj) throw new Error('copy source not found: ' + srcKey);
    await this.binding.put(dstKey, obj.body, {
      httpMetadata: obj.httpMetadata ? { contentType: obj.httpMetadata.contentType } : undefined,
    });
  }

  /** R2 rename = copy + delete (same as v2.8.4 / Node). */
  async rename(srcKey, dstKey) {
    await this.copy(srcKey, dstKey);
    await this.delete(srcKey);
  }

  // ---- presigned URLs (aws4fetch) ----

  async presignedPutUrl(key, opts = {}) {
    return this._presign('PUT', key, { expiresIn: opts.expiresIn || 900 });
  }

  async presignedGetUrl(key, opts = {}) {
    const query = {};
    if (opts.disposition) query['response-content-disposition'] = opts.disposition;
    if (opts.contentType) query['response-content-type'] = opts.contentType;
    return this._presign('GET', key, { expiresIn: opts.expiresIn || 6 * 3600, query });
  }

  // ---- R2 multipart (Binding; used by the CF chunk flow) ----

  async createMultipartUpload(key, contentType) {
    this._needBinding();
    const mpu = await this.binding.createMultipartUpload(key, {
      httpMetadata: { contentType: contentType || 'application/octet-stream' },
    });
    return mpu.uploadId;
  }

  async presignedPartUrl(uploadId, key, partNumber, expiresIn = 900) {
    const client = this._awsClient();
    const url = new URL(s3Url(this.accountId, this.bucket, key));
    url.searchParams.set('partNumber', String(partNumber));
    url.searchParams.set('uploadId', String(uploadId));
    url.searchParams.set('X-Amz-Expires', String(expiresIn));
    const signed = await client.sign(url, { method: 'PUT', aws: { signQuery: true } });
    return signed.url;
  }

  async uploadPart(uploadId, key, partNumber, body) {
    this._needBinding();
    const mpu = this.binding.resumeMultipartUpload(key, uploadId);
    const out = await mpu.uploadPart(partNumber, body);
    return { etag: out.etag };
  }

  async completeMultipartUpload(uploadId, key, parts) {
    this._needBinding();
    const sorted = [...parts]
      .map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
      .sort((a, b) => a.partNumber - b.partNumber);
    const mpu = this.binding.resumeMultipartUpload(key, uploadId);
    await mpu.complete(sorted);
  }

  async abortMultipartUpload(uploadId, key) {
    this._needBinding();
    try {
      const mpu = this.binding.resumeMultipartUpload(key, uploadId);
      await mpu.abort();
    } catch { /* already gone is fine */ }
  }

  // ---- thumbnails (R2, `thumbs/` prefix) ----
  async putThumb(id, buffer) {
    await this.put(THUMB_PREFIX + id + '.jpg', buffer, 'image/jpeg');
  }
  async getThumb(id) {
    this._needBinding();
    const obj = await this.binding.get(THUMB_PREFIX + id + '.jpg');
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }
  async deleteThumb(id) {
    await this.delete(THUMB_PREFIX + id + '.jpg');
  }

  // ---- "local" extras (this instance doubles as `local` on CF) ----
  freeBytes() {
    return R2_FREE_BYTES;
  }
  totalBytes() {
    return R2_FREE_BYTES;
  }
  tempFilePath() {
    return ':cf-no-temp:';
  }
  async importTempFile() {
    throw new Error('importTempFile is not supported on Cloudflare Workers (no local disk)');
  }
  async removeTempFile() {
    /* no-op: no temp files exist on CF */
  }
}

export { CHUNK_TMP_PREFIX };
