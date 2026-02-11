/**
 * RAGController — Controlador HTTP para Retrieval-Augmented Generation.
 */

import { ingestSchema, searchSchema, buildContextSchema } from '../../../domain/validators/RAGSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';

export class RAGController {
    constructor({ ragService }) {
        this.ragService = ragService;
    }

    getStatus = async(req, res, next) => {
        try {
            const result = await this.ragService.getStatus();
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    ingest = async(req, res, next) => {
        try {
            const { error, value } = ingestSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const result = await this.ragService.ingest(value);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    search = async(req, res, next) => {
        try {
            const { error, value } = searchSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const result = await this.ragService.search(value);
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    buildContext = async(req, res, next) => {
        try {
            const { error, value } = buildContextSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const result = await this.ragService.buildContext(value);
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default RAGController;