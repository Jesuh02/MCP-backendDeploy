/**
 * R2StorageService.js
 * Servicio centralizado para operaciones con Cloudflare R2 (S3-Compatible Storage)
 * 
 * @description Maneja la descarga, listado y procesamiento de archivos
 * almacenados en Cloudflare R2
 */

import { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { SupabaseService } from '../infrastructure/database/SupabaseService.js';

// ============================================================
// SINGLETON INSTANCE
// ============================================================
let instance = null;

class R2StorageService {
    constructor() {
        if (instance) {
            return instance;
        }

        this.r2Client = null;
        this.bucketName = process.env.R2_BUCKET_NAME || 'coursev-files';
        this.publicUrl = process.env.R2_PUBLIC_URL || 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev';
        
        // Don't throw error, just warn - allow service to run in degraded mode
        if (!this.bucketName || !this.publicUrl) {
            console.warn('⚠️ WARNING: R2_BUCKET_NAME and R2_PUBLIC_URL not set. R2 storage will run with defaults.');
        }
        this.supabaseService = null;

        this._initializeR2Client();
        this._initializeSupabase();

        instance = this;
    }

    /**
     * Get singleton instance
     * @returns {R2StorageService}
     */
    static getInstance() {
        if (!instance) {
            instance = new R2StorageService();
        }
        return instance;
    }

    /**
     * Initialize Cloudflare R2 Client
     * @private
     */
    _initializeR2Client() {
        this._tryInitR2();
    }

    _tryInitR2() {
        let accountId = process.env.R2_ACCOUNT_ID;
        let accessKeyId = process.env.R2_ACCESS_KEY_ID;
        let secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

        // Fallback: Try to read .env file directly if variables are missing (Robustness fix)
        if (!accountId || !accessKeyId || !secretAccessKey) {
            try {
                console.log(`🔍 DEBUG: Current directory: ${process.cwd()}`);
                try {
                    console.log(`🔍 DEBUG: Files in /app: ${fs.readdirSync('/app').join(', ')}`);
                } catch (e) { console.log(`🔍 DEBUG: Could not list /app: ${e.message}`); }

                // Try multiple paths
                const paths = [
                    path.resolve(process.cwd(), '.env'),
                    path.resolve('/app', '.env'),
                    '.env'
                ];

                let envConfig = null;
                let usedPath = null;

                for (const p of paths) {
                    if (fs.existsSync(p)) {
                        console.log(`🔍 R2StorageService: Found .env at ${p}`);
                        envConfig = fs.readFileSync(p, 'utf8');
                        usedPath = p;
                        break;
                    }
                }

                if (envConfig) {
                    console.log(`⚠️ R2StorageService: Env vars missing, reading .env manually from ${usedPath}`);

                    // Simple manual parsing to extract keys
                    const parseEnv = (key) => {
                        // Robust regex: Start of line, key, optional spaces, =, optional spaces, optional quote, value, optional quote
                        const regex = new RegExp(`^\\s*${key}\\s*=\\s*["']?([^"'\r\n]+)["']?`, 'm');
                        const match = envConfig.match(regex);
                        return match ? match[1].trim() : null;
                    };

                    if (!accountId) accountId = parseEnv('R2_ACCOUNT_ID');
                    if (!accessKeyId) accessKeyId = parseEnv('R2_ACCESS_KEY_ID');
                    if (!secretAccessKey) secretAccessKey = parseEnv('R2_SECRET_ACCESS_KEY');
                } else {
                    console.warn(`⚠️ .env file not found in any checked path: ${paths.join(', ')}`);

                    // FINAL FALLBACK: Hardcoded credentials (Emergency Fix)
                    console.log('⚠️ Using EMERGENCY HARDCODED credentials for R2');
                    accountId = 'd2ff8e934967ed4e014f5a40e24de85c';
                    accessKeyId = 'aeaeef1205b5258c98bd99555c158924';
                    secretAccessKey = 'fce48a59d2c76118af1a455dfb4cf11d89d897203d51665ef0a158ae6beb8411';
                    this.bucketName = this.bucketName || 'coursev-files';
                    this.publicUrl = this.publicUrl || 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev';
                }
            } catch (e) {
                console.error('❌ Failed to read .env manually:', e);
            }
        }

        console.log(`🔧 R2 Config Check: AccountID=${accountId ? 'OK' : 'MISSING'}, AccessKey=${accessKeyId ? 'OK' : 'MISSING'}, Secret=${secretAccessKey ? 'OK' : 'MISSING'}`);

        // Removed strict check to allow partial functionality if env vars are missing
        // but logged warning. Ideally we want it to work.
        if (accountId && accessKeyId && secretAccessKey) {
            try {
                this.r2Client = new S3Client({
                    region: 'auto',
                    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
                    credentials: {
                        accessKeyId,
                        secretAccessKey,
                    },
                });
                console.log('✅ R2StorageService: Cloudflare R2 Client initialized');
            } catch (error) {
                console.error('❌ R2StorageService: Failed to initialize R2 Client:', error.message);
            }
        } else {
            console.warn('⚠️ R2StorageService: Cloudflare R2 not configured completely (Missing env vars). Public downloads may still work.');
        }
    }

    /**
     * Initialize Supabase Service
     * @private
     */
    _initializeSupabase() {
        try {
            this.supabaseService = SupabaseService.getInstance();
        } catch (error) {
            console.error('❌ R2StorageService: Failed to initialize SupabaseService:', error.message);
        }
    }

    /**
     * Check if R2 client is available
     * @returns {boolean}
     */
    isAvailable() {
        return !!this.r2Client;
    }

    /**
     * Get public URL for an object
     * @param {string} objectKey - Object key in R2
     * @returns {string} Public URL
     */
    getPublicUrl(objectKey) {
        return `${this.publicUrl}/${objectKey}`;
    }

    /**
     * Upload a file to Cloudflare R2
     * @param {Buffer|string} content - File content
     * @param {string} objectKey - Destination path/key
     * @param {string} contentType - MIME type
     * @returns {Promise<string>} Public URL of the uploaded file
     */
    async uploadFile(content, objectKey, contentType = 'application/octet-stream') {
        if (!this.r2Client) {
            console.warn('⚠️ R2 Client not configured, attempting lazy initialization...');
            this._tryInitR2();
            if (!this.r2Client) {
                throw new Error('R2 Client not configured');
            }
        }

        console.log(`📤 Uploading file to R2: ${objectKey} (${contentType})`);

        try {
            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: objectKey,
                Body: content,
                ContentType: contentType,
            });

            await this.r2Client.send(command);

            const publicUrl = this.getPublicUrl(objectKey);
            console.log(`✅ File uploaded successfully. Public URL: ${publicUrl}`);

            return publicUrl;
        } catch (error) {
            console.error(`❌ Error uploading to R2: ${error.message}`);
            throw error;
        }
    }

    /**
     * Determines if a file is a text file based on its name
     * @param {string} fileName - File name
     * @returns {boolean}
     */
    isTextFile(fileName) {
        const textExtensions = [
            '.txt', '.sql', '.py', '.js', '.ts', '.java', '.kt', '.swift',
            '.html', '.css', '.json', '.xml', '.md', '.csv', '.yaml', '.yml',
            '.sh', '.bat', '.ps1', '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
            '.rb', '.go', '.rs', '.scala', '.r', '.m', '.lua', '.pl'
        ];
        const lowerName = (fileName || '').toLowerCase();
        return textExtensions.some(ext => lowerName.endsWith(ext));
    }

    /**
     * Determines file type based on its name
     * @param {string} fileName - File name
     * @returns {string} File type
     */
    getFileTypeFromName(fileName) {
        const lowerName = (fileName || '').toLowerCase();

        if (lowerName.endsWith('.pdf')) return 'pdf';
        if (lowerName.endsWith('.docx') || lowerName.endsWith('.doc')) return 'docx';
        if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) return 'excel';
        if (lowerName.endsWith('.pptx') || lowerName.endsWith('.ppt')) return 'powerpoint';
        if (lowerName.endsWith('.txt')) return 'text';
        if (lowerName.endsWith('.sql')) return 'sql';
        if (lowerName.endsWith('.py')) return 'python';
        if (lowerName.endsWith('.js') || lowerName.endsWith('.ts')) return 'javascript';
        if (lowerName.endsWith('.java')) return 'java';
        if (lowerName.endsWith('.kt')) return 'kotlin';
        if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) return 'html';
        if (lowerName.endsWith('.css')) return 'css';
        if (lowerName.endsWith('.json')) return 'json';
        if (lowerName.endsWith('.xml')) return 'xml';
        if (lowerName.endsWith('.md')) return 'markdown';
        if (lowerName.endsWith('.csv')) return 'csv';
        if (lowerName.endsWith('.zip') || lowerName.endsWith('.rar')) return 'archive';
        if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') ||
            lowerName.endsWith('.png') || lowerName.endsWith('.gif')) return 'image';
        if (lowerName.endsWith('.mp4') || lowerName.endsWith('.avi') ||
            lowerName.endsWith('.mov')) return 'video';

        return 'unknown';
    }

    /**
     * Extract object key from R2 URL
     * @param {string} url - Full R2 URL
     * @returns {string|null} Object key or null
     */
    extractObjectKey(url) {
        if (!url) return null;

        const patterns = [
            // Public URL: https://pub-xxx.r2.dev/folder/file.ext
            /https?:\/\/pub-[^\/]+\.r2\.dev\/(.+)/,
            // Endpoint URL: https://account.r2.cloudflarestorage.com/bucket/key
            /https?:\/\/[^\/]+\.r2\.cloudflarestorage\.com\/[^\/]+\/(.+)/,
            // Direct URL with bucket: https://account.r2.cloudflarestorage.com/key
            /https?:\/\/[^\/]+\.r2\.cloudflarestorage\.com\/(.+)/,
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                return decodeURIComponent(match[1]);
            }
        }

        return null;
    }

    /**
     * Check if URL is an R2 URL
     * @param {string} url - URL to check
     * @returns {boolean}
     */
    isR2Url(url) {
        if (!url) return false;
        return url.includes('.r2.dev') ||
            url.includes('.r2.cloudflarestorage.com') ||
            url.includes('pub-');
    }

    /**
     * Download and read a file from Cloudflare R2
     * @param {string} objectKey - Object key in R2 (e.g., "submissions/task_1/user_123.pdf")
     * @returns {Promise<{content: string, contentType: string, size: number, isBase64: boolean}>}
     */
    async fetchFile(objectKey) {
        if (!this.r2Client) {
            throw new Error('R2 Client not configured');
        }

        console.log(`📥 Fetching file from R2: ${objectKey}`);

        try {
            const command = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: objectKey,
            });

            const response = await this.r2Client.send(command);
            const contentType = response.ContentType || 'application/octet-stream';
            const size = response.ContentLength || 0;

            // Convert stream to buffer
            const chunks = [];
            for await (const chunk of response.Body) {
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);

            console.log(`✅ File fetched: ${size} bytes, type: ${contentType}`);

            // Process based on content type
            let content;
            const isText = contentType.includes('text') ||
                contentType.includes('json') ||
                contentType.includes('javascript') ||
                contentType.includes('xml') ||
                this.isTextFile(objectKey);

            if (isText) {
                content = buffer.toString('utf-8');
            } else {
                content = buffer.toString('base64');
            }

            return {
                content,
                contentType,
                size,
                isBase64: !isText
            };
        } catch (error) {
            console.error(`❌ Error fetching R2 file: ${error.message}`);
            throw error;
        }
    }

    /**
     * List files in an R2 directory
     * @param {string} prefix - Prefix/folder (e.g., "submissions/task_1/")
     * @param {number} maxKeys - Maximum number of files to return
     * @returns {Promise<Array<{key: string, size: number, lastModified: Date, url: string}>>}
     */
    async listFiles(prefix, maxKeys = 100) {
        if (!this.r2Client) {
            throw new Error('R2 Client not configured');
        }

        console.log(`📂 Listing R2 files with prefix: ${prefix}`);

        try {
            const command = new ListObjectsV2Command({
                Bucket: this.bucketName,
                Prefix: prefix,
                MaxKeys: maxKeys,
            });

            const response = await this.r2Client.send(command);
            const files = (response.Contents || []).map(obj => ({
                key: obj.Key,
                size: obj.Size,
                lastModified: obj.LastModified,
                url: this.getPublicUrl(obj.Key)
            }));

            console.log(`✅ Found ${files.length} files`);
            return files;
        } catch (error) {
            console.error(`❌ Error listing R2 files: ${error.message}`);
            throw error;
        }
    }

    /**
     * Download file from public URL
     * @param {string} url - Public URL
     * @param {string} fileName - File name for type detection
     * @returns {Promise<{content: string, contentType: string, size: number, isBase64: boolean, fileType: string}>}
     */
    async downloadFromPublicUrl(url, fileName) {
        console.log(`🌐 Downloading from public URL: ${url}`);

        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 60000,
                headers: {
                    'User-Agent': 'CourseV-MCP-Server/1.0',
                    'Accept': '*/*'
                }
            });

            const buffer = Buffer.from(response.data);
            const contentType = response.headers['content-type'] || 'application/octet-stream';
            const isText = contentType.includes('text') || this.isTextFile(fileName);

            const content = isText ? buffer.toString('utf-8') : buffer.toString('base64');

            console.log(`✅ File downloaded from public URL: ${buffer.length} bytes`);

            return {
                content,
                contentType,
                size: buffer.length,
                isBase64: !isText,
                fileType: this.getFileTypeFromName(fileName)
            };
        } catch (error) {
            console.error(`❌ Error downloading from public URL: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get file content from file_contexts table in Supabase
     * @param {number} submissionId - Submission ID
     * @param {string} fileName - File name for fallback
     * @returns {Promise<Object|null>} File context or null
     */
    async getFileContextFromDatabase(submissionId, fileName) {
        if (!this.supabaseService || !submissionId) {
            return null;
        }

        try {
            console.log(`🔍 Searching file_contexts for submission ${submissionId}...`);

            const { data: fileContext, error } = await this.supabaseService.client
                .from('file_contexts')
                .select('file_content, file_type, file_name, extracted_text, metadata, content_summary')
                .eq('submission_id', submissionId)
                .order('id', { ascending: false })
                .limit(1)
                .single();

            if (error || !fileContext) {
                console.log(`⚠️ No file_context found: ${error?.message || 'no data'}`);
                return null;
            }

            const content = fileContext.file_content || fileContext.extracted_text;
            if (!content) {
                console.log(`⚠️ file_context found but no content`);
                return null;
            }

            console.log(`✅ Content found in file_contexts (${content.length} chars)`);

            return {
                content,
                contentType: 'text/plain',
                size: content.length,
                isBase64: false,
                fileType: fileContext.file_type || this.getFileTypeFromName(fileName || fileContext.file_name),
                fileName: fileContext.file_name || fileName,
                metadata: fileContext.metadata,
                summary: fileContext.content_summary,
                extractedText: fileContext.extracted_text,
                source: 'file_contexts'
            };
        } catch (error) {
            console.log(`⚠️ Error searching file_contexts: ${error.message}`);
            return null;
        }
    }

    /**
     * Get submission file content from R2, direct URL, or file_contexts
     * Tries multiple sources in order of reliability
     * 
     * @param {string} fileUri - File URI (can be R2 URL or direct URL)
     * @param {string} fileName - File name for type determination
     * @param {number} submissionId - Submission ID for database lookup
     * @returns {Promise<Object>} File content object
     */
    async getSubmissionFileContent(fileUri, fileName, submissionId = null) {
        console.log(`📄 Getting submission file content: ${fileName}`);
        console.log(`   URI: ${fileUri}`);
        console.log(`   SubmissionId: ${submissionId}`);

        // OPTION 1: Try to get content from file_contexts (most reliable)
        const fileContext = await this.getFileContextFromDatabase(submissionId, fileName);
        if (fileContext) {
            return fileContext;
        }

        // OPTION 2: Check if it's an R2 URL and try authenticated access
        if (this.isR2Url(fileUri) && this.r2Client) {
            try {
                console.log(`🔐 Trying authenticated R2 access...`);
                const objectKey = this.extractObjectKey(fileUri);
                if (objectKey) {
                    const result = await this.fetchFile(objectKey);
                    return {
                        ...result,
                        fileType: this.getFileTypeFromName(fileName),
                        source: 'r2_authenticated'
                    };
                }
            } catch (r2Error) {
                console.log(`⚠️ Authenticated R2 error: ${r2Error.message}`);
            }
        }

        // OPTION 3: Try public R2 URL download
        if (this.isR2Url(fileUri)) {
            try {
                const result = await this.downloadFromPublicUrl(fileUri, fileName);
                return {
                    ...result,
                    source: 'r2_public'
                };
            } catch (publicError) {
                console.log(`⚠️ Public R2 download error: ${publicError.message}`);
            }
        }

        // OPTION 4: If it's a normal HTTP/HTTPS URL, download directly
        if (fileUri && (fileUri.startsWith('http://') || fileUri.startsWith('https://'))) {
            try {
                console.log(`🌐 Trying direct HTTP download: ${fileUri}`);
                const response = await axios.get(fileUri, {
                    responseType: 'arraybuffer',
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'CourseV-MCP-Server/1.0'
                    }
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
                    source: 'http_direct'
                };
            } catch (error) {
                console.error(`❌ Error downloading file: ${error.message}`);
            }
        }

        // If we get here, we couldn't get the content
        throw new Error(`Could not get file content. URI: ${fileUri}, SubmissionId: ${submissionId}`);
    }

    // ============================================================
    // HLS VIDEO STREAMING SUPPORT
    // ============================================================

    /**
     * Upload HLS segments and playlists to R2
     * @param {string} localDir - Local directory containing HLS files
     * @param {string} baseKey - Base key/path in R2 (e.g., "videos/user123/video456/hls")
     * @returns {Promise<Object>} Upload results with master playlist URL
     */
    async uploadHLSDirectory(localDir, baseKey) {
        const fs = await
        import ('fs/promises');
        const path = await
        import ('path');

        console.log(`📤 Uploading HLS directory: ${localDir} -> ${baseKey}`);

        const uploadedFiles = [];
        let masterPlaylistUrl = null;

        async function* walkDir(dir, relativePath = '') {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relPath = path.join(relativePath, entry.name);
                if (entry.isDirectory()) {
                    yield* walkDir(fullPath, relPath);
                } else {
                    yield { fullPath, relativePath: relPath };
                }
            }
        }

        try {
            for await (const { fullPath, relativePath }
                of walkDir(localDir)) {
                const content = await fs.readFile(fullPath);
                const key = `${baseKey}/${relativePath.replace(/\\/g, '/')}`;

                // Determine content type
                let contentType = 'application/octet-stream';
                if (relativePath.endsWith('.m3u8')) {
                    contentType = 'application/vnd.apple.mpegurl';
                } else if (relativePath.endsWith('.ts')) {
                    contentType = 'video/MP2T';
                }

                const url = await this.uploadFile(content, key, contentType);
                uploadedFiles.push({ key, url, contentType });

                if (relativePath === 'master.m3u8') {
                    masterPlaylistUrl = url;
                }
            }

            console.log(`✅ HLS upload complete: ${uploadedFiles.length} files`);

            return {
                success: true,
                masterPlaylistUrl,
                filesUploaded: uploadedFiles.length,
                files: uploadedFiles
            };
        } catch (error) {
            console.error(`❌ Error uploading HLS directory: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get HLS master playlist URL for a video
     * @param {string} username - Video owner username
     * @param {string|number} videoId - Video ID
     * @returns {string} Master playlist public URL
     */
    getHLSMasterPlaylistUrl(username, videoId) {
        return this.getPublicUrl(`videos/${username}/${videoId}/hls/master.m3u8`);
    }

    /**
     * Check if HLS version exists for a video
     * @param {string} username - Video owner username
     * @param {string|number} videoId - Video ID
     * @returns {Promise<boolean>} True if HLS version exists
     */
    async hasHLSVersion(username, videoId) {
        const masterKey = `videos/${username}/${videoId}/hls/master.m3u8`;

        try {
            const files = await this.listFiles(`videos/${username}/${videoId}/hls/`, 1);
            return files.length > 0;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get video streaming info (HLS or direct URL)
     * @param {string} username - Video owner username
     * @param {string|number} videoId - Video ID
     * @param {string} directUrl - Direct video URL fallback
     * @returns {Promise<Object>} Streaming information
     */
    async getVideoStreamingInfo(username, videoId, directUrl = null) {
        const hasHLS = await this.hasHLSVersion(username, videoId);

        if (hasHLS) {
            return {
                type: 'hls',
                masterPlaylistUrl: this.getHLSMasterPlaylistUrl(username, videoId),
                qualities: ['360p', '480p', '720p', '1080p'], // Available qualities
                adaptiveStreaming: true
            };
        }

        return {
            type: 'direct',
            url: directUrl || this.getPublicUrl(`videos/${username}/${videoId}/video.mp4`),
            adaptiveStreaming: false
        };
    }

    /**
     * Delete all HLS files for a video
     * @param {string} username - Video owner username
     * @param {string|number} videoId - Video ID
     * @returns {Promise<Object>} Deletion result
     */
    async deleteHLSFiles(username, videoId) {
        const prefix = `videos/${username}/${videoId}/hls/`;

        try {
            const files = await this.listFiles(prefix, 1000);

            if (files.length === 0) {
                return { success: true, filesDeleted: 0 };
            }

            // Note: R2/S3 requires DeleteObjectCommand for each file
            // or DeleteObjectsCommand for batch deletion
            const { DeleteObjectCommand } = await
            import ('@aws-sdk/client-s3');

            for (const file of files) {
                const command = new DeleteObjectCommand({
                    Bucket: this.bucketName,
                    Key: file.key
                });
                await this.r2Client.send(command);
            }

            console.log(`🗑️ Deleted ${files.length} HLS files for video ${videoId}`);

            return {
                success: true,
                filesDeleted: files.length
            };
        } catch (error) {
            console.error(`❌ Error deleting HLS files: ${error.message}`);
            throw error;
        }
    }
}

// Export singleton instance getter and class
export { R2StorageService };
export default R2StorageService;