/**
 * Joi Validation Schemas — Video
 */
import Joi from 'joi';

export const createVideoSchema = Joi.object({
    title: Joi.string().min(1).max(300).required(),
    description: Joi.string().max(5000).allow('').optional(),
    videoUri: Joi.string().uri().allow(null, '').optional(),
    thumbnailUri: Joi.string().uri().allow(null, '').optional(),
    duration: Joi.number().min(0).allow(null).optional(),
    username: Joi.string().optional(),
    courseId: Joi.number().integer().allow(null).optional(),
    isPaid: Joi.boolean().optional(),
    price: Joi.number().min(0).allow(null).optional(),
    type: Joi.string().valid('video', 'short', 'live').default('video'),
    hlsUrl: Joi.string().uri().allow(null, '').optional(),
})
    .rename('video_uri_string', 'videoUri', { ignoreUndefined: true, override: true })
    .rename('videoUriString', 'videoUri', { ignoreUndefined: true, override: true })
    .rename('thumbnail_uri', 'thumbnailUri', { ignoreUndefined: true, override: true })
    .rename('course_id', 'courseId', { ignoreUndefined: true, override: true })
    .rename('is_paid', 'isPaid', { ignoreUndefined: true, override: true });

export const uploadVideoMetadataSchema = Joi.object({
    title: Joi.string().min(1).max(300).required(),
    description: Joi.string().max(5000).allow('').optional(),
    isPaid: Joi.boolean().truthy('true').truthy('1').falsy('false').falsy('0').optional(),
    price: Joi.number().min(0).allow(null).optional(),
    courseId: Joi.number().integer().allow(null).optional(),
    timestamp: Joi.number().integer().min(0).optional(),
})
    .rename('is_paid', 'isPaid', { ignoreUndefined: true, override: true })
    .rename('course_id', 'courseId', { ignoreUndefined: true, override: true });

export const updateVideoSchema = Joi.object({
    title: Joi.string().min(1).max(300).optional(),
    description: Joi.string().max(5000).allow('').optional(),
    thumbnailUri: Joi.string().uri().allow(null, '').optional(),
    duration: Joi.number().min(0).allow(null).optional(),
    type: Joi.string().valid('video', 'short', 'live').optional(),
    hlsUrl: Joi.string().uri().allow(null, '').optional(),
    isPaid: Joi.boolean().optional(),
    isPublished: Joi.boolean().optional(),
})
    .rename('thumbnail_uri', 'thumbnailUri', { ignoreUndefined: true, override: true })
    .rename('is_paid', 'isPaid', { ignoreUndefined: true, override: true })
    .rename('is_published', 'isPublished', { ignoreUndefined: true, override: true })
    .min(1);

