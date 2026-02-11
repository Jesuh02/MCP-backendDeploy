import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import path from 'path';

export class R2StorageAdapter {
  constructor() {
    this.r2Client = null;
    this.bucketName = process.env.R2_BUCKET_NAME || 'coursev-files';
    this.publicUrl = process.env.R2_PUBLIC_URL || 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev';
    this._presignerFn = null;
    this._initClient();
  }

  _initClient() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (accountId && accessKeyId && secretAccessKey) {
      this.r2Client = new S3Client({
        region: 'auto',
        endpoint: 'https://' + accountId + '.r2.cloudflarestorage.com',
        credentials: { accessKeyId, secretAccessKey },
      });
      console.log('[R2StorageAdapter] Client initialized');
    } else {
      console.warn('[R2StorageAdapter] Missing R2 env vars');
    }
  }

  async _getPresigner() {
    if (this._presignerFn) return this._presignerFn;
    const mod = await import('@aws-sdk/s3-request-presigner');
    this._presignerFn = mod.getSignedUrl;
    return this._presignerFn;
  }

  async generateUploadUrl(key, contentType, expiresIn) {
    if (!this.r2Client) throw new Error('R2 client not available');
    contentType = contentType || 'application/octet-stream';
    expiresIn = expiresIn || 3600;
    const getSignedUrl = await this._getPresigner();
    const cmd = new PutObjectCommand({ Bucket: this.bucketName, Key: key, ContentType: contentType });
    return getSignedUrl(this.r2Client, cmd, { expiresIn: expiresIn });
  }

  async generateDownloadUrl(key, expiresIn) {
    expiresIn = expiresIn || 300;
    if (!this.r2Client) return this.getPublicUrl(key);
    try {
      const getSignedUrl = await this._getPresigner();
      const cmd = new GetObjectCommand({ Bucket: this.bucketName, Key: key });
      return getSignedUrl(this.r2Client, cmd, { expiresIn: expiresIn });
    } catch (e) {
      return this.getPublicUrl(key);
    }
  }

  async uploadFile(content, key, contentType) {
    if (!this.r2Client) throw new Error('R2 client not available');
    contentType = contentType || 'application/octet-stream';
    const cmd = new PutObjectCommand({ Bucket: this.bucketName, Key: key, Body: content, ContentType: contentType });
    await this.r2Client.send(cmd);
    return this.getPublicUrl(key);
  }

  async deleteFile(key) {
    if (!this.r2Client) throw new Error('R2 client not available');
    const cmd = new DeleteObjectCommand({ Bucket: this.bucketName, Key: key });
    await this.r2Client.send(cmd);
    return true;
  }

  async listFiles(prefix, maxKeys) {
    if (!this.r2Client) return [];
    maxKeys = maxKeys || 100;
    const cmd = new ListObjectsV2Command({ Bucket: this.bucketName, Prefix: prefix, MaxKeys: maxKeys });
    const res = await this.r2Client.send(cmd);
    return (res.Contents || []).map(function (obj) {
      return { key: obj.Key, size: obj.Size, lastModified: obj.LastModified, publicUrl: this.getPublicUrl(obj.Key) };
    }.bind(this));
  }

  async fetchFile(key) {
    if (!this.r2Client) throw new Error('R2 client not available');
    const cmd = new GetObjectCommand({ Bucket: this.bucketName, Key: key });
    const res = await this.r2Client.send(cmd);
    const chunks = [];
    for await (const chunk of res.Body) { chunks.push(chunk); }
    return { buffer: Buffer.concat(chunks), contentType: res.ContentType };
  }

  getPublicUrl(key) {
    return this.publicUrl + '/' + key;
  }

  isAvailable() {
    return Boolean(this.r2Client);
  }

  sanitizeFileName(name) {
    if (!name) return 'file_' + Date.now();
    const ext = path.extname(name) || '';
    const base = path.basename(name, ext).toLowerCase().replace(/[^a-z0-9_. -]/g, '-').replace(/\s+/g, '-');
    return base + ext;
  }

  extractObjectKey(url) {
    if (!url) return null;
    // Skip non-HTTP URLs (file://, content://, etc.) — these are local device paths
    if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
    var m1 = url.match(/https?:\/\/pub-[^/]+\.r2\.dev\/(.+)/);
    if (m1) return m1[1];
    var m2 = url.match(/https?:\/\/[^/]+\.r2\.cloudflarestorage\.com\/[^/]+\/(.+)/);
    if (m2) return m2[1];
    return null;
  }
}

export default R2StorageAdapter;
