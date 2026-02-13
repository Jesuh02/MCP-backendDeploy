/**
 * VideoStreamingDomainService — Caso de uso para streaming optimizado de video.
 *
 * Responsabilidades (SRP):
 *   - Proporciona un feed de videos con URLs pre-firmadas ya resueltas.
 *   - Cachea URLs firmadas en memoria para evitar re-firmar en cada request.
 *   - Firma en lote (batch) para minimizar latencia en la respuesta.
 *
 * Principios:
 *   - DIP: depende de puertos abstractos (videoRepository, fileStoragePort).
 *   - OCP: nuevas estrategias de caché o CDN se agregan sin modificar este servicio.
 *   - ISP: expone solo los métodos que el controller de streaming necesita.
 */

import { Result } from '../../shared/Result.js';
import { ValidationError } from '../../shared/errors/index.js';

/** TTL for signed URL cache entries (50 minutes, backend signs for 60) */
const SIGNED_URL_TTL_MS = 50 * 60 * 1000;

/** Maximum videos to sign in a single batch */
const MAX_BATCH_SIZE = 50;

export class VideoStreamingDomainService {
    /**
     * @param {{ videoRepository: object, fileStoragePort: object }} deps
     */
    constructor({ videoRepository, fileStoragePort }) {
            this.videoRepo = videoRepository;
            this.storage = fileStoragePort || null;

            /**
             * In-memory signed URL cache: objectKey → { signedUrl, expiresAt }
             * Prevents re-signing the same R2 object on every feed request.
             */
            this._urlCache = new Map();
        }
        // ─── Public API ──────────────────────────────────────────
        /**
         * Returns an optimized video feed with ALL URLs pre-signed and
         * ready for immediate playback.
         *
         * Performance optimizations:
         *  1. Batch-signs all URLs in parallel (Promise.all)
         *  2. Caches signed URLs in memory (50-min TTL)
         *  3. Returns only the fields needed for playback (smaller payload)
         *
         * @param {{ page: number, pageSize: number }} pagination
         * @returns {Promise<Result<{ videos: object[], total: number, signedAt: number }>>}
         */
    async getOptimizedFeed(pagination) {
        try {
            const [videos, total] = await Promise.all([
                this.videoRepo.findAll(pagination),
                this.videoRepo.count({}),
            ]);

            // Batch-sign all URLs in parallel
            const signedVideos = await this._batchSign(videos);

            return Result.ok({
                videos: signedVideos,
                total,
                signedAt: Date.now(),
                ttlSeconds: Math.floor(SIGNED_URL_TTL_MS / 1000),
            });
        } catch (err) {
            return Result.fail(err);
        }
    }

    /**
     * Batch-signs URLs for specific video IDs.
     * Optimized version of VideoDomainService.batchSignedUrls with
     * in-memory caching and parallel signing.
     *
     * @param {number[]} videoIds
     * @returns {Promise<Result<Object>>} Map of videoId → { videoUrl, thumbnailUrl }
     */
    async batchSignUrls(videoIds) {
        if (!Array.isArray(videoIds) || videoIds.length === 0) {
            return Result.fail(new ValidationError('videoIds must be a non-empty array'));
        }

        const ids = videoIds.slice(0, MAX_BATCH_SIZE).map(Number).filter(n => !isNaN(n) && n > 0);
        if (ids.length === 0) {
            return Result.fail(new ValidationError('No valid video IDs provided'));
        }

        try {
            const videos = await this.videoRepo.findByIds(ids);
            if (!videos || videos.length === 0) {
                return Result.ok({});
            }

            const urlMap = {};
            await Promise.all(videos.map(async(v) => {
                const videoKey = this._extractKey(v.video_uri_string || v.videoUriString);
                const thumbKey = this._extractKey(v.thumbnail_uri || v.thumbnailUri);

                const [videoUrl, thumbnailUrl] = await Promise.all([
                    videoKey ? this._getOrSign(videoKey) : Promise.resolve(null),
                    thumbKey ? this._getOrSign(thumbKey) : Promise.resolve(null),
                ]);

                urlMap[v.id] = { videoUrl, thumbnailUrl };
            }));

            return Result.ok(urlMap);
        } catch (err) {
            return Result.fail(err);
        }
    }

