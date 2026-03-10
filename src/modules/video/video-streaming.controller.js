/**
 * VideoStreamingController — Controller for optimized video streaming endpoints.
 *
 * SRP: Only handles HTTP request/response mapping for streaming use cases.
 * DIP: Depends on VideoStreamingDomainService abstraction.
 */

import { parsePagination, buildPaginatedResponse } from '../../shared/pagination.js';

export class VideoStreamingController {
    /**
     * @param {{ videoStreamingService: import('../../../domain/services/VideoStreamingDomainService.js').VideoStreamingDomainService }} deps
     */
    constructor({ videoStreamingService }) {
        this.streamingService = videoStreamingService;
    }

    /**
     * GET /api/v1/streaming/feed
     *
     * Returns an optimized video feed with pre-signed URLs and
     * aggressive cache headers. Designed for instant mobile playback.
     *
     * Response includes `signedAt` and `ttlSeconds` so the client
     * knows when to refresh URLs.
     */
    feed = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.streamingService.getOptimizedFeed(pg);
            if (result.isFail()) return next(result.getError());

            const { videos, total, signedAt, ttlSeconds } = result.getValue();
            // Cache-Control: client can reuse this response for 5 minutes,
            // stale-while-revalidate allows background refresh for 10 min more.
            res.set('Cache-Control', 'private, max-age=300, stale-while-revalidate=600');
            res.set('X-Signed-At', String(signedAt));
            res.set('X-URL-TTL', String(ttlSeconds));
            res.json({
                success: true,
                ...buildPaginatedResponse(videos, total, pg.page, pg.pageSize),
                signedAt,
                ttlSeconds,
            });
        } catch (err) {
            next(err);
        }
    };

    /**
     * POST /api/v1/streaming/batch-sign
     *
     * Batch-signs URLs for specific video IDs with in-memory caching.
     * Body: { videoIds: [1, 2, 3] }
     */
    batchSign = async(req, res, next) => {
            try {
                const { videoIds } = req.body;
                if (!Array.isArray(videoIds) || videoIds.length === 0) {
                    return res.status(400).json({ success: false, error: 'videoIds array is required' });
                }

                const result = await this.streamingService.batchSignUrls(videoIds);
            if (result.isFail()) return next(result.getError());

            res.set('Cache-Control', 'private, max-age=300');
            res.json({ success: true, data: result.getValue() });
        } catch (err) {
            next(err);
        }
    };
}

export default VideoStreamingController;


