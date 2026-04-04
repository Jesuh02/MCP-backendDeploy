/**
 * validate — Middleware reutilizable de validación Joi.
 *
 * Aplica un schema Joi al body, query o params del request.
 * Rechaza con ValidationError si la validación falla.
 *
 * Uso:
 *   router.post('/courses', validate(createCourseSchema), controller.create);
 *   router.get('/search', validate(searchSchema, 'query'), controller.search);
 */
import { ValidationError } from '../errors/index.js';

/**
 * @param {import('joi').ObjectSchema} schema — Schema Joi a aplicar.
 * @param {'body'|'query'|'params'} [source='body'] — Parte del request a validar.
 * @returns {import('express').RequestHandler}
 */
export function validate(schema, source = 'body') {
    return (req, _res, next) => {
        const data = req[source];
        const { error, value } = schema.validate(data, {
            abortEarly: false,
            stripUnknown: true,
            allowUnknown: false,
        });

        if (error) {
            const details = error.details.map((d) => ({
                field: d.path.join('.'),
                message: d.message,
            }));
            return next(new ValidationError(error.message, details));
        }

        // Reemplazar con datos sanitizados
        req[source] = value;
        next();
    };
}

export default validate;