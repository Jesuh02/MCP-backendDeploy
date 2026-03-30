/**
 * Joi Validation Schemas — Auth
 */
import Joi from 'joi';

export const registerSchema = Joi.object({
    username: Joi.string().min(3).max(30).required().messages({
        'string.min': 'El username debe tener al menos 3 caracteres',
        'string.max': 'El username no puede tener más de 30 caracteres',
        'any.required': 'El username es requerido',
    }),
    email: Joi.string().email().required().messages({
        'string.email': 'Email inválido',
        'any.required': 'El email es requerido',
    }),
    password: Joi.string().min(6).max(128).required().messages({
        'string.min': 'La contraseña debe tener al menos 6 caracteres',
        'any.required': 'La contraseña es requerida',
    }),
    tenantId: Joi.string().max(64).allow(null, '').optional(),
    tenantIds: Joi.array().items(Joi.string().max(64)).min(1).allow(null).optional(),
    personaId: Joi.number().integer().positive().allow(null).optional(),
    persona: Joi.object({
        nombre: Joi.string().allow('').optional(),
        nombres: Joi.string().allow('').optional(),
        apellido: Joi.string().allow('').optional(),
        apellidos: Joi.string().allow('').optional(),
        cedula: Joi.string().allow('', null).optional(),
        identificacion: Joi.string().allow('', null).optional(),
        genero: Joi.string().allow('', null).optional(),
        telefono: Joi.string().allow('').optional(),
        fecha_nacimiento: Joi.string().allow('', null).optional(),
        institucion_id: Joi.number().integer().positive().allow(null).optional(),
    }).allow(null).optional(),
});

export const loginSchema = Joi.object({
    username: Joi.string().required().messages({
        'any.required': 'El username es requerido',
    }),
    password: Joi.string().required().messages({
        'any.required': 'La contraseña es requerida',
    }),
    cedula: Joi.string().allow('', null).optional().messages({
        'string.base': 'La cédula debe ser texto',
    }),
});

export const refreshTokenSchema = Joi.object({
    refreshToken: Joi.string().required().messages({
        'any.required': 'El refresh token es requerido',
    }),
});

export const changePasswordSchema = Joi.object({
    currentPassword: Joi.string().required(),
    newPassword: Joi.string().min(6).max(128).required(),
});

export const checkPasswordSchema = Joi.object({
    password: Joi.string().min(1).required().messages({
        'any.required': 'La contraseña es requerida',
    }),
});

export const googleLoginSchema = Joi.object({
    idToken: Joi.string().min(1).required().messages({
        'any.required': 'El idToken de Google es requerido',
        'string.empty': 'El idToken de Google es requerido',
    }),
    displayName: Joi.string().allow('').optional(),
    avatarUrl: Joi.string().uri().allow(null, '').optional(),
    username: Joi.string().min(3).max(30).allow(null, '').optional(),
});

