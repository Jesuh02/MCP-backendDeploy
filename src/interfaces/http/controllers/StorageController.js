import { getUploadUrlSchema } from '../../../domain/validators/CommonSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';

export class StorageController {
    constructor({ storageService }) {
        this.storageService = storageService;
    }

    getUploadUrl = async(req, res, next) => {
        try {
            const { error, value } = getUploadUrlSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.storageService.getUploadUrl(value);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    upload = async(req, res, next) => {
        try {
            if (!req.file) return next(new ValidationError('Se requiere un archivo'));
            const prefix = req.body.prefix || req.body.folder || 'content';
            const key = `${prefix}/${Date.now()}_${req.file.originalname}`;
            const result = await this.storageService.upload(req.file.buffer, key, req.file.mimetype);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    delete = async(req, res, next) => {
        try {
            const key = req.params.key || req.query.key;
            if (!key) return next(new ValidationError('Se requiere la clave del archivo'));
            const result = await this.storageService.delete(key);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getDownloadUrl = async(req, res, next) => {
        try {
            const key = req.params.key || req.query.key;
            if (!key) return next(new ValidationError('Se requiere la clave del archivo'));
            const result = await this.storageService.getDownloadUrl(key);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    listFiles = async(req, res, next) => {
        try {
            const prefix = req.query.prefix || '';
            const result = await this.storageService.listFiles(prefix);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default StorageController;