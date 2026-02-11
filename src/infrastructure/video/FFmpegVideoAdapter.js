/**
 * FFmpegVideoAdapter — Adaptador de infraestructura que implementa IVideoProcessingPort.
 *
 * Envuelve la lógica de FFmpeg que antes vivía en services/VideoProcessingService.js.
 * El dominio solo conoce IVideoProcessingPort; este adaptador es intercambiable.
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

const QUALITY_PRESETS = {
    LOW: { name: '360p', width: 640, height: 360, videoBitrate: '800k', audioBitrate: '96k', bandwidth: 800000 },
    MEDIUM: { name: '480p', width: 854, height: 480, videoBitrate: '1400k', audioBitrate: '128k', bandwidth: 1400000 },
    HIGH: { name: '720p', width: 1280, height: 720, videoBitrate: '2800k', audioBitrate: '128k', bandwidth: 2800000 },
    FULL_HD: { name: '1080p', width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k', bandwidth: 5000000 },
};

export class FFmpegVideoAdapter extends EventEmitter {
    constructor() {
            super();
            this.ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
            this.ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
            this.jobs = new Map();
            this._available = null;
        }
        // ─── IVideoProcessingPort ────────────────────────────────

    /** @returns {boolean} Sincrónico — usa cache tras primera comprobación */
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
     * Analiza un video y retorna metadata.
     * @param {string} filePath
     * @returns {Promise<Object>}
     */
    async analyze(filePath) {
        const args = [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            filePath,
        ];
        return new Promise((resolve, reject) => {
            let output = '';
            const proc = spawn(this.ffprobePath, args);
            proc.stdout.on('data', (d) => { output += d; });
            proc.stderr.on('data', () => {}); // ignorar stderr
            proc.on('error', reject);
            proc.on('close', (code) => {
                if (code !== 0) return reject(new Error(`FFprobe falló con código ${code}`));
                try {
                    const data = JSON.parse(output);
                    const videoStream = data.streams?.find((s) => s.codec_type === 'video');
                    const fps = videoStream?.r_frame_rate ?
                        (() => { const [n, d] = videoStream.r_frame_rate.split('/'); return d ? n / d : parseFloat(n); })() :
                        0;
                    resolve({
                        duration: parseFloat(data.format?.duration || 0),
                        width: videoStream?.width || 0,
                        height: videoStream?.height || 0,
                        fps,
                        bitrate: parseInt(data.format?.bit_rate || 0, 10),
                        needsCompression: (parseInt(data.format?.size || 0, 10) / 1024 / 1024) > 100,
                    });
                } catch (e) {
                    reject(new Error(`Error parseando output FFprobe: ${e.message}`));
                }
            });
        });
    }

    /**
     * Procesa un video: compresión y/o transcodificación.
     * @param {string} inputPath
     * @param {{ qualities?: string[], outputDir?: string }} options
     * @returns {Promise<{ jobId: string, outputPath: string }>}
     */
    async process(inputPath, options = {}) {
        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const outputDir = options.outputDir || path.join(os.tmpdir(), jobId);
        await fs.mkdir(outputDir, { recursive: true });

        this.jobs.set(jobId, { status: 'processing', progress: 0, startedAt: Date.now() });

        try {
            const outputPath = path.join(outputDir, 'output.mp4');
            await this._runFFmpeg(inputPath, outputPath);
            this.jobs.set(jobId, { status: 'completed', progress: 100, outputPath });
            return { jobId, outputPath };
        } catch (err) {
            this.jobs.set(jobId, { status: 'failed', progress: 0, error: err.message });
            throw err;
        }
    }

    /**
     * Descarga video desde URL, lo procesa localmente.
     * @param {string} url
     * @param {Object} options
     * @returns {Promise<Object>}
     */
    async processFromUrl(url, options = {}) {
        const tmpPath = path.join(os.tmpdir(), `download_${Date.now()}.mp4`);
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Descarga fallida: ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            await fs.writeFile(tmpPath, buffer);
            return await this.process(tmpPath, options);
        } finally {
            await fs.unlink(tmpPath).catch(() => {});
        }
    }

    /**
     * Retorna el estado de un job.
     * @param {string} jobId
     * @returns {Promise<Object>}
     */
    async getJobStatus(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) throw new Error(`Job ${jobId} no encontrado`);
        return job;
    }

    /** @returns {Object} */
    getQualityPresets() {
        return QUALITY_PRESETS;
    }

    // ─── Private ─────────────────────────────────────────────

    /**
     * Ejecuta FFmpeg con parámetros base de compresión.
     * @private
     */
    _runFFmpeg(input, output) {
        const args = [
            '-i', input,
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-profile:v', 'baseline',
            '-movflags', '+faststart',
            '-c:a', 'aac',
            '-y', output,
        ];
        return new Promise((resolve, reject) => {
            const proc = spawn(this.ffmpegPath, args);
            proc.stderr.on('data', () => {}); // FFmpeg escribe progreso en stderr
            proc.on('error', reject);
            proc.on('close', (code) => {
                code === 0 ? resolve() : reject(new Error(`FFmpeg falló con código ${code}`));
            });
        });
    }
}

export default FFmpegVideoAdapter;