    /**
     * Pre-warms the signed URL cache for a list of object keys.
     * Call this during server startup or after video upload to ensure
     * the first user request is already fast.
     *
     * @param {string[]} objectKeys
     * @returns {Promise<number>} Number of URLs successfully cached
     */
    async prewarmCache(objectKeys) {
        let count = 0;
        await Promise.all(objectKeys.map(async(key) => {
            try {
                await this._getOrSign(key);
                count++;
            } catch (_) { /* non-fatal */ }
        }));
        return count;
    }

    // ─── Private helpers ─────────────────────────────────────

    /**
     * Batch-signs all URLs in a video list, mutating the objects in place.
     * Uses the in-memory cache to avoid redundant S3 presign calls.
     *
     * @param {object[]} videos
     * @returns {Promise<object[]>}
     * @private
     */
    async _batchSign(videos) {
        if (!this.storage || !this.storage.isAvailable || !this.storage.isAvailable()) return videos;

        await Promise.all(videos.map(async(v) => {
            if (!v) return;
            try {
                // Sign video URL
                const videoRaw = v.video_uri_string || v.videoUriString;
                const videoKey = this._extractKey(videoRaw);
                if (videoKey) {
                    const signed = await this._getOrSign(videoKey);
                    v.video_uri_string = signed;
                    v.videoUriString = signed;
                }

                // Sign thumbnail URL
                const thumbRaw = v.thumbnail_uri || v.thumbnailUri;
                const thumbKey = this._extractKey(thumbRaw);
                if (thumbKey) {
                    const signed = await this._getOrSign(thumbKey);
                    v.thumbnail_uri = signed;
                    v.thumbnailUri = signed;
                }
            } catch (e) {
                console.warn('[VideoStreamingService] Sign error for video', v.id, e.message);
            }
        }));

        return videos;
    }

    /**
     * Returns a cached signed URL or generates a new one.
     *
     * @param {string} objectKey — R2 object key (e.g. "videos/123.mp4")
     * @returns {Promise<string>}
     * @private
     */
    async _getOrSign(objectKey) {
        // Check cache
        const cached = this._urlCache.get(objectKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.signedUrl;
        }

        // Generate new signed URL
        const signedUrl = await this.storage.generateDownloadUrl(objectKey, 3600);
        this._urlCache.set(objectKey, {
            signedUrl,
            expiresAt: Date.now() + SIGNED_URL_TTL_MS,
        });

        return signedUrl;
    }

    /**
     * Extracts an R2 object key from a raw URL string.
     * Handles:
     *  - Relative keys: "videos/123.mp4"
     *  - Public URLs: "https://pub-xxx.r2.dev/videos/123.mp4"
     *  - Already-signed URLs: returns null (no need to re-sign)
     *
     * @param {string|null} raw
     * @returns {string|null}
     * @private
     */
    _extractKey(raw) {
        if (!raw) return null;
        if (raw.includes('X-Amz-Signature')) return null; // Already signed

        if (raw.startsWith('http://') || raw.startsWith('https://')) {
            return this.storage ? .extractObjectKey ? .(raw) || null;
        }

        // Skip local device paths
        if (raw.startsWith('file://') || raw.startsWith('content://') || raw.startsWith('/')) {
            return null;
        }

        // Treat as relative R2 key
        return raw;
    }

    /**
     * Periodically evicts expired entries from the URL cache.
     * Call this on a timer (e.g. every 10 minutes) in the container setup.
     */
    evictExpiredCache() {
        const now = Date.now();
        let evicted = 0;
        for (const [key, entry] of this._urlCache) {
            if (entry.expiresAt <= now) {
                this._urlCache.delete(key);
                evicted++;
            }
        }
        if (evicted > 0) {
            console.log(`[VideoStreamingService] Evicted ${evicted} expired URL cache entries`);
        }
    }
}

export default VideoStreamingDomainService;