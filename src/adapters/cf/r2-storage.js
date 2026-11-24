// RelayBox Cloudflare adapter — R2Storage (Workers target).
// Implements the StorageStore contract against Cloudflare R2.
//
// Two drivers, split exactly as the plan requires:
// - Blob ops (put/get/head/delete/copy/rename/multipart) use the native
//   `env.R2` Binding (no SDK, no credentials needed).
// - Presigned URLs (signPut/signGet/signPart) use `aws4fetch` (pure Web
//   Crypto, no Node deps) with the R2 S3 API credentials, because the
//   Workers R2 Binding cannot generate presigned URLs. Credentials come
//   from Worker Secrets (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY /
//   R2_ACCOUNT_ID) — never hard-coded, never committed.
//
// Download / video Range (pitfall #2): `get()` answers with a 302 to a
// presigned GET, so download traffic and video scrubbing (Range) are
// served directly by the R2 edge; bytes never pass through the Worker.
// `/thumb/:id` does NOT use this — thumbnails go through `getThumb()`
// (env.R2.get, direct bytes, no redirect).
//
// This same instance is also passed as `local` in entry-worker.js (CF has
// no local disk): the "local" extras below (freeBytes/totalBytes,
// tempFilePath/importTempFile/removeTempFile) exist so the shared core
// routes keep working. Blob ops on the "local" role operate on R2, which
// is correct on CF because every file lives in R2.

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
  /**
   * @param {object} opts
   * @param {R2Bucket} opts.binding   env.R2 (the R2 Binding)
   * @param {string} opts.bucket      bucket name (for presigned URLs; the Binding itself needs none)
   * @param {string} opts.accountId   R2 account id (S3 endpoint host), from Worker Secret
   * @param {string} opts.accessKeyId R2 S3 API key id, from Worker Secret
   * @param {string} opts.secretAccessKey R2 S3 API secret, from Worker Secret
   */
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

  /**
   * Presign a URL with aws4fetch (signQuery). Returns the presigned URL string.
   * `expiresIn` is honoured by pre-setting X-Amz-Expires (aws4fetch only
   * defaults it to 86400 when absent). Note aws4fetch treats content-type /
   * content-length as unsignable, so they are NOT bound by the signature —
   * the browser may send any Content-Type/Length; R2 stores what it receives.
   */
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
   * Download: 302 redirect to a presigned GET (bytes never pass through the
   * Worker; the browser re-sends Range to the presigned URL, so video
   * scrubbing works at the R2 edge).
   * opts: { start, end, contentType, disposition } — Range is intentionally
   * NOT forwarded here; R2 answers it on the redirected request.
   */
  async get(key, opts = {}) {
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
  // The R2 Binding's multipart API is object-based, NOT bucket-based:
  // createMultipartUpload returns an R2MultipartUpload object; across
  // requests (Workers are stateless) the handle is recovered with
  // resumeMultipartUpload(key, uploadId), then uploadPart / complete /
  // abort are called on that object. There is NO bucket.uploadPart,
  // bucket.completeMultipartUpload or bucket.abortMultipartUpload.

  async createMultipartUpload(key, contentType) {
    this._needBinding();
    const mpu = await this.binding.createMultipartUpload(key, {
      httpMetadata: { contentType: contentType || 'application/octet-stream' },
    });
    return mpu.uploadId;
  }

  async presignedPartUrl(uploadId, key, partNumber, expiresIn = 900) {
    // X-Amz-Expires must be set BEFORE signing (it is part of the signed
    // query string); changing it afterwards would invalidate the signature.
    const client = this._awsClient();
    const url = new URL(s3Url(this.accountId, this.bucket, key));
    url.searchParams.set('partNumber', String(partNumber));
    url.searchParams.set('uploadId', String(uploadId));
    url.searchParams.set('X-Amz-Expires', String(expiresIn));
    const signed = await client.sign(url, { method: 'PUT', aws: { signQuery: true } });
    return signed.url;
  }

  /**
   * Direct part upload through the Worker (the live CF chunk flow: the
   * frontend POSTs chunk bytes to /api/upload/chunk and the Worker proxies
   * them to R2 — 20MB per part, far under the 100MB Worker body limit and
   * above the 5MB R2 multipart minimum).
   * partNumber is the R2 1-based number (callers map frontend index + 1).
   * Returns { etag }.
   */
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

  // ---- thumbnails (R2, `thumbs/` prefix — plan §6) ----
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
  // CF has no local disk: quota lines report the R2 free allowance, and
  // temp-file helpers are inert (chunk assembly happens in R2, not on disk).
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
