/**
 * FFmpegVideoAdapter — Adaptador de infraestructura que implementa IVideoProcessingPort.
 *
 * Encapsula toda la lógica de procesamiento de video con FFmpeg:
 * análisis, compresión, transcodificación HLS, thumbnails.
 *
 * Principios:
 *   - SRP: solo procesamiento de video via FFmpeg
 *   - DIP: el dominio depende de IVideoProcessingPort, no de FFmpeg
 *   - OCP: intercambiable por otro encoder (HandBrake, cloud transcode, etc.)
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

// ── Quality Presets for HLS Adaptive Streaming ───────────────
const QUALITY_PRESETS = {
    LOW: { name: '360p', width: 640, height: 360, videoBitrate: '800k', audioBitrate: '96k', maxRate: '856k', bufSize: '1200k', bandwidth: 800000 },
    MEDIUM: { name: '480p', width: 854, height: 480, videoBitrate: '1400k', audioBitrate: '128k', maxRate: '1498k', bufSize: '2100k', bandwidth: 1400000 },
    HIGH: { name: '720p', width: 1280, height: 720, videoBitrate: '2800k', audioBitrate: '128k', maxRate: '2996k', bufSize: '4200k', bandwidth: 2800000 },
    FULL_HD: { name: '1080p', width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k', maxRate: '5350k', bufSize: '7500k', bandwidth: 5000000 },
};

// ── Compression Thresholds ───────────────────────────────────
const COMPRESSION_THRESHOLDS = {
    MAX_FILE_SIZE_MB: 100,
    MAX_RESOLUTION_HEIGHT: 720,
    MIN_DURATION_SECONDS: 180,
    SCREEN_RECORDING_FPS: 15,
};

export class FFmpegVideoAdapter extends EventEmitter {
    constructor() {
        super();
        this.ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
        this.ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
        this.tempDir = path.join(os.tmpdir(), 'coursev-video-processing');
        this.jobs = new Map();
        this._available = null;
        this._initTempDir();
    }

    /** @private */
    async _initTempDir() {
        try {
            await fs.mkdir(this.tempDir, { recursive: true });
        } catch { /* ignore */ }
    }

    // ── IVideoProcessingPort ─────────────────────────────────

    /** @returns {boolean} */
    isAvailable() {
        if (this._available !== null) return this._available;
        try {
            execSync(`${this.ffmpegPath} -version`, { stdio: 'ignore' });
            this._available = true;
        } catch {
            this._available = false;
        }
        return this._available;
    }

    /**
     * Analyze a video file and return metadata.
     * @param {string} filePath
     * @returns {Promise<Object>}
     */
    async analyze(filePath) {
        return new Promise((resolve, reject) => {
            const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath];
            let output = '';
            const proc = spawn(this.ffprobePath, args);

            proc.stdout.on('data', (d) => { output += d; });
            proc.stderr.on('data', () => {});
            proc.on('error', reject);
            proc.on('close', (code) => {
                if (code !== 0) return reject(new Error(`FFprobe failed with code ${code}`));
                try {
                    const data = JSON.parse(output);
                    const vs = data.streams?.find((s) => s.codec_type === 'video');
                    const as = data.streams?.find((s) => s.codec_type === 'audio');
                    const fps = vs?.r_frame_rate
                        ? (() => { const [n, d] = vs.r_frame_rate.split('/'); return d ? n / d : parseFloat(n); })()
                        : 0;
                    const fileSize = parseInt(data.format?.size || 0, 10);

                    resolve({
                        duration: parseFloat(data.format?.duration || 0),
                        fileSize,
                        bitrate: parseInt(data.format?.bit_rate || 0, 10),
                        width: vs?.width || 0,
                        height: vs?.height || 0,
                        fps,
                        needsCompression: (fileSize / 1024 / 1024) > COMPRESSION_THRESHOLDS.MAX_FILE_SIZE_MB,
                        video: vs ? { codec: vs.codec_name, width: vs.width, height: vs.height, fps, bitrate: parseInt(vs.bit_rate || 0, 10) } : null,
                        audio: as ? { codec: as.codec_name, sampleRate: parseInt(as.sample_rate || 0, 10), channels: as.channels, bitrate: parseInt(as.bit_rate || 0, 10) } : null,
                    });
                } catch (e) {
                    reject(new Error(`Error parsing FFprobe output: ${e.message}`));
                }
            });
        });
    }

    /**
     * Simple video processing (compression + fast start).
     * @param {string} inputPath
     * @param {{ qualities?: string[], outputDir?: string }} options
     * @returns {Promise<{ jobId: string, outputPath: string }>}
     */
    async process(inputPath, options = {}) {
        const jobId = this._createJobId();
        const outputDir = options.outputDir || path.join(os.tmpdir(), jobId);
        await fs.mkdir(outputDir, { recursive: true });
        this.jobs.set(jobId, { status: 'processing', progress: 0, startedAt: Date.now() });

        try {
            const outputPath = path.join(outputDir, 'output.mp4');
            await this._runFFmpeg(inputPath, outputPath);
            this.jobs.set(jobId, { status: 'completed', progress: 100, outputPath, outputDir });
            return { jobId, outputPath };
        } catch (err) {
            this.jobs.set(jobId, { status: 'failed', progress: 0, error: err.message });
            throw err;
        }
    }

    /**
     * Download video from URL and process locally.
     * @param {string} url
     * @param {Object} options
     * @returns {Promise<Object>}
     */
    async processFromUrl(url, options = {}) {
        const tmpPath = path.join(os.tmpdir(), `download_${Date.now()}.mp4`);
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Download failed: ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            await fs.writeFile(tmpPath, buffer);
            return await this.process(tmpPath, options);
        } finally {
            await fs.unlink(tmpPath).catch(() => {});
        }
    }

    /**
     * Get the status of a processing job.
     * @param {string} jobId
     * @returns {Promise<Object>}
     */
    async getJobStatus(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) throw new Error(`Job ${jobId} not found`);
        return job;
    }

    /** @returns {Object} */
    getQualityPresets() {
        return QUALITY_PRESETS;
    }

    // ── Extended Video Processing ────────────────────────────

    /**
     * Determine if a video should be compressed based on thresholds.
     * @param {Object} metadata — from analyze()
     * @param {{ isScreenRecording?: boolean, isFromMobile?: boolean }} options
     * @returns {{ shouldCompress: boolean, reason: string, details: Object }}
     */
    shouldCompress(metadata, options = {}) {
        const { isScreenRecording = false, isFromMobile = true } = options;
        const fileSizeMB = (metadata.fileSize || 0) / (1024 * 1024);
        const height = metadata.video?.height || metadata.height || 0;
        const duration = metadata.duration || 0;
        const fps = metadata.video?.fps || metadata.fps || 30;

        if (isScreenRecording || fps <= COMPRESSION_THRESHOLDS.SCREEN_RECORDING_FPS) {
            return { shouldCompress: false, reason: 'Screen recording — compression not recommended', details: { fps } };
        }
        if (duration < COMPRESSION_THRESHOLDS.MIN_DURATION_SECONDS) {
            return { shouldCompress: false, reason: `Video too short (${Math.round(duration)}s)`, details: { duration } };
        }
        if (fileSizeMB > COMPRESSION_THRESHOLDS.MAX_FILE_SIZE_MB) {
            return { shouldCompress: true, reason: `File exceeds ${COMPRESSION_THRESHOLDS.MAX_FILE_SIZE_MB}MB`, details: { fileSizeMB } };
        }
        if (height > COMPRESSION_THRESHOLDS.MAX_RESOLUTION_HEIGHT) {
            return { shouldCompress: true, reason: `Resolution exceeds ${COMPRESSION_THRESHOLDS.MAX_RESOLUTION_HEIGHT}p`, details: { height } };
        }
        if (isFromMobile && fileSizeMB > 50) {
            return { shouldCompress: true, reason: 'Mobile upload — optimization recommended', details: { fileSizeMB } };
        }
        return { shouldCompress: false, reason: 'Video already optimized', details: { fileSizeMB, height, duration } };
    }

    /**
     * Determine which quality presets to generate based on source resolution.
     * @param {Object} metadata
     * @returns {Object[]}
     */
    getTargetQualities(metadata) {
        const sourceHeight = metadata.video?.height || metadata.height || 720;
        const qualities = [QUALITY_PRESETS.LOW];
        if (sourceHeight >= 480) qualities.push(QUALITY_PRESETS.MEDIUM);
        if (sourceHeight >= 720) qualities.push(QUALITY_PRESETS.HIGH);
        if (sourceHeight >= 1080) qualities.push(QUALITY_PRESETS.FULL_HD);
        return qualities;
    }

    /**
     * Transcode video to HLS format with multiple quality levels.
     * @param {string} inputPath
     * @param {string} outputDir
     * @param {Object} options
     * @returns {Promise<{ jobId: string, masterPlaylist: string, qualities: Object[], outputDir: string }>}
     */
    async transcodeToHLS(inputPath, outputDir, options = {}) {
        const jobId = this._createJobId();
        this.jobs.set(jobId, { status: 'processing', progress: 0, startTime: Date.now() });

        try {
            const metadata = await this.analyze(inputPath);
            const qualities = this.getTargetQualities(metadata);
            await fs.mkdir(outputDir, { recursive: true });

            const variantPlaylists = [];

            for (let i = 0; i < qualities.length; i++) {
                const quality = qualities[i];
                const qualityDir = path.join(outputDir, quality.name);
                await fs.mkdir(qualityDir, { recursive: true });

                await this._transcodeQuality(inputPath, qualityDir, quality, metadata);

                variantPlaylists.push({
                    quality: quality.name,
                    bandwidth: quality.bandwidth,
                    resolution: `${quality.width}x${quality.height}`,
                    playlist: `${quality.name}/playlist.m3u8`,
                });

                const progress = Math.round(((i + 1) / qualities.length) * 100);
                this.jobs.set(jobId, { ...this.jobs.get(jobId), progress });
                this.emit('progress', { jobId, progress, quality: quality.name });
            }

            const masterPlaylistPath = path.join(outputDir, 'master.m3u8');
            await this._generateMasterPlaylist(masterPlaylistPath, variantPlaylists);

            this.jobs.set(jobId, { status: 'completed', progress: 100, startTime: this.jobs.get(jobId).startTime, endTime: Date.now(), outputDir, masterPlaylist: masterPlaylistPath, qualities: variantPlaylists });

            return { jobId, masterPlaylist: masterPlaylistPath, qualities: variantPlaylists, outputDir };
        } catch (error) {
            this.jobs.set(jobId, { status: 'failed', error: error.message, endTime: Date.now() });
            throw error;
        }
    }

    /**
     * Compress video to a single optimized format.
     * @param {string} inputPath
     * @param {string} outputPath
     * @param {{ targetHeight?: number, targetBitrate?: string, preset?: string }} options
     * @returns {Promise<Object>}
     */
    async compressVideo(inputPath, outputPath, options = {}) {
        const { targetHeight = 720, targetBitrate = '2500k', preset = 'medium' } = options;
        const metadata = await this.analyze(inputPath);
        const originalSizeMB = (metadata.fileSize || 0) / (1024 * 1024);

        return new Promise((resolve, reject) => {
            const args = [
                '-i', inputPath,
                '-c:v', 'libx264', '-preset', preset, '-crf', '23',
                '-b:v', targetBitrate, '-maxrate', targetBitrate,
                '-bufsize', `${parseInt(targetBitrate) * 2}k`,
                '-vf', `scale=-2:${targetHeight}`,
                '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart', '-y', outputPath,
            ];

            const proc = spawn(this.ffmpegPath, args);
            proc.stderr.on('data', () => {});
            proc.on('error', reject);
            proc.on('close', async (code) => {
                if (code !== 0) return reject(new Error(`Compression failed (code ${code})`));
                try {
                    const newMeta = await this.analyze(outputPath);
                    const newSizeMB = (newMeta.fileSize || 0) / (1024 * 1024);
                    resolve({
                        outputPath,
                        originalSize: metadata.fileSize,
                        newSize: newMeta.fileSize,
                        compressionRatio: parseFloat(((originalSizeMB - newSizeMB) / originalSizeMB * 100).toFixed(1)),
                        duration: newMeta.duration,
                        resolution: `${newMeta.video?.width}x${newMeta.video?.height}`,
                    });
                } catch (e) { reject(e); }
            });
        });
    }

    /**
     * Apply fast-start optimization (move moov atom to beginning).
     * @param {string} inputPath
     * @param {string} outputPath
     * @returns {Promise<string>}
     */
    async applyFastStart(inputPath, outputPath) {
        return new Promise((resolve, reject) => {
            const args = ['-i', inputPath, '-c', 'copy', '-movflags', '+faststart', '-y', outputPath];
            const proc = spawn(this.ffmpegPath, args);
            proc.stderr.on('data', () => {});
            proc.on('error', reject);
            proc.on('close', (code) => {
                code === 0 ? resolve(outputPath) : reject(new Error(`Fast start failed (code ${code})`));
            });
        });
    }

    /**
     * Clean up temporary files for a job.
     * @param {string} jobId
     */
    async cleanupJob(jobId) {
        const job = this.jobs.get(jobId);
        if (job?.outputDir) {
            try { await fs.rm(job.outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        this.jobs.delete(jobId);
    }

    /**
     * Generate a thumbnail from a video at a given timestamp.
     * @param {string} inputPath
     * @param {string} outputPath
     * @param {number} timestamp — seconds
     * @returns {Promise<string>}
     */
    async generateThumbnail(inputPath, outputPath, timestamp = 1) {
        return new Promise((resolve, reject) => {
            const args = ['-i', inputPath, '-ss', String(timestamp), '-vframes', '1', '-vf', 'scale=480:-1', '-q:v', '2', '-y', outputPath];
            const proc = spawn(this.ffmpegPath, args);
            proc.on('error', reject);
            proc.on('close', (code) => {
                code === 0 ? resolve(outputPath) : reject(new Error(`Thumbnail generation failed (code ${code})`));
            });
        });
    }

    // ── Private Helpers ──────────────────────────────────────

    /** @private */
    _createJobId() {
        return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /** @private — Simple compression pass */
    _runFFmpeg(input, output) {
        const args = [
            '-i', input, '-c:v', 'libx264', '-preset', 'veryfast',
            '-profile:v', 'baseline', '-movflags', '+faststart',
            '-c:a', 'aac', '-y', output,
        ];
        return new Promise((resolve, reject) => {
            const proc = spawn(this.ffmpegPath, args);
            proc.stderr.on('data', () => {});
            proc.on('error', reject);
            proc.on('close', (code) => {
                code === 0 ? resolve() : reject(new Error(`FFmpeg failed (code ${code})`));
            });
        });
    }

    /** @private — Transcode to a specific HLS quality level */
    _transcodeQuality(inputPath, outputDir, quality, metadata) {
        return new Promise((resolve, reject) => {
            const playlistPath = path.join(outputDir, 'playlist.m3u8');
            const segmentPath = path.join(outputDir, 'segment_%03d.ts');
            const scaleFilter = `scale=${quality.width}:${quality.height}:force_original_aspect_ratio=decrease,pad=${quality.width}:${quality.height}:(ow-iw)/2:(oh-ih)/2`;

            const args = [
                '-i', inputPath,
                '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'baseline', '-level', '3.1',
                '-b:v', quality.videoBitrate, '-maxrate', quality.maxRate, '-bufsize', quality.bufSize,
                '-vf', scaleFilter,
                '-c:a', 'aac', '-b:a', quality.audioBitrate, '-ar', '44100', '-ac', '2',
                '-movflags', '+faststart',
                '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
                '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
                '-hls_segment_filename', segmentPath,
                '-hls_playlist_type', 'vod',
                '-hls_flags', 'independent_segments+temp_file',
                '-start_number', '0',
                playlistPath,
            ];

            const proc = spawn(this.ffmpegPath, args);
            proc.stderr.on('data', (data) => {
                const timeMatch = data.toString().match(/time=(\d{2}):(\d{2}):(\d{2})/);
                if (timeMatch && metadata.duration) {
                    const currentTime = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
                    this.emit('quality-progress', { quality: quality.name, progress: Math.round((currentTime / metadata.duration) * 100) });
                }
            });
            proc.on('error', reject);
            proc.on('close', (code) => {
                code === 0 ? resolve({ playlistPath, quality: quality.name }) : reject(new Error(`FFmpeg HLS failed (code ${code})`));
            });
        });
    }

    /** @private — Generate HLS master playlist */
    async _generateMasterPlaylist(outputPath, variants) {
        let content = '#EXTM3U\n#EXT-X-VERSION:3\n\n';
        for (const v of variants) {
            content += `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.resolution}\n${v.playlist}\n`;
        }
        await fs.writeFile(outputPath, content, 'utf8');
    }
}

export { QUALITY_PRESETS, COMPRESSION_THRESHOLDS };
export default FFmpegVideoAdapter;