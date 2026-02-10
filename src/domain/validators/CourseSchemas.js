/**
 * Joi Validation Schemas — Courses
 */
import Joi from 'joi';

export const createCourseSchema = Joi.object({
    title: Joi.string().min(3).max(200).required(),
    description: Joi.string().max(5000).allow('').optional(),
    thumbnailUri: Joi.string().uri().allow(null, '').optional(),
    creatorUsername: Joi.string().required(),
    isFree: Joi.boolean().default(true),
    price: Joi.number().min(0).default(0),
    category: Joi.string().max(100).allow(null, '').optional(),
    level: Joi.string().valid('beginner', 'intermediate', 'advanced').allow(null).optional(),
    language: Joi.string().max(10).default('es'),
});

export const updateCourseSchema = Joi.object({
    title: Joi.string().min(3).max(200).optional(),
    description: Joi.string().max(5000).allow('').optional(),
    thumbnailUri: Joi.string().uri().allow(null, '').optional(),
    isFree: Joi.boolean().optional(),
    price: Joi.number().min(0).optional(),
    category: Joi.string().max(100).allow(null, '').optional(),
    level: Joi.string().valid('beginner', 'intermediate', 'advanced').allow(null).optional(),
    isPublished: Joi.boolean().optional(),
}).min(1);