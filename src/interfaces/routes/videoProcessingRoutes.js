/**
 * videoProcessingRoutes.js
 * REST API routes for video processing operations
 * 
 * Responsibilities (Single Responsibility Principle):
 * - Handle HTTP requests for video processing
 * - Validate input parameters
 * - Delegate processing to VideoProcessingService
 * 
 * @description Endpoints for video compression, HLS transcoding, and status checking
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { VideoProcessingService } from '../../services/VideoProcessingService.js';
import { R2StorageService } from '../../services/R2StorageService.js';

const router = express.Router();

// Configure multer for video uploads
const storage = multer.diskStorage({
    destination: async(req, file, cb) => {
        const uploadDir = path.join(os.tmpdir(), 'coursev-uploads');
        try {
            await fs.mkdir(uploadDir, { recursive: true });
            cb(null, uploadDir);
        } catch (error) {
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        cb(null, `video_${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 500 * 1024 * 1024 // 500 MB max
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/x-matroska'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: ${allowedTypes.join(', ')}`));
        }
    }
});

// ============================================================
// ROUTES
// ============================================================

/**
 * POST /video/analyze
 * Analyze video to determine if compression is needed
 */
router.post('/analyze', upload.single('video'), async(req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No video file provided'
            });
        }

        const videoService = VideoProcessingService.getInstance();
        const { isScreenRecording, isFromMobile } = req.body;

        console.log('🎬 [FFmpeg Analysis] Starting video analysis...');
        console.log(`   📁 File: ${req.file.originalname}`);
        console.log(`   📏 Size: ${(req.file.size / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`   🔧 FFmpeg path check: ${process.env.FFMPEG_PATH || 'system default'}`);
        
        // Get video metadata
        const startTime = Date.now();
        const metadata = await videoService.getVideoMetadata(req.file.path);
        const analysisTime = Date.now() - startTime;
        
        console.log(`✅ [FFmpeg Analysis] Completed in ${analysisTime}ms`);
        console.log(`   📊 Resolution: ${metadata.video?.width}x${metadata.video?.height}`);
        console.log(`   ⏱️  Duration: ${metadata.duration}s`);
        console.log(`   📈 Bitrate: ${(metadata.bitrate / 1000).toFixed(0)}kbps`);

        // Determine if compression is needed
        const compressionDecision = videoService.shouldCompress(metadata, {
            isScreenRecording: isScreenRecording === 'true',
            isFromMobile: isFromMobile !== 'false' // Default to true
        });
        
        console.log('🤔 [Compression Decision]');
        console.log(`   Should Compress: ${compressionDecision.shouldCompress ? '✅ YES' : '❌ NO'}`);
        console.log(`   Reason: ${compressionDecision.reason}`);
        if (compressionDecision.shouldCompress) {
            console.log(`   💾 Estimated savings: ${compressionDecision.estimatedSavings}`);
        }

        // Get target qualities if HLS is recommended
        const targetQualities = videoService.getTargetQualities(metadata);

        // Cleanup uploaded file
        await fs.unlink(req.file.path).catch(() => {});

        res.json({
            success: true,
            metadata: {
                duration: metadata.duration,
                fileSize: metadata.fileSize,
                fileSizeMB: (metadata.fileSize / (1024 * 1024)).toFixed(2),
                resolution: metadata.video ? `${metadata.video.width}x${metadata.video.height}` : null,
                fps: metadata.video?.fps,
                bitrate: metadata.bitrate,
                videoCodec: metadata.video?.codec,
                audioCodec: metadata.audio?.codec
            },
            compression: compressionDecision,
            recommendedQualities: targetQualities.map(q => q.name)
        });

    } catch (error) {
        console.error('❌ Video analysis error:', error);

        // Cleanup on error
        if (req.file?.path) {
            await fs.unlink(req.file.path).catch(() => {});
        }

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /video/process
 * Process video for adaptive streaming (HLS) or simple compression
 */
router.post('/process', upload.single('video'), async(req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No video file provided'
            });
        }

        const videoService = VideoProcessingService.getInstance();
        const r2Service = R2StorageService.getInstance();

        const {
            videoId,
            username,
            processType = 'auto', // 'auto', 'hls', 'compress'
            isScreenRecording,
            isFromMobile
        } = req.body;

        if (!videoId || !username) {
            await fs.unlink(req.file.path).catch(() => {});
            return res.status(400).json({
                success: false,
                error: 'videoId and username are required'
            });
        }

        console.log(`📹 Processing video ${videoId} for user ${username}`);

        // Get metadata and compression decision
        const metadata = await videoService.getVideoMetadata(req.file.path);
        const compressionDecision = videoService.shouldCompress(metadata, {
            isScreenRecording: isScreenRecording === 'true',
            isFromMobile: isFromMobile !== 'false'
        });

        // Determine processing type
        let actualProcessType = processType;
        if (processType === 'auto') {
            actualProcessType = compressionDecision.shouldCompress ? 'hls' : 'passthrough';
        }

        const outputDir = path.join(os.tmpdir(), `coursev-output-${videoId}`);
        let result;

        if (actualProcessType === 'hls') {
            // Generate HLS adaptive streaming
            console.log('\n🎬 [FFmpeg HLS] Starting adaptive streaming generation...');
            console.log(`   🆔 Video ID: ${videoId}`);
            console.log(`   👤 User: ${username}`);
            console.log(`   📊 Source: ${metadata.video?.width}x${metadata.video?.height} @ ${(metadata.bitrate / 1000).toFixed(0)}kbps`);
            
            const hlsStartTime = Date.now();
            result = await videoService.transcodeToHLS(req.file.path, outputDir);
            const hlsTime = Date.now() - hlsStartTime;
            
            console.log(`✅ [FFmpeg HLS] Completed in ${(hlsTime / 1000).toFixed(1)}s`);
            console.log(`   📺 Generated qualities: ${result.qualities.map(q => q.quality).join(', ')}`);
            console.log(`   📁 Total variants: ${result.qualities.length}`);

            // Upload all files to R2
            const baseKey = `videos/${username}/${videoId}/hls`;
            const uploadedFiles = [];

            // Upload master playlist
            const masterContent = await fs.readFile(result.masterPlaylist, 'utf8');
            const masterUrl = await r2Service.uploadFile(
                masterContent,
                `${baseKey}/master.m3u8`,
                'application/vnd.apple.mpegurl'
            );
            uploadedFiles.push({ type: 'master', url: masterUrl });

            // Upload each quality variant
            for (const variant of result.qualities) {
                const qualityDir = path.join(outputDir, variant.quality);
                const files = await fs.readdir(qualityDir);

                for (const file of files) {
                    const filePath = path.join(qualityDir, file);
                    const fileContent = await fs.readFile(filePath);
                    const contentType = file.endsWith('.m3u8') ?
                        'application/vnd.apple.mpegurl' :
                        'video/MP2T';

                    const fileUrl = await r2Service.uploadFile(
                        fileContent,
                        `${baseKey}/${variant.quality}/${file}`,
                        contentType
                    );
                    uploadedFiles.push({
                        type: 'segment',
                        quality: variant.quality,
                        file,
                        url: fileUrl
                    });
                }
            }

            result = {
                type: 'hls',
                masterPlaylistUrl: masterUrl,
                qualities: result.qualities.map(q => q.quality),
                filesUploaded: uploadedFiles.length
            };

        } else if (actualProcessType === 'compress') {
            // Simple compression to 720p
            console.log('\n🗜️ [FFmpeg Compression] Starting video compression...');
            console.log(`   🆔 Video ID: ${videoId}`);
            console.log(`   📊 Original: ${(metadata.fileSize / (1024 * 1024)).toFixed(2)} MB`);

            const outputPath = path.join(outputDir, 'compressed.mp4');
            await fs.mkdir(outputDir, { recursive: true });

            const compressStartTime = Date.now();
            const compressionResult = await videoService.compressVideo(req.file.path, outputPath);
            const compressTime = Date.now() - compressStartTime;
            
            console.log(`✅ [FFmpeg Compression] Completed in ${(compressTime / 1000).toFixed(1)}s`);
            console.log(`   💾 Size reduced: ${(compressionResult.originalSize / (1024 * 1024)).toFixed(2)} MB → ${(compressionResult.newSize / (1024 * 1024)).toFixed(2)} MB`);
            console.log(`   📉 Compression ratio: ${compressionResult.compressionRatio}`);

            // Upload to R2
            const compressedContent = await fs.readFile(outputPath);
            const compressedUrl = await r2Service.uploadFile(
                compressedContent,
                `videos/${username}/${videoId}/video.mp4`,
                'video/mp4'
            );

            result = {
                type: 'compressed',
                url: compressedUrl,
                originalSize: compressionResult.originalSize,
                newSize: compressionResult.newSize,
                compressionRatio: compressionResult.compressionRatio
            };

        } else {
            // Passthrough - upload original
            console.log(`📤 Uploading original video ${videoId}...`);

            const originalContent = await fs.readFile(req.file.path);
            const originalUrl = await r2Service.uploadFile(
                originalContent,
                `videos/${username}/${videoId}/video.mp4`,
                'video/mp4'
            );

            result = {
                type: 'passthrough',
                url: originalUrl,
                size: metadata.fileSize
            };
        }

        // Cleanup temp files
        await fs.unlink(req.file.path).catch(() => {});
        await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});

        console.log(`✅ Video ${videoId} processed successfully`);

        res.json({
            success: true,
            videoId,
            processing: result,
            metadata: {
                duration: metadata.duration,
                originalSize: metadata.fileSize,
                resolution: metadata.video ? `${metadata.video.width}x${metadata.video.height}` : null
            }
        });

    } catch (error) {
        console.error('❌ Video processing error:', error);

        // Cleanup on error
        if (req.file?.path) {
            await fs.unlink(req.file.path).catch(() => {});
        }

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /video/process-url
 * Process video from URL (for already uploaded videos)
 */
router.post('/process-url', async(req, res) => {
    try {
        const { videoUrl, videoId, username, processType = 'hls' } = req.body;

        if (!videoUrl || !videoId || !username) {
            return res.status(400).json({
                success: false,
                error: 'videoUrl, videoId, and username are required'
            });
        }

        const videoService = VideoProcessingService.getInstance();
        const r2Service = R2StorageService.getInstance();

        // Download video from URL
        console.log(`📥 Downloading video from ${videoUrl}...`);

        const response = await fetch(videoUrl);
        if (!response.ok) {
            throw new Error(`Failed to download video: ${response.status}`);
        }

        const tempDir = path.join(os.tmpdir(), `coursev-download-${videoId}`);
        await fs.mkdir(tempDir, { recursive: true });
        const tempPath = path.join(tempDir, 'input.mp4');

        const arrayBuffer = await response.arrayBuffer();
        await fs.writeFile(tempPath, Buffer.from(arrayBuffer));

        // Get metadata
        const metadata = await videoService.getVideoMetadata(tempPath);

        // Process based on type
        const outputDir = path.join(os.tmpdir(), `coursev-output-${videoId}`);
        let result;

        if (processType === 'hls') {
            result = await videoService.transcodeToHLS(tempPath, outputDir);

            // Upload to R2
            const baseKey = `videos/${username}/${videoId}/hls`;

            const masterContent = await fs.readFile(result.masterPlaylist, 'utf8');
            const masterUrl = await r2Service.uploadFile(
                masterContent,
                `${baseKey}/master.m3u8`,
                'application/vnd.apple.mpegurl'
            );

            for (const variant of result.qualities) {
                const qualityDir = path.join(outputDir, variant.quality);
                const files = await fs.readdir(qualityDir);

                for (const file of files) {
                    const filePath = path.join(qualityDir, file);
                    const fileContent = await fs.readFile(filePath);
                    const contentType = file.endsWith('.m3u8') ?
                        'application/vnd.apple.mpegurl' :
                        'video/MP2T';

                    await r2Service.uploadFile(
                        fileContent,
                        `${baseKey}/${variant.quality}/${file}`,
                        contentType
                    );
                }
            }

            result = {
                type: 'hls',
                masterPlaylistUrl: masterUrl,
                qualities: result.qualities.map(q => q.quality)
            };
        }

        // Cleanup
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});

        res.json({
            success: true,
            videoId,
            processing: result,
            metadata: {
                duration: metadata.duration,
                resolution: metadata.video ? `${metadata.video.width}x${metadata.video.height}` : null
            }
        });

    } catch (error) {
        console.error('❌ Video URL processing error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /video/status/:jobId
 * Get processing job status
 */
router.get('/status/:jobId', (req, res) => {
    const videoService = VideoProcessingService.getInstance();
    const status = videoService.getJobStatus(req.params.jobId);

    if (!status) {
        return res.status(404).json({
            success: false,
            error: 'Job not found'
        });
    }

    res.json({
        success: true,
        job: status
    });
});

/**
 * GET /video/qualities
 * Get available quality presets
 */
router.get('/qualities', (req, res) => {
    res.json({
        success: true,
        qualities: [
            { name: '360p', resolution: '640x360', bandwidth: 800000, description: 'Low - Poor connection' },
            { name: '480p', resolution: '854x480', bandwidth: 1400000, description: 'Medium - Average connection' },
            { name: '720p', resolution: '1280x720', bandwidth: 2800000, description: 'High - Good connection' },
            { name: '1080p', resolution: '1920x1080', bandwidth: 5000000, description: 'Full HD - Excellent connection' }
        ],
        thresholds: {
            maxFileSizeMB: 100,
            maxResolutionHeight: 720,
            minDurationSeconds: 180
        }
    });
});

export default router;