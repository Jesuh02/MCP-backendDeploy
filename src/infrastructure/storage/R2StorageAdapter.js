/**
 * R2StorageAdapter — Implementa IFileStoragePort.
 *
 * Adaptador de infraestructura para Cloudflare R2 (S3-compatible).
 * Encapsula toda la lógica de almacenamiento, descarga, HLS y
 * recuperación de contenido de archivos.
 *
 * Principios:
 *   - SRP: solo operaciones de almacenamiento de archivos
 *   - DIP: el dominio depende de IFileStoragePort, no de este adaptador
 *   - OCP: intercambiable por S3Adapter, GCSAdapter, etc.
 */

import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

// -- Text file extensions for content-type detection ----------
const TEXT_EXTENSIONS = new Set([
    '.txt', '.sql', '.py', '.js', '.ts', '.java', '.kt', '.swift',
    '.html', '.css', '.json', '.xml', '.md', '.csv', '.yaml', '.yml',
    '.sh', '.bat', '.ps1', '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
    '.rb', '.go', '.rs', '.scala', '.r', '.m', '.lua', '.pl',
]);

// -- File type mapping ----------------------------------------
const FILE_TYPE_MAP = [
    [/\.pdf$/, 'pdf'],
    [/\.docx?$/, 'docx'],
    [/\.xlsx?$/, 'excel'],
    [/\.pptx?$/, 'powerpoint'],
    [/\.txt$/, 'text'],
    [/\.sql$/, 'sql'],
    [/\.py$/, 'python'],
    [/\.[jt]s$/, 'javascript'],
    [/\.java$/, 'java'],
    [/\.kt$/, 'kotlin'],
    [/\.html?$/, 'html'],
    [/\.css$/, 'css'],
    [/\.json$/, 'json'],
    [/\.xml$/, 'xml'],
    [/\.md$/, 'markdown'],
    [/\.csv$/, 'csv'],
    [/\.(zip|rar)$/, 'archive'],
    [/\.(jpe?g|png|gif)$/, 'image'],
    [/\.(mp4|avi|mov)$/, 'video'],
];

export class R2StorageAdapter {
    constructor() {
        this.r2Client = null;
        this.bucketName = process.env.R2_BUCKET_NAME || 'coursev-files';
        this.publicUrl = process.env.R2_PUBLIC_URL || 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev';
        this._presignerFn = null;
        this._supabaseService = null;
        this._initClient();
    }

    // -- Initialization ---------------------------------------

    /** @private */
    _initClient() {
        const accountId = process.env.R2_ACCOUNT_ID;
        const accessKeyId = process.env.R2_ACCESS_KEY_ID;
        const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

        if (accountId && accessKeyId && secretAccessKey) {
            this.r2Client = new S3Client({
                region: 'auto',
                endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
                credentials: { accessKeyId, secretAccessKey },
            });
            console.log('? R2StorageAdapter: Client initialized');
        } else {
            console.warn('?? R2StorageAdapter: Missing R2 env vars');
        }
    }

    /** @private — lazy-load presigner to avoid startup crash */
    async _getPresigner() {
        if (this._presignerFn) return this._presignerFn;
        try {
            const mod = await import('@aws-sdk/s3-request-presigner');
            this._presignerFn = mod.getSignedUrl;
            return this._presignerFn;
        } catch {
            return null;
        }
    }

    /** @private — lazy-load SupabaseService for file_contexts queries */
    _getSupabase() {
        if (this._supabaseService) return this._supabaseService;
        try {
            // Dynamic import to avoid circular dependency at module load time
            const { SupabaseService } = require('../database/SupabaseService.js');
            this._supabaseService = SupabaseService.getInstance();
        } catch {
            this._supabaseService = null;
        }
        return this._supabaseService;
    }

    // -- IFileStoragePort — Core Storage Operations -----------

    isAvailable() {
        return Boolean(this.r2Client);
    }

    getPublicUrl(key) {
        return `${this.publicUrl}/${key}`;
    }

    async generateUploadUrl(key, contentType = 'application/octet-stream', expiresIn = 3600) {
        if (!this.r2Client) throw new Error('R2 client not available');
        const getSignedUrl = await this._getPresigner();
        if (!getSignedUrl) throw new Error('Presigner not available');
        const cmd = new PutObjectCommand({ Bucket: this.bucketName, Key: key, ContentType: contentType });
        return getSignedUrl(this.r2Client, cmd, { expiresIn });
    }

    async generateDownloadUrl(key, expiresIn = 300) {
        if (!this.r2Client) return this.getPublicUrl(key);
        try {
            const getSignedUrl = await this._getPresigner();
            if (!getSignedUrl) return this.getPublicUrl(key);
            const cmd = new GetObjectCommand({ Bucket: this.bucketName, Key: key });
            return getSignedUrl(this.r2Client, cmd, { expiresIn });
        } catch {
            return this.getPublicUrl(key);
        }
    }

