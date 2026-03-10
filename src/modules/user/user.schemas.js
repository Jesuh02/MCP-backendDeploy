/**
 * Joi Validation Schemas — Users
 */
import Joi from 'joi';

export const updateProfileSchema = Joi.object({
    username: Joi.string().min(3).max(30).optional(),
    email: Joi.string().email().optional(),
    avatar: Joi.string().uri().allow(null, '').optional(),
}).min(1).messages({
    'object.min': 'Debes enviar al menos un campo para actualizar',
});

export const registerFCMTokenSchema = Joi.object({
    token: Joi.string().optional(),
    fcmToken: Joi.string().optional(),
    deviceType: Joi.string().valid('android', 'ios', 'web').default('android'),
}).or('token', 'fcmToken');

export const assignRoleSchema = Joi.object({
    roleId: Joi.number().integer().min(1).max(10).required(),
});

export const searchUsersSchema = Joi.object({
    q: Joi.string().min(1).max(100).required(),
    limit: Joi.number().integer().min(1).max(100).default(20),
});

