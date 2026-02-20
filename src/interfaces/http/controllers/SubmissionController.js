import { BaseController } from './BaseController.js';
import { createSubmissionSchema, gradeSubmissionSchema } from '../../../domain/validators/CommonSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';
import { parsePagination } from '../../../shared/pagination.js';
import path from 'path';

export class SubmissionController extends BaseController {
    constructor({ submissionService, storageService, storageAdapter }) {
        super();
        this.subService = submissionService;
        this.storageService = storageService;
        this.storageAdapter = storageAdapter;
    }

    getById = async(req, res, next) => {
        this.store(req, res, next, () => this.subService.getById(parseInt(req.params.id)));
    };

    getByTask = async(req, res, next) => {
        const pg = parsePagination(req.query);
        this.store(req, res, next, () => this.subService.getByTask(parseInt(req.params.taskId), pg));
    };

    getMySubmissions = async(req, res, next) => {
        const pg = parsePagination(req.query);
        this.store(req, res, next, () => this.subService.getByUser(req.user.userId, pg));
    };

    submit = async(req, res, next) => {
        const { error, value } = createSubmissionSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        value.userId = req.user.userId;
        value.username = req.user.username;
        this.handleResult(res, next, (async() => {
            const result = await this.subService.submitAndNotify(value);
            if (result.isFail()) return result;
            res.status(201);
            return result;
        })());
    };

    grade = async(req, res, next) => {
        const { error, value } = gradeSubmissionSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        this.store(req, res, next, () => this.subService.grade(parseInt(req.params.id), value, req.user.userId));
    };

    delete = async(req, res, next) => {
        this.store(req, res, next, () => this.subService.delete(parseInt(req.params.id), req.user.userId));
    };

    getByUserAndTask = async(req, res, next) => {
        const taskId = parseInt(req.params.taskId);
        const studentId = req.query.studentId ? parseInt(req.query.studentId) : req.user.userId;
        this.store(req, res, next, () => this.subService.getByUserAndTask(studentId, taskId));
    };

    getByCourse = async(req, res, next) => {
        const pg = parsePagination(req.query);
        const ungradedOnly = req.query.ungradedOnly === 'true';
        this.store(req, res, next, () => this.subService.getByCourse(parseInt(req.params.courseId), pg, { ungradedOnly }));
    };

    /**
     * Upload a submission file to R2 storage.
     * Returns only the R2 object key (relative path), never the public URL.
     */
    uploadFile = async(req, res, next) => {
        if (!req.file) return next(new ValidationError('Se requiere un archivo'));
        this.handleResult(res, next, (async() => {
            const folder = req.body.folder || req.body.prefix || 'submissions';
            const key = `${folder}/${Date.now()}_${req.file.originalname}`;
            const result = await this.storageService.upload(req.file.buffer, key, req.file.mimetype);
            if (result.isFail()) return result;
            const { key: uploadedKey } = result.getValue();
            res.status(201);
            return { isFail: () => false, isOk: () => true, getValue: () => ({ key: uploadedKey }) };
        })());
    };

    /**
     * Proxy/stream a submission file from R2 storage.
     * This avoids exposing the R2 bucket URL to clients.
     *
     * Refactored: delegates key extraction to R2StorageAdapter.extractObjectKey()
     * instead of duplicating URL-parsing logic here (DIP + DRY).
     */
    getFile = async(req, res, next) => {
        try {
            const submissionId = parseInt(req.params.id);
            const result = await this.subService.getById(submissionId);
            if (result.isFail()) return next(result.getError());

            const submission = result.getValue();
            const fileUri = submission.file_uri || submission.fileUri;

            if (!fileUri) {
                return res.status(404).json({ success: false, error: 'No file associated with this submission' });
            }

            if (fileUri.startsWith('file:///') || fileUri.startsWith('content://')) {
                return res.status(404).json({
                    success: false,
                    error: 'Archivo almacenado localmente en el dispositivo, no disponible remotamente'
                });
            }

            // Delegate key extraction to the storage adapter (DIP)
            const key = this.storageAdapter.extractObjectKey(fileUri) || fileUri;

            const { buffer, contentType } = await this.storageAdapter.fetchFile(key);
            const fileName = submission.file_name || submission.fileName || path.basename(key);
            res.setHeader('Content-Type', contentType || 'application/octet-stream');
            res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
            res.setHeader('Content-Length', buffer.length);
            res.send(buffer);
        } catch (err) {
            next(err);
        }
    };

    /**
     * POST /obtener-contenido-submission
     * Obtiene el contenido de un archivo de entrega.
     * Migrado desde index.legacy.js para compatibilidad con Android.
     */
    getSubmissionContent = async(req, res, next) => {
        try {
            const { submissionId, taskId, studentId } = req.body;

            if (!submissionId && !(taskId && studentId)) {
                return res.status(400).json({
                    success: false,
                    error: 'Se requiere submissionId o (taskId + studentId)',
                });
            }

            const result = await this.subService.getSubmissionContent({
                submissionId: submissionId ? parseInt(submissionId) : undefined,
                taskId: taskId ? parseInt(taskId) : undefined,
                studentId: studentId ? parseInt(studentId) : undefined,
            });

            if (result.isFail()) return next(result.getError());

            res.json({ success: true, ...result.getValue() });
        } catch (err) {
            next(err);
        }
    };
}
export default SubmissionController;