import Joi from 'joi';

export const createSubjectSchema = Joi.object({
    id: Joi.any().strip().optional(),
    courseId: Joi.number().integer().optional(),
    course_id: Joi.number().integer().optional(),
    name: Joi.string().min(1).max(200).required(),
    description: Joi.string().max(2000).allow('').optional(),
    code: Joi.string().max(50).allow(null, '').optional(),
    thumbnailUrl: Joi.string().uri().allow(null, '').optional(),
    thumbnail_url: Joi.string().uri().allow(null, '').optional(),
    orderIndex: Joi.number().integer().min(0).default(0),
    order_index: Joi.number().integer().min(0).optional(),
    isActive: Joi.boolean().default(true),
    is_active: Joi.boolean().optional(),
    createdBy: Joi.number().integer().allow(null).optional(),
    created_by: Joi.number().integer().allow(null).optional(),
    created_at: Joi.any().strip().optional(),
    updated_at: Joi.any().strip().optional(),
}).custom((value) => {
    if (!value.courseId && value.course_id) value.courseId = value.course_id;
    if (!value.thumbnailUrl && value.thumbnail_url) value.thumbnailUrl = value.thumbnail_url;
    if (value.order_index !== undefined && value.orderIndex === undefined) value.orderIndex = value.order_index;
    if (value.is_active !== undefined && value.isActive === undefined) value.isActive = value.is_active;
    if (!value.createdBy && value.created_by) value.createdBy = value.created_by;
    delete value.course_id;
    delete value.thumbnail_url;
    delete value.order_index;
    delete value.is_active;
    delete value.created_by;
    return value;
});

export const updateSubjectSchema = Joi.object({
    id: Joi.any().strip().optional(),
    name: Joi.string().min(1).max(200).optional(),
    description: Joi.string().max(2000).allow('').optional(),
    code: Joi.string().max(50).allow(null, '').optional(),
    thumbnailUrl: Joi.string().uri().allow(null, '').optional(),
    thumbnail_url: Joi.string().uri().allow(null, '').optional(),
    orderIndex: Joi.number().integer().min(0).optional(),
    order_index: Joi.number().integer().min(0).optional(),
    isActive: Joi.boolean().optional(),
    is_active: Joi.boolean().optional(),
    updatedBy: Joi.number().integer().allow(null).optional(),
    updated_by: Joi.number().integer().allow(null).optional(),
    created_at: Joi.any().strip().optional(),
    updated_at: Joi.any().strip().optional(),
}).custom((value) => {
    if (!value.thumbnailUrl && value.thumbnail_url) value.thumbnailUrl = value.thumbnail_url;
    if (value.order_index !== undefined && value.orderIndex === undefined) value.orderIndex = value.order_index;
    if (value.is_active !== undefined && value.isActive === undefined) value.isActive = value.is_active;
    if (!value.updatedBy && value.updated_by) value.updatedBy = value.updated_by;
    delete value.thumbnail_url;
    delete value.order_index;
    delete value.is_active;
    delete value.updated_by;
    return value;
}).min(1);
