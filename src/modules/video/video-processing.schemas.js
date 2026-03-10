/**
 * VideoProcessingSchemas — Joi schemas para validación de endpoints video processing.
 */

import Joi from 'joi';

export const analyzeVideoSchema = Joi.object({
    filePath: Joi.string().required(),
});

export const processVideoSchema = Joi.object({
    inputPath: Joi.string().required(),
    qualities: Joi.array().items(Joi.string()).optional(),
    outputDir: Joi.string().optional(),
});

export const processFromUrlSchema = Joi.object({
    url: Joi.string().uri().required(),
    qualities: Joi.array().items(Joi.string()).optional(),
    outputDir: Joi.string().optional(),
});
export default { analyzeVideoSchema, processVideoSchema, processFromUrlSchema };

