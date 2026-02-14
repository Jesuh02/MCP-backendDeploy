/**
 * WhatsAppSchemas — Validaciones Joi para entradas del módulo WhatsApp.
 *
 * Incluye validación de números de teléfono (E.164),
 * comandos de calificación y sanitización de entrada.
 */
import Joi from 'joi';

// ── Schemas de Request ──────────────────────────────────────

/** Schema para vincular una cuenta de WhatsApp */
export const linkWhatsAppSchema = Joi.object({
    phoneNumber: Joi.string()
        .pattern(/^\+?[1-9]\d{6,14}$/)
        .required()
        .messages({
            'string.pattern.base': 'Número de teléfono inválido. Use formato E.164 (ej: +573001234567)',
            'any.required': 'El número de teléfono es requerido',
        }),
});

/** Schema para verificar OTP */
export const verifyWhatsAppSchema = Joi.object({
    code: Joi.string()
        .length(6)
        .pattern(/^\d{6}$/)
        .required()
        .messages({
            'string.pattern.base': 'El código debe ser de 6 dígitos numéricos',
            'string.length': 'El código debe tener exactamente 6 dígitos',
            'any.required': 'El código de verificación es requerido',
        }),
});

// ── Funciones de Validación de Dominio ──────────────────────

/**
 * Valida y normaliza un número de teléfono a formato E.164.
 * @param {string} phone — Número crudo ingresado por el usuario.
 * @returns {{ valid: boolean, normalized: string|null, error?: string }}
 */
export function validatePhoneNumber(phone) {
    if (!phone || typeof phone !== 'string') {
        return { valid: false, normalized: null, error: 'Número de teléfono requerido' };
    }

    // Limpiar caracteres no numéricos excepto +
    let cleaned = phone.replace(/[^0-9+]/g, '');

    // Asegurar prefijo +
    if (!cleaned.startsWith('+')) {
        cleaned = `+${cleaned}`;
    }

    // Validar formato E.164: + seguido de 7-15 dígitos
    const e164Regex = /^\+[1-9]\d{6,14}$/;
    if (!e164Regex.test(cleaned)) {
        return { valid: false, normalized: null, error: 'Formato inválido. Use E.164 (ej: +573001234567)' };
    }

    return { valid: true, normalized: cleaned };
}

/**
 * Parsea un comando de calificación.
 * Formatos aceptados:
 *   /calificar <submissionId> <grade>
 *   /calificar <submissionId> <grade> <feedback>
 *
 * @param {string} text — Mensaje completo del usuario.
 * @returns {{ valid: boolean, submissionId?: number, grade?: number, feedback?: string, error?: string }}
 */
export function validateGradeCommand(text) {
    if (!text || typeof text !== 'string') {
        return { valid: false, error: 'Comando vacío' };
    }

    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) {
        return { valid: false, error: 'Formato: /calificar <id_entrega> <nota> [feedback]' };
    }

    const submissionId = parseInt(parts[1], 10);
    if (isNaN(submissionId) || submissionId <= 0) {
        return { valid: false, error: 'ID de entrega inválido. Debe ser un número positivo.' };
    }

    const grade = parseFloat(parts[2]);
    if (isNaN(grade) || grade < 0 || grade > 10) {
        return { valid: false, error: 'Nota inválida. Debe ser un número entre 0 y 10.' };
    }

    const feedback = parts.length > 3 ? parts.slice(3).join(' ') : null;

    return { valid: true, submissionId, grade, feedback };
}

/**
 * Sanitiza entrada del usuario para prevenir inyección.
 * @param {string} text — Texto crudo del usuario.
 * @param {number} [maxLength=2000] — Longitud máxima permitida.
 * @returns {string}
 */
export function sanitizeInput(text, maxLength = 2000) {
    if (!text || typeof text !== 'string') return '';

    return text
        .substring(0, maxLength)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // Control chars
        .trim();
}

/**
 * Verifica si un texto contiene intentos de inyección SQL peligrosa.
 * @param {string} text
 * @returns {boolean} true si es sospechoso
 */
export function containsSQLInjection(text) {
    if (!text) return false;
    const dangerous = /\b(DROP|ALTER|TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET)\b/i;
    return dangerous.test(text);
}

export default {
    linkWhatsAppSchema,
    verifyWhatsAppSchema,
    validatePhoneNumber,
    validateGradeCommand,
    sanitizeInput,
    containsSQLInjection,
};

