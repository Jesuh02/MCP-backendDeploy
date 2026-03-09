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
    persona: Joi.object({
        nombre: Joi.string().required(),
        apellido: Joi.string().allow(''),
        identificacion: Joi.string().allow(''),
        telefono: Joi.string().allow(''),
    }).optional(),
});

export const loginSchema = Joi.object({
    username: Joi.string().required().messages({
        'any.required': 'El username es requerido',
    }),
    password: Joi.string().required().messages({
        'any.required': 'La contraseña es requerida',
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

export const googleLoginSchema = Joi.object({
    email: Joi.string().email().required().messages({
        'string.email': 'Email inválido',
        'any.required': 'El email es requerido',
    }),
    displayName: Joi.string().allow('').optional(),
    avatarUrl: Joi.string().uri().allow(null, '').optional(),
    idToken: Joi.string().allow('').optional(), // For future server-side verification
    username: Joi.string().min(3).max(30).allow(null, '').optional(), // Hint to link Google email to existing account
});

