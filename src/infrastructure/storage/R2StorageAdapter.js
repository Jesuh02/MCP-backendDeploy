import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import path from 'path';

export class R2StorageAdapter {
  /**
   * TTL del cache de URLs firmadas: 50 minutos (las URLs expiran en 60min,
   * dejamos 10min de margen para que el cliente siempre reciba una URL válida).
   */
  static SIGNED_URL_CACHE_TTL_MS = 50 * 60 * 1000; // 3 000 000 ms

  constructor() {
    this.r2Client = null;
    this.bucketName = process.env.R2_BUCKET_NAME || 'coursev-files';
    this.publicUrl = process.env.R2_PUBLIC_URL || 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev';

    // Bucket público de miniaturas (split-bucket strategy)
    this.thumbnailPublicUrl = process.env.R2_THUMBNAIL_PUBLIC_URL || 'https://pub-4e815af1d00c464d999d446ba4c03d07.r2.dev';

    this._presignerFn = null;

    // Cache in-memory: Map<objectKey, { url: string, createdAt: number }>
    this._signedUrlCache = new Map();

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
    expiresIn = expiresIn || 3600;
    if (!this.r2Client) return this.getPublicUrl(key);

    // ── Cache check ──
    const cached = this._signedUrlCache.get(key);
    if (cached && (Date.now() - cached.createdAt) < R2StorageAdapter.SIGNED_URL_CACHE_TTL_MS) {
      return cached.url;
    }

    try {
      const getSignedUrl = await this._getPresigner();
      const cmd = new GetObjectCommand({ Bucket: this.bucketName, Key: key });
      const signedUrl = await getSignedUrl(this.r2Client, cmd, { expiresIn });

      // Almacenar en cache
      this._signedUrlCache.set(key, { url: signedUrl, createdAt: Date.now() });
      return signedUrl;
    } catch (e) {
      console.warn('[R2StorageAdapter] generateDownloadUrl failed for key:', key, e.message);
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

  // ── Split-bucket helpers ──────────────────────────────────

  /**
   * Detecta si una URL pertenece al bucket público de miniaturas (coursev-fil).
   * Las miniaturas NO necesitan URL firmada.
   */
  isThumbnailPublicUrl(url) {
    if (!url) return false;
    return url.includes('pub-4e815af1d00c464d999d446ba4c03d07.r2.dev');
  }

  /**
   * Construye la URL pública de una miniatura a partir de su object key.
   * @param {string} key  e.g. "thumbnails/courses/thumb_123.jpg"
   */
  getThumbnailPublicUrl(key) {
    return this.thumbnailPublicUrl + '/' + key;
  }

  /**
   * Devuelve estadísticas del cache de URLs firmadas (útil para /health).
   */
  getSignedUrlCacheStats() {
    let active = 0;
    let expired = 0;
    const now = Date.now();
    for (const [, entry] of this._signedUrlCache) {
      if ((now - entry.createdAt) < R2StorageAdapter.SIGNED_URL_CACHE_TTL_MS) {
        active++;
      } else {
        expired++;
      }
    }
    return { total: this._signedUrlCache.size, active, expired };
  }

  /**
   * Limpia entradas expiradas del cache.
   */
  purgeExpiredCache() {
    const now = Date.now();
    for (const [key, entry] of this._signedUrlCache) {
      if ((now - entry.createdAt) >= R2StorageAdapter.SIGNED_URL_CACHE_TTL_MS) {
        this._signedUrlCache.delete(key);
      }
    }
  }

  /**
   * Limpia todo el cache de URLs firmadas.
   */
  clearSignedUrlCache() {
    this._signedUrlCache.clear();
  }
}

export default R2StorageAdapter;
