/**
 * VideoProcessingSchemas — Joi schemas para validación de endpoints video processing.
 */

import Joi from 'joi';

export const analyzeVideoSchema = Joi.object({
    filePath: Joi.string().required(),
})
    .rename('path', 'filePath', { ignoreUndefined: true, override: true })
    .rename('videoPath', 'filePath', { ignoreUndefined: true, override: true });

export const processVideoSchema = Joi.object({
    inputPath: Joi.string().required(),
    qualities: Joi.array().items(Joi.string()).optional(),
    outputDir: Joi.string().optional(),
})
    .rename('filePath', 'inputPath', { ignoreUndefined: true, override: true })
    .rename('path', 'inputPath', { ignoreUndefined: true, override: true });

export const processFromUrlSchema = Joi.object({
    url: Joi.string().uri().required(),
    qualities: Joi.array().items(Joi.string()).optional(),
    outputDir: Joi.string().optional(),
})
    .rename('sourceUrl', 'url', { ignoreUndefined: true, override: true })
    .rename('videoUri', 'url', { ignoreUndefined: true, override: true })
    .rename('videoUriString', 'url', { ignoreUndefined: true, override: true })
    .rename('video_uri_string', 'url', { ignoreUndefined: true, override: true });
export default { analyzeVideoSchema, processVideoSchema, processFromUrlSchema };

