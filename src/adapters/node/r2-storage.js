// RelayBox Node adapter — R2Storage (VPS target, AWS SDK).
// Implements the StorageStore contract against Cloudflare R2 (S3-compatible).

import fs from 'node:fs';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class R2Storage {
  constructor(r2config) {
    this.enabled = false;
    this.client = null;
    this.bucket = '';
    const c = r2config || null;
    if (c && c.bucket && c.endpoint && c.accessKeyId && c.secretAccessKey) {
      this.client = new S3Client({
        region: 'auto',
        endpoint: c.endpoint,
        credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
      });
      this.bucket = c.bucket;
      this.enabled = true;
    }
  }

  get presignEnabled() {
    return this.enabled;
  }

  get proxySupported() {
    return false;
  }

  _need() {
    if (!this.enabled) {
      const e = new Error('R2_NOT_CONFIGURED');
      e.code = 'R2_NOT_CONFIGURED';
      throw e;
    }
  }

  async put(key, body, contentType) {
    this._need();
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body,
      ContentType: contentType || 'application/octet-stream',
    }));
  }

  async putFile(key, filePath, contentType) {
    this._need();
    const stream = fs.createReadStream(filePath);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: key, Body: stream,
        ContentType: contentType || 'application/octet-stream',
      }));
    } catch (e) {
      try { stream.destroy(); } catch {}
      throw e;
    }
  }

  async get(key, opts = {}) {
    const url = await this.presignedGetUrl(key, opts);
    return Response.redirect(url, 302);
  }

  async head(key) {
    this._need();
    try {
      const h = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(h.ContentLength) };
    } catch {
      return null;
    }
  }

  async delete(key) {
    this._need();
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch { /* missing is fine */ }
  }

  async copy(srcKey, dstKey) {
    this._need();
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket,
      CopySource: this.bucket + '/' + encodeURIComponent(srcKey),
      Key: dstKey,
    }));
  }

  async rename(srcKey, dstKey) {
    await this.copy(srcKey, dstKey);
    await this.delete(srcKey);
  }

  async presignedPutUrl(key, opts = {}) {
    this._need();
    const cmd = new PutObjectCommand({
      Bucket: this.bucket, Key: key,
      ...(opts.contentLength ? { ContentLength: opts.contentLength } : {}),
      ...(opts.contentType ? { ContentType: opts.contentType } : {}),
    });
    return getSignedUrl(this.client, cmd, { expiresIn: opts.expiresIn || 900 });
  }

  async presignedGetUrl(key, opts = {}) {
    this._need();
    const cmd = new GetObjectCommand({
      Bucket: this.bucket, Key: key,
      ...(opts.disposition ? { ResponseContentDisposition: opts.disposition } : {}),
      ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
    });
    return getSignedUrl(this.client, cmd, { expiresIn: opts.expiresIn || 6 * 3600 });
  }

  async createMultipartUpload(key, contentType) {
    this._need();
    const out = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.bucket, Key: key,
      ContentType: contentType || 'application/octet-stream',
    }));
    return out.UploadId;
  }
  async presignedPartUrl(uploadId, key, partNumber, expiresIn = 900) {
    this._need();
    return getSignedUrl(this.client, new UploadPartCommand({
      Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber,
    }), { expiresIn });
  }
  async completeMultipartUpload(uploadId, key, parts) {
    this._need();
    await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }));
  }
  async abortMultipartUpload(uploadId, key) {
    this._need();
    try {
      await this.client.send(new AbortMultipartUploadCommand({
        Bucket: this.bucket, Key: key, UploadId: uploadId,
      }));
    } catch { /* already gone is fine */ }
  }

  async putThumb() {
    throw new Error('thumbnails are stored by LocalStorage, not R2Storage');
  }
  async getThumb() {
    return null;
  }
  async deleteThumb() {}
}