    async uploadFile(content, key, contentType = 'application/octet-stream') {
        if (!this.r2Client) throw new Error('R2 client not available');
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

    async listFiles(prefix, maxKeys = 100) {
        if (!this.r2Client) return [];
        const cmd = new ListObjectsV2Command({ Bucket: this.bucketName, Prefix: prefix, MaxKeys: maxKeys });
        const res = await this.r2Client.send(cmd);
        return (res.Contents || []).map((obj) => ({
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified,
            url: this.getPublicUrl(obj.Key),
        }));
    }

    async fetchFile(key) {
        if (!this.r2Client) throw new Error('R2 client not available');
        const cmd = new GetObjectCommand({ Bucket: this.bucketName, Key: key });
        const res = await this.r2Client.send(cmd);
        const contentType = res.ContentType || 'application/octet-stream';

        const chunks = [];
        for await (const chunk of res.Body) { chunks.push(chunk); }
        const buffer = Buffer.concat(chunks);

        const isText = contentType.includes('text') ||
            contentType.includes('json') ||
            contentType.includes('javascript') ||
            contentType.includes('xml') ||
            this.isTextFile(key);

        return {
            content: isText ? buffer.toString('utf-8') : buffer.toString('base64'),
            buffer,
            contentType,
            size: buffer.length,
            isBase64: !isText,
        };
    }

    // -- File Utilities ---------------------------------------

    sanitizeFileName(name) {
        if (!name) return `file_${Date.now()}`;
        const ext = path.extname(name) || '';
        const base = path.basename(name, ext)
            .toLowerCase()
            .replace(/[^a-z0-9\-_. ]/g, '-')
            .replace(/\s+/g, '-');
        return `${base}${ext}`;
    }

    ensureKeyHasExtension(key, contentType) {
        const ext = path.extname(key);
        if (ext && ext.length > 1) return key;
        if (!contentType) return `${key}.mp4`;
        if (contentType.includes('mp4')) return `${key}.mp4`;
        if (contentType.includes('webm')) return `${key}.webm`;
        if (contentType.includes('ogg')) return `${key}.ogg`;
        return `${key}.mp4`;
    }

    extractObjectKey(url) {
        if (!url) return null;
        if (!url.startsWith('http://') && !url.startsWith('https://')) return null;

        const patterns = [
            /https?:\/\/pub-[^/]+\.r2\.dev\/(.+)/,
            /https?:\/\/[^/]+\.r2\.cloudflarestorage\.com\/[^/]+\/(.+)/,
            /https?:\/\/[^/]+\.r2\.cloudflarestorage\.com\/(.+)/,
        ];
        for (const p of patterns) {
            const m = url.match(p);
            if (m) return decodeURIComponent(m[1]);
        }
        return null;
    }

    isR2Url(url) {
        if (!url) return false;
        return url.includes('.r2.dev') || url.includes('.r2.cloudflarestorage.com');
    }

    isTextFile(fileName) {
        const lower = (fileName || '').toLowerCase();
        return [...TEXT_EXTENSIONS].some((ext) => lower.endsWith(ext));
    }

    getFileTypeFromName(fileName) {
        const lower = (fileName || '').toLowerCase();
        for (const [pattern, type] of FILE_TYPE_MAP) {
            if (pattern.test(lower)) return type;
        }
        return 'unknown';
    }

    // -- Upload Helpers ---------------------------------------

    /**
     * Upload a buffer with an auto-generated key.
     * @param {Buffer} buffer
     * @param {string} originalFilename
     * @param {string} contentType
     * @param {string} prefix — e.g. 'videos', 'submissions'
     * @returns {Promise<{ publicUrl: string, key: string }>}
     */
    async uploadBufferWithAutoKey(buffer, originalFilename = null, contentType = 'video/mp4', prefix = 'videos') {
        const sanitized = this.sanitizeFileName(originalFilename || `video_${Date.now()}.mp4`);
        const keyBase = `${prefix}/${Date.now()}_${sanitized}`;
        const key = this.ensureKeyHasExtension(keyBase, contentType);
        const publicUrl = await this.uploadFile(buffer, key, contentType);
        return { publicUrl, key };
    }

    // -- Download / Content Retrieval -------------------------

    /**
     * Download file from a public HTTP URL.
     * @param {string} url
     * @param {string} fileName
     * @returns {Promise<Object>}
     */
    async downloadFromPublicUrl(url, fileName) {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 60000,
            headers: { 'User-Agent': 'CourseV-Server/1.0', Accept: '*/*' },
        });

        const buffer = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || 'application/octet-stream';
        const isText = contentType.includes('text') || this.isTextFile(fileName);

