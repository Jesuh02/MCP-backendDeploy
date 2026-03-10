/**
 * RAGSchemas — Joi schemas para validación de endpoints RAG.
 */

import Joi from 'joi';

export const ingestSchema = Joi.object({
    content: Joi.string().min(1).required(),
    metadata: Joi.object().optional(),
    courseId: Joi.number().integer().optional(),
});

export const searchSchema = Joi.object({
    query: Joi.string().min(1).required(),
    limit: Joi.number().integer().min(1).max(50).optional(),
    courseId: Joi.number().integer().optional(),
    threshold: Joi.number().min(0).max(1).optional(),
});

export const buildContextSchema = Joi.object({
    query: Joi.string().min(1).required(),
    courseId: Joi.number().integer().optional(),
    maxTokens: Joi.number().integer().optional(),
});

export default { ingestSchema, searchSchema, buildContextSchema };

