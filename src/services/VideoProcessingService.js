/**
 * VideoProcessingService.js
 * Service for video processing with FFmpeg
 * 
 * Responsibilities (Single Responsibility Principle):
 * - Video compression decision logic
 * - HLS transcoding with multiple quality levels
 * - Video metadata extraction
 * 
 * @description Implements adaptive bitrate streaming (ABR) for optimal
 * video delivery based on user's network conditions
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

// ============================================================
// CONFIGURATION - Video Processing Standards
// ============================================================

/**
 * Quality presets for HLS adaptive streaming
 * Following industry standards for mobile-first delivery
 */
const QUALITY_PRESETS = {
    // 360p - Low quality for poor connections
    LOW: {
        name: '360p',
        width: 640,
        height: 360,
        videoBitrate: '800k',
        audioBitrate: '96k',
        maxRate: '856k',
        bufSize: '1200k',
        bandwidth: 800000
    },
    // 480p - Medium quality for average connections
    MEDIUM: {
        name: '480p',
        width: 854,
        height: 480,
        videoBitrate: '1400k',
        audioBitrate: '128k',
        maxRate: '1498k',
        bufSize: '2100k',
        bandwidth: 1400000
    },
    // 720p - High quality for good connections
    HIGH: {
        name: '720p',
        width: 1280,
        height: 720,
        videoBitrate: '2800k',
        audioBitrate: '128k',
        maxRate: '2996k',
        bufSize: '4200k',
        bandwidth: 2800000
    },
    // 1080p - Full HD for excellent connections
    FULL_HD: {
        name: '1080p',
        width: 1920,
        height: 1080,
        videoBitrate: '5000k',
        audioBitrate: '192k',
        maxRate: '5350k',
        bufSize: '7500k',
        bandwidth: 5000000
    }
};

/**
 * Compression thresholds - when to apply compression
 */
const COMPRESSION_THRESHOLDS = {
    MAX_FILE_SIZE_MB: 100, // Compress if > 100 MB
    MAX_RESOLUTION_HEIGHT: 720, // Compress if > 720p
    MIN_DURATION_SECONDS: 180, // Don't compress if < 3 min
    SCREEN_RECORDING_THRESHOLD: 15 // FPS threshold for screen recordings
};

// ============================================================
// SINGLETON INSTANCE
// ============================================================
let instance = null;

class VideoProcessingService extends EventEmitter {
    constructor() {
        super();

        if (instance) {
            return instance;
        }

        this.tempDir = path.join(os.tmpdir(), 'coursev-video-processing');
        this.ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
        this.ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
        this.processingJobs = new Map();

        this._initializeTempDirectory();

        instance = this;
    }

    /**
     * Get singleton instance
     * @returns {VideoProcessingService}
     */
    static getInstance() {
        if (!instance) {
            instance = new VideoProcessingService();
        }
        return instance;
    }

    /**
     * Initialize temporary directory for video processing
     * @private
     */
    async _initializeTempDirectory() {
        try {
            await fs.mkdir(this.tempDir, { recursive: true });
            console.log(`📁 VideoProcessingService: Temp directory ready at ${this.tempDir}`);
        } catch (error) {
            console.error('❌ VideoProcessingService: Failed to create temp directory:', error.message);
        }
    }

    /**
     * Extract video metadata using ffprobe
     * @param {string} inputPath - Path to video file
     * @returns {Promise<Object>} Video metadata
     */
    async getVideoMetadata(inputPath) {
        return new Promise((resolve, reject) => {
            const args = [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_format',
                '-show_streams',
                inputPath
            ];

            const ffprobe = spawn(this.ffprobePath, args);
            let stdout = '';
            let stderr = '';

            ffprobe.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            ffprobe.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            ffprobe.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
                    return;
                }

                try {
                    const metadata = JSON.parse(stdout);
                    const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
                    const audioStream = metadata.streams?.find(s => s.codec_type === 'audio');

                    resolve({
                        duration: parseFloat(metadata.format?.duration || 0),
                        fileSize: parseInt(metadata.format?.size || 0),
                        bitrate: parseInt(metadata.format?.bit_rate || 0),
                        video: videoStream ? {
                            codec: videoStream.codec_name,
                            width: videoStream.width,
                            height: videoStream.height,
                            fps: eval(videoStream.r_frame_rate || '0'),
                            bitrate: parseInt(videoStream.bit_rate || 0)
                        } : null,
                        audio: audioStream ? {
                            codec: audioStream.codec_name,
                            sampleRate: parseInt(audioStream.sample_rate || 0),
                            channels: audioStream.channels,
                            bitrate: parseInt(audioStream.bit_rate || 0)
                        } : null
                    });
                } catch (error) {
                    reject(new Error(`Failed to parse ffprobe output: ${error.message}`));
                }
            });

