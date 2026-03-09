import { Router } from 'express';
import { parsePagination, buildPaginatedResponse } from '../../../shared/pagination.js';

export function publicRoutes({ videoService, courseService, storageService }) {
    const router = Router();

    router.get('/videos', async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await videoService.list(pg);
            if (result.isFail()) return next(result.getError());

            const { videos, total } = result.getValue();
            res.json({ success: true, ...buildPaginatedResponse(videos, total, pg.page, pg.pageSize) });
        } catch (err) {
            next(err);
        }
    });

    router.get('/videos/:id', async(req, res, next) => {
        try {
            const result = await videoService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) {
            next(err);
        }
    });

    router.get('/videos/course/:courseId', async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await videoService.findByCourse(parseInt(req.params.courseId), pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) {
            next(err);
        }
    });

    router.get('/courses', async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await courseService.list(pg);
            if (result.isFail()) return next(result.getError());
            const { courses, total } = result.getValue();
            res.json({ success: true, ...buildPaginatedResponse(courses, total, pg.page, pg.pageSize) });
        } catch (err) {
            next(err);
        }
    });

    router.get('/files/*', async (req, res, next) => {
        try {
            const key = req.params[0];
            if (!key || key.length < 2) {
                return res.status(400).json({ success: false, error: 'key requerido' });
            }

            if (!storageService) {
                return res.status(503).json({ success: false, error: 'Storage no disponible' });
            }

            const result = await storageService.streamFile(key);
            if (result.isFail()) return next(result.getError());

            const { body, contentType, contentLength } = result.getValue();

            res.setHeader('Content-Type', contentType);
            if (contentLength) res.setHeader('Content-Length', contentLength);

            const filename = key.split('/').pop();
            res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);

            body.pipe(res);
        } catch (err) {
            next(err);
        }
    });

    return router;
}

export default publicRoutes;


