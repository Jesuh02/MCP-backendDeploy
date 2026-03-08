/**
 * TTSController — Controlador HTTP para Text-to-Speech.
 *
 * Recibe requests HTTP, valida con Joi, delega a TTSDomainService,
 * y devuelve respuestas estandarizadas.
 */

import { synthesizeSchema } from '../../domain/validators/TTSSchemas.js';
import { ValidationError } from '../../shared/errors/index.js';

export class TTSController {
    constructor({ ttsService }) {
        this.ttsService = ttsService;
    }

    synthesize = async(req, res, next) => {
        try {
            const { error, value } = synthesizeSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const result = await this.ttsService.synthesize(value);
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getCapabilities = async(req, res, next) => {
        try {
            const result = this.ttsService.getCapabilities();
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default TTSController;

