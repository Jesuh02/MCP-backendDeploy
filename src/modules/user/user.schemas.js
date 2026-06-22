/**
 * Joi Validation Schemas — Users
 */
import Joi from 'joi';

export const updateProfileSchema = Joi.object({
    username: Joi.string().trim().min(3).max(30).optional(),
    email: Joi.string().trim().email().optional(),
    avatar: Joi.string().uri().allow(null, '').optional(),
    nombre: Joi.string().trim().max(120).allow('').optional(),
    apellido: Joi.string().trim().max(120).allow('').optional(),
    nombres: Joi.string().trim().max(120).allow('').optional(),
    apellidos: Joi.string().trim().max(120).allow('').optional(),
    telefono: Joi.string().trim().max(40).allow('').optional(),
    persona: Joi.object({
        nombres: Joi.string().trim().max(120).allow('').optional(),
        apellidos: Joi.string().trim().max(120).allow('').optional(),
        telefono: Joi.string().trim().max(40).allow('').optional(),
    }).optional(),
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

