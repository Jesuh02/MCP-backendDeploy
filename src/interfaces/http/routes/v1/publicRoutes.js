/**
 * publicRoutes — Rutas públicas v1 que NO requieren autenticación.
 *
 * Hexagonal: Estas rutas exponen un puerto de lectura pública (browsing)
 * para que cualquier cliente (incluso no autenticado) pueda descubrir contenido.
 * Las operaciones de escritura siguen protegidas tras authMiddleware.
 */

import { Router } from 'express';
import { parsePagination, buildPaginatedResponse } from '../../../../shared/pagination.js';

export function publicRoutes({ videoService, courseService }) {
    const router = Router();

    /**
     * GET /api/v1/public/videos
     * Feed público de videos con paginación y URLs pre-firmadas.
     */
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

    /**
     * GET /api/v1/public/videos/:id
     * Detalle de un video específico (público).
     */
    router.get('/videos/:id', async(req, res, next) => {
        try {
            const result = await videoService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) {
            next(err);
        }
    });

    /**
     * GET /api/v1/public/videos/course/:courseId
     * Videos de un curso específico (público).
     */
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

    /**
     * GET /api/v1/public/courses
     * Catálogo público de cursos.
     */
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

    return router;
}

export default publicRoutes;