            ffprobe.on('error', (error) => {
                reject(new Error(`Failed to spawn ffprobe: ${error.message}`));
            });
        });
    }

    /**
     * Determine if video should be compressed based on thresholds
     * @param {Object} metadata - Video metadata from getVideoMetadata
     * @param {Object} options - Additional options
     * @returns {Object} Compression decision with reason
     */
    shouldCompress(metadata, options = {}) {
        const { isScreenRecording = false, isFromMobile = true } = options;
        const fileSizeMB = metadata.fileSize / (1024 * 1024);
        const height = metadata.video?.height || 0;
        const duration = metadata.duration || 0;
        const fps = metadata.video?.fps || 30;

        // Check if it's a screen recording (typically lower FPS)
        if (isScreenRecording || fps <= COMPRESSION_THRESHOLDS.SCREEN_RECORDING_THRESHOLD) {
            return {
                shouldCompress: false,
                reason: 'Screen recording detected - compression not recommended',
                details: { fps, isScreenRecording: true }
            };
        }

        // Check duration - don't compress short videos
        if (duration < COMPRESSION_THRESHOLDS.MIN_DURATION_SECONDS) {
            return {
                shouldCompress: false,
                reason: `Video too short (${Math.round(duration)}s < ${COMPRESSION_THRESHOLDS.MIN_DURATION_SECONDS}s)`,
                details: { duration }
            };
        }

        // Check file size
        if (fileSizeMB > COMPRESSION_THRESHOLDS.MAX_FILE_SIZE_MB) {
            return {
                shouldCompress: true,
                reason: `File size exceeds threshold (${fileSizeMB.toFixed(1)}MB > ${COMPRESSION_THRESHOLDS.MAX_FILE_SIZE_MB}MB)`,
                details: { fileSizeMB }
            };
        }

        // Check resolution
        if (height > COMPRESSION_THRESHOLDS.MAX_RESOLUTION_HEIGHT) {
            return {
                shouldCompress: true,
                reason: `Resolution exceeds threshold (${height}p > ${COMPRESSION_THRESHOLDS.MAX_RESOLUTION_HEIGHT}p)`,
                details: { height }
            };
        }

        // Mobile uploads - more aggressive compression
        if (isFromMobile && fileSizeMB > 50) {
            return {
                shouldCompress: true,
                reason: 'Mobile upload optimization',
                details: { isFromMobile, fileSizeMB }
            };
        }

        return {
            shouldCompress: false,
            reason: 'Video already optimized',
            details: { fileSizeMB, height, duration }
        };
    }

    /**
     * Determine which quality presets to generate based on source video
     * @param {Object} metadata - Video metadata
     * @returns {Array} Array of quality presets to generate
     */
    getTargetQualities(metadata) {
        const sourceHeight = metadata.video?.height || 720;
        const qualities = [];

        // Always include LOW for poor connections
        qualities.push(QUALITY_PRESETS.LOW);

        // Include MEDIUM if source is at least 480p
        if (sourceHeight >= 480) {
            qualities.push(QUALITY_PRESETS.MEDIUM);
        }

        // Include HIGH if source is at least 720p
        if (sourceHeight >= 720) {
            qualities.push(QUALITY_PRESETS.HIGH);
        }

        // Include FULL_HD only if source is at least 1080p
        if (sourceHeight >= 1080) {
            qualities.push(QUALITY_PRESETS.FULL_HD);
        }

        return qualities;
    }

    /**
     * Transcode video to HLS format with multiple quality levels
     * @param {string} inputPath - Path to input video
     * @param {string} outputDir - Directory for HLS output
     * @param {Object} options - Processing options
     * @returns {Promise<Object>} Processing result with manifest path
     */
    async transcodeToHLS(inputPath, outputDir, options = {}) {
        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        console.log(`🎬 Starting HLS transcode job: ${jobId}`);

        this.processingJobs.set(jobId, {
            status: 'processing',
            progress: 0,
            startTime: Date.now()
        });

        try {
            // Get video metadata
            const metadata = await this.getVideoMetadata(inputPath);
            console.log(`📊 Video metadata:`, metadata);

            // Determine target qualities
            const qualities = this.getTargetQualities(metadata);
            console.log(`🎯 Target qualities: ${qualities.map(q => q.name).join(', ')}`);

            // Create output directory
            await fs.mkdir(outputDir, { recursive: true });

            // Transcode each quality level
            const variantPlaylists = [];

            for (let i = 0; i < qualities.length; i++) {
                const quality = qualities[i];
                const qualityDir = path.join(outputDir, quality.name);
                await fs.mkdir(qualityDir, { recursive: true });

                console.log(`🔄 Transcoding ${quality.name}...`);

                await this._transcodeQuality(inputPath, qualityDir, quality, metadata);

                variantPlaylists.push({
                    quality: quality.name,
                    bandwidth: quality.bandwidth,
                    resolution: `${quality.width}x${quality.height}`,
                    playlist: `${quality.name}/playlist.m3u8`
                });

                // Update progress
                const progress = Math.round(((i + 1) / qualities.length) * 100);
                this.processingJobs.set(jobId, {
                    ...this.processingJobs.get(jobId),
                    progress
                });
                this.emit('progress', { jobId, progress, quality: quality.name });
            }

            // Generate master playlist
            const masterPlaylistPath = path.join(outputDir, 'master.m3u8');
            await this._generateMasterPlaylist(masterPlaylistPath, variantPlaylists);

            // Update job status
            this.processingJobs.set(jobId, {
                status: 'completed',
                progress: 100,
                startTime: this.processingJobs.get(jobId).startTime,
                endTime: Date.now(),
                outputDir,
                masterPlaylist: masterPlaylistPath,
                qualities: variantPlaylists
            });

            console.log(`✅ HLS transcode completed: ${jobId}`);

            return {
                jobId,
                masterPlaylist: masterPlaylistPath,
                qualities: variantPlaylists,
                outputDir
            };

        } catch (error) {
            this.processingJobs.set(jobId, {
                status: 'failed',
                error: error.message,
                startTime: this.processingJobs.get(jobId)?.startTime,
                endTime: Date.now()
            });

            console.error(`❌ HLS transcode failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Transcode video to a specific quality level
     * @private
     */
    async _transcodeQuality(inputPath, outputDir, quality, metadata) {
        return new Promise((resolve, reject) => {
            const playlistPath = path.join(outputDir, 'playlist.m3u8');
            const segmentPath = path.join(outputDir, 'segment_%03d.ts');

            // Calculate scale filter maintaining aspect ratio
            const scaleFilter = `scale=${quality.width}:${quality.height}:force_original_aspect_ratio=decrease,pad=${quality.width}:${quality.height}:(ow-iw)/2:(oh-ih)/2`;

            const args = [
                '-i', inputPath,
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-profile:v', 'main',
                '-level', '4.0',
                '-b:v', quality.videoBitrate,
                '-maxrate', quality.maxRate,
                '-bufsize', quality.bufSize,
                '-vf', scaleFilter,
                '-c:a', 'aac',
                '-b:a', quality.audioBitrate,
                '-ar', '44100',
                '-ac', '2',
                '-f', 'hls',
                '-hls_time', '6', // 6 second segments
                '-hls_list_size', '0', // Keep all segments
                '-hls_segment_filename', segmentPath,
                '-hls_playlist_type', 'vod',
                playlistPath
            ];

            console.log(`🎥 FFmpeg command for ${quality.name}`);

            const ffmpeg = spawn(this.ffmpegPath, args);
            let stderr = '';

            ffmpeg.stderr.on('data', (data) => {
                stderr += data.toString();
                // Parse progress from FFmpeg output
                const timeMatch = data.toString().match(/time=(\d{2}):(\d{2}):(\d{2})/);
                if (timeMatch && metadata.duration) {
                    const currentTime = parseInt(timeMatch[1]) * 3600 +
                        parseInt(timeMatch[2]) * 60 +
                        parseInt(timeMatch[3]);
                    const progress = Math.round((currentTime / metadata.duration) * 100);
                    this.emit('quality-progress', { quality: quality.name, progress });
                }
            });

            ffmpeg.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`FFmpeg exited with code ${code}`));
                    return;
                }
                resolve({ playlistPath, quality: quality.name });
            });

            ffmpeg.on('error', (error) => {
                reject(new Error(`Failed to spawn FFmpeg: ${error.message}`));
            });
        });
    }

    /**
     * Generate HLS master playlist
     * @private
     */
    async _generateMasterPlaylist(outputPath, variants) {
        let content = '#EXTM3U\n#EXT-X-VERSION:3\n\n';

        for (const variant of variants) {
            content += `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.resolution}\n`;
            content += `${variant.playlist}\n`;
        }

        await fs.writeFile(outputPath, content, 'utf8');
        console.log(`📝 Master playlist generated: ${outputPath}`);
    }

    /**
     * Compress video to a single optimized format
     * @param {string} inputPath - Path to input video
     * @param {string} outputPath - Path for output video
     * @param {Object} options - Compression options
     * @returns {Promise<Object>} Compression result
     */
    async compressVideo(inputPath, outputPath, options = {}) {
        const {
            targetHeight = 720,
                targetBitrate = '2500k',
                preset = 'medium'
        } = options;

        console.log(`🗜️ Compressing video to ${targetHeight}p...`);

        const metadata = await this.getVideoMetadata(inputPath);
        const originalSizeMB = metadata.fileSize / (1024 * 1024);

        return new Promise((resolve, reject) => {
            const scaleFilter = `scale=-2:${targetHeight}`;

            const args = [
                '-i', inputPath,
                '-c:v', 'libx264',
                '-preset', preset,
                '-crf', '23', // Constant Rate Factor for quality
                '-b:v', targetBitrate,
                '-maxrate', targetBitrate,
                '-bufsize', `${parseInt(targetBitrate) * 2}k`,
                '-vf', scaleFilter,
                '-c:a', 'aac',
                '-b:a', '128k',
                '-movflags', '+faststart', // Enable fast start for web
                '-y', // Overwrite output
                outputPath
            ];

            const ffmpeg = spawn(this.ffmpegPath, args);
            let stderr = '';

            ffmpeg.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            ffmpeg.on('close', async(code) => {
                if (code !== 0) {
                    reject(new Error(`FFmpeg compression failed with code ${code}`));
                    return;
                }

                try {
                    const newMetadata = await this.getVideoMetadata(outputPath);
                    const newSizeMB = newMetadata.fileSize / (1024 * 1024);
                    const compressionRatio = ((originalSizeMB - newSizeMB) / originalSizeMB * 100).toFixed(1);

                    console.log(`✅ Compression complete: ${originalSizeMB.toFixed(1)}MB → ${newSizeMB.toFixed(1)}MB (${compressionRatio}% reduction)`);

                    resolve({
                        outputPath,
                        originalSize: metadata.fileSize,
                        newSize: newMetadata.fileSize,
                        compressionRatio: parseFloat(compressionRatio),
                        duration: newMetadata.duration,
                        resolution: `${newMetadata.video?.width}x${newMetadata.video?.height}`
                    });
                } catch (error) {
                    reject(error);
                }
            });

            ffmpeg.on('error', (error) => {
                reject(new Error(`Failed to spawn FFmpeg: ${error.message}`));
            });
        });
    }

    /**
     * Get job status
     * @param {string} jobId - Job ID
     * @returns {Object|null} Job status or null if not found
     */
    getJobStatus(jobId) {
        return this.processingJobs.get(jobId) || null;
    }

    /**
     * Clean up temporary files for a job
     * @param {string} jobId - Job ID
     */
    async cleanupJob(jobId) {
        const job = this.processingJobs.get(jobId);
        if (job?.outputDir) {
            try {
                await fs.rm(job.outputDir, { recursive: true, force: true });
                console.log(`🧹 Cleaned up job: ${jobId}`);
            } catch (error) {
                console.error(`❌ Failed to cleanup job ${jobId}:`, error.message);
            }
        }
        this.processingJobs.delete(jobId);
    }

    /**
     * Generate a thumbnail from video
     * @param {string} inputPath - Path to video
     * @param {string} outputPath - Path for thumbnail
     * @param {number} timestamp - Timestamp in seconds
     * @returns {Promise<string>} Path to thumbnail
     */
    async generateThumbnail(inputPath, outputPath, timestamp = 1) {
        return new Promise((resolve, reject) => {
            const args = [
                '-i', inputPath,
                '-ss', timestamp.toString(),
                '-vframes', '1',
                '-vf', 'scale=480:-1',
                '-q:v', '2',
                '-y',
                outputPath
            ];

            const ffmpeg = spawn(this.ffmpegPath, args);

            ffmpeg.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`Thumbnail generation failed with code ${code}`));
                    return;
                }
                resolve(outputPath);
            });

            ffmpeg.on('error', (error) => {
                reject(new Error(`Failed to generate thumbnail: ${error.message}`));
            });
        });
    }
}

// Export singleton instance getter and class
export { VideoProcessingService, QUALITY_PRESETS, COMPRESSION_THRESHOLDS };
export default VideoProcessingService;