        return {
            content: isText ? buffer.toString('utf-8') : buffer.toString('base64'),
            contentType,
            size: buffer.length,
            isBase64: !isText,
            fileType: this.getFileTypeFromName(fileName),
        };
    }

    /**
     * Look up pre-extracted file content in file_contexts table.
     * @param {number} submissionId
     * @param {string} fileName
     * @returns {Promise<Object|null>}
     */
    async getFileContextFromDatabase(submissionId, fileName) {
        const supabase = this._getSupabase();
        if (!supabase || !submissionId) return null;

        try {
            const { data: ctx, error } = await supabase.client
                .from('file_contexts')
                .select('file_content, file_type, file_name, extracted_text, metadata, content_summary')
                .eq('submission_id', submissionId)
                .order('id', { ascending: false })
                .limit(1)
                .single();

            if (error || !ctx) return null;

            const content = ctx.file_content || ctx.extracted_text;
            if (!content) return null;

            return {
                content,
                contentType: 'text/plain',
                size: content.length,
                isBase64: false,
                fileType: ctx.file_type || this.getFileTypeFromName(fileName || ctx.file_name),
                fileName: ctx.file_name || fileName,
                metadata: ctx.metadata,
                summary: ctx.content_summary,
                extractedText: ctx.extracted_text,
                source: 'file_contexts',
            };
        } catch {
            return null;
        }
    }

    /**
     * Get submission file content — tries file_contexts, R2 auth, R2 public, HTTP.
     * @param {string} fileUri
     * @param {string} fileName
     * @param {number} submissionId
     * @returns {Promise<Object>}
     */
    async getSubmissionFileContent(fileUri, fileName, submissionId = null) {
        // 1. Pre-extracted content from DB
        const cached = await this.getFileContextFromDatabase(submissionId, fileName);
        if (cached) return cached;

        // 2. Authenticated R2 access
        if (this.isR2Url(fileUri) && this.r2Client) {
            try {
                const objectKey = this.extractObjectKey(fileUri);
                if (objectKey) {
                    const result = await this.fetchFile(objectKey);
                    return { ...result, fileType: this.getFileTypeFromName(fileName), source: 'r2_authenticated' };
                }
            } catch { /* fall through */ }
        }

        // 3. Public R2 URL
        if (this.isR2Url(fileUri)) {
            try {
                return { ...(await this.downloadFromPublicUrl(fileUri, fileName)), source: 'r2_public' };
            } catch { /* fall through */ }
        }

        // 4. Generic HTTP download
        if (fileUri?.startsWith('http://') || fileUri?.startsWith('https://')) {
            try {
                return { ...(await this.downloadFromPublicUrl(fileUri, fileName)), source: 'http_direct' };
            } catch (err) {
                throw new Error(`Could not download file: ${err.message}`);
            }
        }

        throw new Error(`Could not get file content. URI: ${fileUri}, submissionId: ${submissionId}`);
    }

    // -- HLS Video Streaming ----------------------------------

    /**
     * Upload all files in a local HLS directory to R2.
     * @param {string} localDir
     * @param {string} baseKey — e.g. "videos/user123/video456/hls"
     * @returns {Promise<{ success: boolean, masterPlaylistUrl: string|null, filesUploaded: number }>}
     */
    async uploadHLSDirectory(localDir, baseKey) {
        const uploaded = [];
        let masterPlaylistUrl = null;

        const walkDir = async (dir, relativePath = '') => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relPath = path.join(relativePath, entry.name);
                if (entry.isDirectory()) {
                    await walkDir(fullPath, relPath);
                } else {
                    const content = await fs.readFile(fullPath);
                    const key = `${baseKey}/${relPath.replace(/\\/g, '/')}`;
                    let ct = 'application/octet-stream';
                    if (relPath.endsWith('.m3u8')) ct = 'application/vnd.apple.mpegurl';
                    else if (relPath.endsWith('.ts')) ct = 'video/MP2T';

                    const url = await this.uploadFile(content, key, ct);
                    uploaded.push({ key, url, contentType: ct });
                    if (relPath === 'master.m3u8') masterPlaylistUrl = url;
                }
            }
        };

        await walkDir(localDir);
        return { success: true, masterPlaylistUrl, filesUploaded: uploaded.length, files: uploaded };
    }

    getHLSMasterPlaylistUrl(username, videoId) {
        return this.getPublicUrl(`videos/${username}/${videoId}/hls/master.m3u8`);
    }

    async hasHLSVersion(username, videoId) {
        try {
            const files = await this.listFiles(`videos/${username}/${videoId}/hls/`, 1);
            return files.length > 0;
        } catch {
            return false;
        }
    }

    async getVideoStreamingInfo(username, videoId, directUrl = null) {
        const hasHLS = await this.hasHLSVersion(username, videoId);
        if (hasHLS) {
            return {
                type: 'hls',
                masterPlaylistUrl: this.getHLSMasterPlaylistUrl(username, videoId),
                qualities: ['360p', '480p', '720p', '1080p'],
                adaptiveStreaming: true,
            };
        }
        return {
            type: 'direct',
            url: directUrl || this.getPublicUrl(`videos/${username}/${videoId}/video.mp4`),
            adaptiveStreaming: false,
        };
    }

    async deleteHLSFiles(username, videoId) {
        const prefix = `videos/${username}/${videoId}/hls/`;
        const files = await this.listFiles(prefix, 1000);
        if (files.length === 0) return { success: true, filesDeleted: 0 };

        for (const file of files) {
            await this.deleteFile(file.key);
        }
        return { success: true, filesDeleted: files.length };
    }
}

// createRequire for lazy SupabaseService import (ESM ? CJS bridge)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export default R2StorageAdapter;


