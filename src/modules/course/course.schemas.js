/**
 * Joi Validation Schemas — Courses
 */
import Joi from 'joi';

const courseBaseUpdateSchema = {
    title: Joi.string().min(3).max(200).optional(),
    description: Joi.string().max(5000).allow('').optional(),
    thumbnailUri: Joi.string().uri().allow(null, '').optional(),
    isActive: Joi.boolean().optional(),
    isFree: Joi.boolean().optional(),
    price: Joi.number().min(0).optional(),
    category: Joi.string().max(100).allow(null, '').optional(),
    level: Joi.string().valid('beginner', 'intermediate', 'advanced').allow(null).optional(),
    isPublished: Joi.boolean().optional(),
    deadline: Joi.date().iso().allow(null).optional(),
};

export const createCourseSchema = Joi.object({
    title: Joi.string().min(3).max(200).required(),
    description: Joi.string().max(5000).allow('').optional(),
    thumbnailUri: Joi.string().uri().allow(null, '').optional(),
    creatorUsername: Joi.string().required(),
    isActive: Joi.boolean().default(true),
    isFree: Joi.boolean().default(true),
    price: Joi.number().min(0).default(0),
    category: Joi.string().max(100).allow(null, '').optional(),
    level: Joi.string().valid('beginner', 'intermediate', 'advanced').allow(null).optional(),
    language: Joi.string().max(10).default('es'),
    deadline: Joi.date().iso().allow(null).optional(),
})
    .rename('is_active', 'isActive', { ignoreUndefined: true, override: true });

export const updateCourseSchema = Joi.object(courseBaseUpdateSchema)
    .rename('thumbnail_uri', 'thumbnailUri', { ignoreUndefined: true, override: true })
    .rename('is_active', 'isActive', { ignoreUndefined: true, override: true })
    .rename('is_premium', 'isFree', { ignoreUndefined: true, override: true })
    .rename('is_published', 'isPublished', { ignoreUndefined: true, override: true })
    .custom((obj) => {
        if (typeof obj.isFree === 'boolean') obj.isFree = !obj.isFree;
        return obj;
    })
    .min(1);