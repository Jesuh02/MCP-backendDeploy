/**
 * VideoProcessingController — Controlador HTTP para procesamiento de video.
 */

import { analyzeVideoSchema, processVideoSchema, processFromUrlSchema } from '../domain/VideoProcessingSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';

export class VideoProcessingController {
    constructor({ videoProcessingService }) {
        this.videoProcessingService = videoProcessingService;
    }

    analyze = async(req, res, next) => {
        try {
            const { error, value } = analyzeVideoSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const result = await this.videoProcessingService.analyze(value);
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    process = async(req, res, next) => {
        try {
            const { error, value } = processVideoSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.videoProcessingService.process(value);
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    processFromUrl = async(req, res, next) => {
        try {
            const { error, value } = processFromUrlSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const result = await this.videoProcessingService.processFromUrl(value);
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    getJobStatus = async(req, res, next) => {
        try {
            const { jobId } = req.params;
            if (!jobId) return next(new ValidationError('jobId es requerido'));

            const result = await this.videoProcessingService.getJobStatus(jobId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getQualityPresets = async(req, res, next) => {
        try {
            const result = this.videoProcessingService.getQualityPresets();
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default VideoProcessingController;

