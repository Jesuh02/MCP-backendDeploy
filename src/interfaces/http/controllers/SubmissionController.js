import { createSubmissionSchema, gradeSubmissionSchema } from '../../../domain/validators/CommonSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';
import { parsePagination } from '../../../shared/pagination.js';
import path from 'path';

export class SubmissionController {
    constructor({ submissionService, storageService, storageAdapter, notificationService, userService, taskService, courseService }) {
        this.subService = submissionService;
        this.storageService = storageService;
        this.storageAdapter = storageAdapter;
        this.notificationService = notificationService;
        this.userService = userService;
        this.taskService = taskService;
        this.courseService = courseService;
    }

    getById = async(req, res, next) => {
        try {
            const result = await this.subService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByTask = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.subService.getByTask(parseInt(req.params.taskId), pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getMySubmissions = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.subService.getByUser(req.user.userId, pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    submit = async(req, res, next) => {
        try {
            const { error, value } = createSubmissionSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            value.userId = req.user.userId;
            value.username = req.user.username;
            const result = await this.subService.submit(value);
            if (result.isFail()) return next(result.getError());

            // Notificar al creador del curso si es necesario
            try {
                if (this.notificationService && this.taskService && this.courseService) {
                    const taskResult = await this.taskService.getById(value.taskId);
                    if (taskResult.isSuccess()) {
                        const task = taskResult.getValue();
                        const courseResult = await this.courseService.getById(task.courseId);
                        if (courseResult.isSuccess()) {
                            const course = courseResult.getValue();
                            const creatorId = course.creatorUserId;

                            // Obtener avatar del estudiante
                            let senderAvatarUrl = null;
                            if (this.userService) {
                                const userResult = await this.userService.getById(value.userId);
                                if (userResult.isSuccess()) {
                                    senderAvatarUrl = userResult.getValue().avatar;
                                }
                            }

                            const metadataJson = JSON.stringify({ taskId: value.taskId, type: "submission" });

                            await this.notificationService.sendNotification({
                                userId: creatorId,
                                title: `Nueva entrega: ${task.title}`,
                                message: `${value.username} ha enviado una entrega para la tarea '${task.title}'`,
                                type: "submission",
                                relatedId: value.taskId,
                                senderUsername: value.username,
                                senderAvatarUrl: senderAvatarUrl,
                                thumbnailUrl: course.thumbnail_url || course.thumbnailUri || course.thumbnailUrl || senderAvatarUrl, // Usar thumbnail del curso
                                metadata: metadataJson
                            });
                        }
                    }
                }
            } catch (notifyErr) {
                console.warn('Error enviando notificación de entrega:', notifyErr);
            }

            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    grade = async(req, res, next) => {
        try {
            const { error, value } = gradeSubmissionSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.subService.grade(parseInt(req.params.id), value, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    delete = async(req, res, next) => {
        try {
            const result = await this.subService.delete(parseInt(req.params.id), req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByUserAndTask = async(req, res, next) => {
        try {
            const taskId = parseInt(req.params.taskId);
            const studentId = req.query.studentId ? parseInt(req.query.studentId) : req.user.userId;
            const result = await this.subService.getByUserAndTask(studentId, taskId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByCourse = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.subService.getByCourse(parseInt(req.params.courseId), pg);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /**
     * Upload a submission file to R2 storage.
     * Returns only the R2 object key (relative path), never the public URL.
     */
    uploadFile = async(req, res, next) => {
        try {
            if (!req.file) return next(new ValidationError('Se requiere un archivo'));
            const folder = req.body.folder || req.body.prefix || 'submissions';
            const key = `${folder}/${Date.now()}_${req.file.originalname}`;
            const result = await this.storageService.upload(req.file.buffer, key, req.file.mimetype);
            if (result.isFail()) return next(result.getError());
            const { key: uploadedKey } = result.getValue();
            // Only return the relative key, not the public R2 URL
            res.status(201).json({ success: true, data: { key: uploadedKey } });
        } catch (err) { next(err); }
    };

    /**
     * Proxy/stream a submission file from R2 storage.
     * This avoids exposing the R2 bucket URL to clients.
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

            // Determine the R2 object key from the stored fileUri
            let key = fileUri;

            // If it's a full R2 URL, extract the key
            if (fileUri.includes('.r2.dev/')) {
                key = fileUri.split('.r2.dev/')[1];
            } else if (fileUri.includes('.r2.cloudflarestorage.com/')) {
                const parts = fileUri.split('.r2.cloudflarestorage.com/');
                key = parts[1];
            }

            // If it's a local file:/// URI, we cannot serve it
            if (fileUri.startsWith('file:///')) {
                return res.status(404).json({
                    success: false,
                    error: 'Archivo almacenado localmente en el dispositivo, no disponible remotamente'
                });
            }

            // Fetch file from R2 and stream it
            const { buffer, contentType } = await this.storageAdapter.fetchFile(key);

            const fileName = submission.file_name || submission.fileName || path.basename(key);
            res.setHeader('Content-Type', contentType || 'application/octet-stream');
            res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
            res.setHeader('Content-Length', buffer.length);
            res.send(buffer);
        } catch (err) {
            console.error('Error proxying submission file:', err.message);
            next(err);
        }
    };
}
export default SubmissionController;