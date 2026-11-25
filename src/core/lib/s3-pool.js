// RelayBox core lib — S3PoolStorage (dynamic external R2 / S3-compatible bucket driver).
// Pure Web APIs + aws4fetch (zero Node deps). Works on both Cloudflare Workers and Node.js.

import { AwsClient } from 'aws4fetch';
import { R2_FREE_BYTES } from './util.js';

function encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class S3PoolStorage {
  constructor(opts = {}) {
    this.id = opts.id || '';
    this.name = opts.name || 'S3';
    this.endpoint = String(opts.endpoint || '').trim().replace(/\/+$/, '');
    this.bucket = String(opts.bucket || '').trim();
    this.region = String(opts.region || 'auto').trim() || 'auto';
    this.accessKeyId = String(opts.accessKeyId || '').trim();
    this.secretAccessKey = String(opts.secretAccessKey || '').trim();
    this.publicDomain = String(opts.publicDomain || '').trim().replace(/\/+$/, '');
    this.transferMode = opts.transferMode === 'proxy' ? 'proxy' : 'presign';
    this.quotaBytes = Number(opts.quotaBytes) > 0 ? Number(opts.quotaBytes) : R2_FREE_BYTES;
    this._aws = null;
  }

  get enabled() {
    return !!(this.endpoint && this.bucket && this.accessKeyId && this.secretAccessKey);
  }

  get presignEnabled() {
    return this.enabled;
  }

  get proxySupported() {
    return this.enabled;
  }

  _client() {
    if (this._aws) return this._aws;
    if (!this.enabled) {
      const e = new Error('S3_POOL_CONFIG_INCOMPLETE');
      e.code = 'S3_POOL_CONFIG_INCOMPLETE';
      throw e;
    }
    this._aws = new AwsClient({
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      service: 's3',
      region: this.region,
    });
    return this._aws;
  }

  _bucketUrl() {
    return `${this.endpoint}/${encodeURIComponent(this.bucket)}`;
  }

  _objectUrl(key) {
    return `${this._bucketUrl()}/${encodeKey(key)}`;
  }

  async _presign(method, key, { expiresIn, query = {} } = {}) {
    const client = this._client();
    const url = new URL(this._objectUrl(key));
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    url.searchParams.set('X-Amz-Expires', String(expiresIn || 3600));
    const signed = await client.sign(url, { method, aws: { signQuery: true } });
    return signed.url;
  }

  async testConnection() {
    const client = this._client();
    const url = `${this._bucketUrl()}?list-type=2&max-keys=1`;
    const t0 = Date.now();
    const res = await client.fetch(url, { method: 'GET' });
    const latencyMs = Date.now() - t0;
    if (res.ok) return { ok: true, latencyMs };
    let detail = `HTTP ${res.status}`;
    try {
      const text = await res.text();
      const code = /<Code>([^<]+)<\/Code>/i.exec(text);
      const msg = /<Message>([^<]+)<\/Message>/i.exec(text);
      if (code || msg) detail = [code && code[1], msg && msg[1]].filter(Boolean).join(': ');
    } catch {}
    return { ok: false, latencyMs, error: detail };
  }

  async put(key, body, contentType) {
    const client = this._client();
    const res = await client.fetch(this._objectUrl(key), {
      method: 'PUT',
      headers: { 'Content-Type': contentType || 'application/octet-stream' },
      body,
    });
    if (!res.ok) throw new Error(`S3 PUT failed: HTTP ${res.status}`);
  }

  async putFile() {
    throw new Error('putFile is not supported directly on S3PoolStorage');
  }

  async getStream(key, opts = {}) {
    const client = this._client();
    const reqHeaders = {};
    const hasRange = opts.start !== undefined || opts.end !== undefined;
    if (hasRange) {
      const s = opts.start;
      const e = opts.end;
      if ((s === null || s === undefined) && e !== null && e !== undefined) {
        reqHeaders['Range'] = `bytes=-${e}`;
      } else if (s !== null && s !== undefined && (e === null || e === undefined)) {
        reqHeaders['Range'] = `bytes=${s}-`;
      } else if (s !== null && s !== undefined && e !== null && e !== undefined) {
        reqHeaders['Range'] = `bytes=${s}-${e}`;
      }
    }
    const res = await client.fetch(this._objectUrl(key), { method: 'GET', headers: reqHeaders });
    if (res.status === 404) return null;
    if (res.status === 416) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': res.headers.get('content-range') || 'bytes */0' },
      });
    }
    if (!res.ok) throw new Error(`S3 GET failed: HTTP ${res.status}`);
    const outHeaders = {
      'Content-Type': opts.contentType || res.headers.get('content-type') || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    };
    if (opts.disposition) outHeaders['Content-Disposition'] = opts.disposition;
    if (opts.cacheControl) outHeaders['Cache-Control'] = opts.cacheControl;
    if (opts.vary) outHeaders['Vary'] = opts.vary;
    const cl = res.headers.get('content-length');
    if (cl) outHeaders['Content-Length'] = cl;
    const cr = res.headers.get('content-range');
    if (cr) outHeaders['Content-Range'] = cr;
    const etag = (!hasRange && opts.etag) ? opts.etag : res.headers.get('etag');
    if (etag) outHeaders['ETag'] = etag;
    return new Response(res.body, { status: res.status, headers: outHeaders });
  }

  async get(key, opts = {}) {
    const mode = opts.mode || this.transferMode;
    if (mode === 'proxy') return this.getStream(key, opts);
    const url = await this.presignedGetUrl(key, opts);
    return Response.redirect(url, 302);
  }

  async head(key) {
    const client = this._client();
    const res = await client.fetch(this._objectUrl(key), { method: 'HEAD' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 HEAD failed: HTTP ${res.status}`);
    return { size: Number(res.headers.get('content-length') || 0) };
  }

  async delete(key) {
    const client = this._client();
    const res = await client.fetch(this._objectUrl(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE failed: HTTP ${res.status}`);
  }

  async copy(srcKey, dstKey) {
    const client = this._client();
    const res = await client.fetch(this._objectUrl(dstKey), {
      method: 'PUT',
      headers: { 'x-amz-copy-source': `/${encodeURIComponent(this.bucket)}/${encodeKey(srcKey)}` },
    });
    if (!res.ok) throw new Error(`S3 COPY failed: HTTP ${res.status}`);
  }

  async rename(srcKey, dstKey) {
    await this.copy(srcKey, dstKey);
    await this.delete(srcKey);
  }

  async presignedPutUrl(key, opts = {}) {
    return this._presign('PUT', key, { expiresIn: opts.expiresIn || 900 });
  }

  async presignedGetUrl(key, opts = {}) {
    const query = {};
    if (opts.disposition) query['response-content-disposition'] = opts.disposition;
    if (opts.contentType) query['response-content-type'] = opts.contentType;
    return this._presign('GET', key, { expiresIn: opts.expiresIn || 6 * 3600, query });
  }

  async createMultipartUpload(key, contentType) {
    const client = this._client();
    const res = await client.fetch(`${this._objectUrl(key)}?uploads`, {
      method: 'POST',
      headers: { 'Content-Type': contentType || 'application/octet-stream' },
    });
    if (!res.ok) throw new Error(`S3 CreateMultipartUpload failed: HTTP ${res.status}`);
    const xml = await res.text();
    const m = /<UploadId>([^<]+)<\/UploadId>/i.exec(xml);
    if (!m) throw new Error('S3 CreateMultipartUpload missing UploadId');
    return m[1].trim();
  }

  async presignedPartUrl(uploadId, key, partNumber, expiresIn = 900) {
    return this._presign('PUT', key, {
      expiresIn,
      query: { partNumber: String(partNumber), uploadId: String(uploadId) },
    });
  }

  async uploadPart(uploadId, key, partNumber, body) {
    const client = this._client();
    const url = `${this._objectUrl(key)}?partNumber=${encodeURIComponent(partNumber)}&uploadId=${encodeURIComponent(uploadId)}`;
    const res = await client.fetch(url, { method: 'PUT', body });
    if (!res.ok) throw new Error(`S3 UploadPart ${partNumber} failed: HTTP ${res.status}`);
    const etag = res.headers.get('etag') || '';
    if (!etag) throw new Error(`S3 UploadPart ${partNumber} missing ETag`);
    return { etag };
  }

  async completeMultipartUpload(uploadId, key, parts) {
    const client = this._client();
    const sorted = [...parts]
      .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag || '') }))
      .sort((a, b) => a.partNumber - b.partNumber);
    const body = '<CompleteMultipartUpload>' + sorted.map(
      (p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`,
    ).join('') + '</CompleteMultipartUpload>';
    const url = `${this._objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`;
    const res = await client.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
    });
    if (!res.ok) throw new Error(`S3 CompleteMultipartUpload failed: HTTP ${res.status}`);
  }

  async abortMultipartUpload(uploadId, key) {
    try {
      const client = this._client();
      const url = `${this._objectUrl(key)}?uploadId=${encodeURIComponent(uploadId)}`;
      await client.fetch(url, { method: 'DELETE' });
    } catch { /* already gone is fine */ }
  }

  async putThumb() { throw new Error('thumbnails are stored by built-in storage'); }
  async getThumb() { return null; }
  async deleteThumb() {}
}
