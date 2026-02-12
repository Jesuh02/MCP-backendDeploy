/**
 * FileContextController — File context CRUD.
 */
import Joi from 'joi';
import { ValidationError } from '../../../shared/errors/index.js';

const createFileContextSchema = Joi.object({
    submissionId: Joi.number().integer().required(),
    fileName: Joi.string().max(255).allow(null, '').optional(),
    fileType: Joi.string().max(50).allow(null, '').optional(),
    fileSize: Joi.number().integer().allow(null).optional(),
    fileUri: Joi.string().max(2000).allow(null, '').optional(),
    extractedText: Joi.string().max(100000).allow(null, '').optional(),
    summary: Joi.string().max(10000).allow(null, '').optional(),
    content: Joi.string().max(100000).allow(null, '').optional(),
    fileContent: Joi.string().max(100000).allow(null, '').optional(),
    file_content: Joi.string().max(100000).allow(null, '').optional(),
    contentSummary: Joi.string().max(10000).allow(null, '').optional(),
    content_summary: Joi.string().max(10000).allow(null, '').optional(),
    metadata: Joi.string().max(10000).allow(null, '').optional(),
}).options({ allowUnknown: true });

export class FileContextController {
    constructor({ fileContextService }) {
        this.fcService = fileContextService;
    }

    getById = async(req, res, next) => {
        try {
            const result = await this.fcService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getBySubmission = async(req, res, next) => {
        try {
            const result = await this.fcService.getBySubmission(parseInt(req.params.submissionId));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    create = async(req, res, next) => {
        try {
            const { error, value } = createFileContextSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.fcService.create(value);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    delete = async(req, res, next) => {
        try {
            const result = await this.fcService.delete(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default FileContextController;