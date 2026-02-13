/**
 * videoStreamingRoutes — Rutas v1 para streaming optimizado de video.
 *
 * Estas rutas están diseñadas para velocidad máxima:
 *   - URLs pre-firmadas en batch con caché en memoria
 *   - Headers de Cache-Control para reducir roundtrips
 *   - Feed optimizado que retorna videos listos para reproducción instantánea
 *
 * Hexagonal: Las rutas solo mapean HTTP → controller;
 * toda la lógica de negocio vive en VideoStreamingDomainService.
 */

import { Router } from 'express';

export function videoStreamingRoutes({ videoStreamingController }) {
    const router = Router();

    /**
     * GET /api/v1/streaming/feed
     * Feed optimizado con URLs pre-firmadas y cache. Requiere auth.
     */
    router.get('/feed', videoStreamingController.feed);

    /**
     * POST /api/v1/streaming/batch-sign
     * Firma en lote de URLs para videos adyacentes (pre-fetch).
     * Body: { videoIds: [1, 2, 3, ...] }
     */
    router.post('/batch-sign', videoStreamingController.batchSign);

    return router;
}

export default videoStreamingRoutes;
