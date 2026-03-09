import { Result } from '../../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../../shared/errors/index.js';
import { generateGradeEmailHTML } from '../../../templates/emailTemplates.js';

export class SubmissionDomainService {
    constructor({ submissionRepository, taskRepository, progressRepository, progressService, notificationService, courseService, topicService, userService, fileStoragePort }) {
        this.subRepo = submissionRepository;
        this.taskRepo = taskRepository;
        this.progressRepo = progressRepository;
        this.progressService = progressService || null;
        this.notificationService = notificationService || null;
        this.courseService = courseService || null;
        this.topicService = topicService || null;
        this.userService = userService || null;
        this.storage = fileStoragePort || null;
    }

    async getById(id) {
        const sub = await this.subRepo.findById(id);
        if (!sub) return Result.fail(new NotFoundError('Entrega', id));
        await this._signFileUrls(sub);
        return Result.ok(sub);
    }

    async getByTask(taskId, pagination) {
        const subs = await this.subRepo.findByTask(taskId, pagination);
        await this._signFileUrls(subs);
        return Result.ok(subs);
    }

    async getByUser(userId, pagination) {
        const subs = await this.subRepo.findByUser(userId, pagination);
        await this._signFileUrls(subs);
        return Result.ok(subs);
    }

    async submit(data) {
        const task = await this.taskRepo.findById(data.taskId);
        if (!task) return Result.fail(new NotFoundError('Tarea', data.taskId));

        // Normalize fileUri to full R2 public URL if it's a relative key
        data.fileUri = this._normalizeFileUri(data.fileUri);

        // Check if submission already exists for this user and task
        const existingSubmission = await this.subRepo.findByUserAndTask(data.userId, data.taskId);

        if (existingSubmission) {
            // Update existing submission
            const updated = await this.subRepo.update(existingSubmission.id, {
                fileUri: data.fileUri,
                fileName: data.fileName,
                submissionDate: Date.now()
            });

            await this._updateProgress(data.userId, data.taskId);
            return Result.ok(updated);
        } else {
            // Create new submission
            const created = await this.subRepo.create(data);

            await this._updateProgress(data.userId, data.taskId);
            return Result.ok(created);
        }
    }

    /**
     * Ensures fileUri is always a full public URL, not a relative key.
     * @private
     */
    _normalizeFileUri(uri) {
        if (!uri || uri.startsWith('http')) return uri;
        return this.storage?.getPublicUrl ? this.storage.getPublicUrl(uri) : uri;
    }

    /**
     * Envía una entrega y notifica al creador del curso.
     * Orquesta la lógica de negocio que antes vivía en el controlador.
     */
    async submitAndNotify(data) {
        const submitResult = await this.submit(data);
        if (submitResult.isFail()) return submitResult;

        // Fire-and-forget: la notificación no bloquea la respuesta
        this._notifySubmission(data).catch(err =>
            console.warn('[SubmissionDomainService] Error notificando entrega:', err.message)
        );
        return submitResult;
    }

    /**
     * Notifica al creador del curso sobre una nueva entrega.
     * @private
     */
    async _notifySubmission(data) {
        if (!this.notificationService || !this.taskRepo || !this.courseService || !this.topicService) return;

        const task = await this.taskRepo.findById(data.taskId);
        if (!task) return;

        const topicId = task.topicId || task.topic_id;
        if (!topicId) return;

        const topicResult = await this.topicService.getById(topicId);
        if (topicResult.isFail()) return;
        const topic = topicResult.getValue();
        const courseId = topic.course_id || topic.courseId;
        if (!courseId) return;

        const courseResult = await this.courseService.getById(courseId);
        if (courseResult.isFail()) return;
        const course = courseResult.getValue();
        const creatorId = course.creator_user_id || course.creatorUserId;

        if (!creatorId || creatorId === data.userId) return;

        let senderAvatarUrl = null;
        if (this.userService) {
            const userResult = await this.userService.getById(data.userId);
            if (userResult.isOk()) {
                senderAvatarUrl = userResult.getValue().avatar;
            }
        }

        await this.notificationService.sendNotification({
            userId: creatorId,
            title: `Nueva entrega: ${task.title}`,
            message: `${data.username} ha enviado una entrega para la tarea '${task.title}'`,
            type: 'task_submission',
            relatedId: data.taskId,
            senderUsername: data.username,
            senderAvatarUrl,
            thumbnailUrl: course.thumbnail_url || course.thumbnailUri || course.thumbnail_uri || senderAvatarUrl,
            metadata: JSON.stringify({ taskId: data.taskId, courseId, type: 'task_submission' })
        });
    }

    /**
     * Notifica al estudiante que su tarea ha sido calificada por email.
     * @private
     */
    async _notifyGrade(submission, grade, feedback, graderId) {
        if (!this.notificationService || !this.userService || !this.taskRepo) return;

        const studentId = submission.student_id || submission.user_id || submission.userId;
        const taskId = submission.task_id || submission.taskId;

        if (!studentId || !taskId) return;

        // Obtener datos del estudiante
        const studentResult = await this.userService.getById(studentId);
        if (studentResult.isFail()) return;
        const student = studentResult.getValue();
        const studentEmail = student.email || student.email_address;

        if (!studentEmail) {
            console.warn(`[SubmissionDomainService] Student ${studentId} has no email address`);
            return;
        }

        // Obtener datos de la tarea
        const task = await this.taskRepo.findById(taskId);
        if (!task) return;

        // Obtener datos del usuario que calificó (quien es el teacher/admin)
        let graderUsername = 'Instructor';
        if (graderId) {
            const graderResult = await this.userService.getById(graderId);
            if (graderResult.isOk()) {
                graderUsername = graderResult.getValue().username || 'Instructor';
            }
        }

        // Generar HTML del email
        const studentName = student.name || student.username || 'Estudiante';
        const taskName = task.title || task.name || 'Tarea sin título';
        const htmlContent = generateGradeEmailHTML(studentName, taskName, grade, feedback, graderUsername);

        // Enviar email
        await this.notificationService.sendEmail(studentId, {
            subject: `📝 Tu tarea "${taskName}" ha sido calificada - Calificación: ${grade}`,
            html: htmlContent,
            text: `Tu tarea "${taskName}" ha sido calificada con ${grade}. ${feedback ? `Retroalimentación: ${feedback}` : ''}`
        });
    }

    async grade(id, { grade, feedback }, graderId) {
        const sub = await this.subRepo.findById(id);
        if (!sub) return Result.fail(new NotFoundError('Entrega', id));

        const updated = await this.subRepo.update(id, {
            grade,
            feedback,
        });

        // Recalcular progreso del estudiante si es posible
        await this._updateProgress(sub.student_id || sub.user_id || sub.userId, sub.task_id || sub.taskId);

        // Fire-and-forget: Enviar email de calificación al estudiante
        if (this.notificationService && this.userService && this.taskRepo) {
            await this._notifyGrade(sub, grade, feedback, graderId).catch(err =>
                console.warn('[SubmissionDomainService] Error notificando calificación:', err.message)
            );
        }

        return Result.ok(updated);
    }

    async delete(id, requesterId) {
        const sub = await this.subRepo.findById(id);
        if (!sub) return Result.fail(new NotFoundError('Entrega', id));

        const ownerId = sub.student_id || sub.user_id || sub.userId;
        if (ownerId !== requesterId) {
            return Result.fail(new ForbiddenError('No puedes eliminar esta entrega'));
        }

        const deletedTaskId = sub.task_id || sub.taskId;
        await this.subRepo.delete(id);

        await this._updateProgress(ownerId, deletedTaskId);

        return Result.ok({ message: 'Entrega eliminada' });
    }

    async _updateProgress(userId, taskId) {
        try {
            if (!userId || !taskId) return;
            const task = await this.taskRepo.findById(taskId);
            if (!task) return;

            let courseId = task.courseId || task.course_id || null;
            if (!courseId && task.topicId && this.topicService) {
                const topicResult = await this.topicService.getById(task.topicId);
                if (topicResult.isOk()) {
                    const topic = topicResult.getValue();
                    courseId = topic.courseId || topic.course_id || null;
                }
            }
            if (!courseId) return;

            // Prefer domain orchestration for progress recalculation (hexagonal use-case boundary)
            if (this.progressService && typeof this.progressService.refreshForUserCourse === 'function') {
                await this.progressService.refreshForUserCourse(userId, courseId);
                return;
            }

            const graded = await this.subRepo.getGradedByUserAndCourse(userId, courseId);
            const totalTasks = await this.taskRepo.countByCourse(courseId);
            const submittedTaskIds = await this.subRepo.getTaskIdsByUserAndCourse(userId, courseId);
            const completedTasks = submittedTaskIds.length;
            const avgGrade = graded.length > 0 ?
                graded.reduce((s, g) => s + (g.grade || 0), 0) / graded.length :
                0;
            const progressPercentage = totalTasks > 0 ? Math.round(((completedTasks / totalTasks) * 100) * 100) / 100 : 0;

            await this.progressRepo.upsert({
                userId,
                courseId,
                completedTasks,
                totalTasks,
                averageGrade: Math.round(avgGrade * 100) / 100,
                progressPercentage,
            });
        } catch (err) {
            console.error('Error updating progress:', err.message);
        }
    }

    async getByUserAndTask(userId, taskId) {
        const sub = await this.subRepo.findByUserAndTask(userId, taskId);
        await this._signFileUrls(sub);
        return Result.ok(sub);
    }

    async getByCourse(courseId, pagination) {
        const subs = await this.subRepo.findByCourse(courseId, pagination);
        await this._signFileUrls(subs);
        return Result.ok(subs);
    }

    // -- Pre-signed URL Resolution (análogo a VideoDomainService._signUrls) --

    /**
     * Firma las fileUri de las submissions para que el cliente reciba
     * URLs pre-firmadas listas para descarga directa.
     *
     * Maneja tres formatos almacenados en BD:
     *  1. Clave relativa de R2  → "submissions/123_file.pdf"
     *  2. URL pública HTTP R2   → "https://pub-xxx.r2.dev/submissions/..."
     *  3. URL ya firmada         → contiene "X-Amz-Signature" (skip)
     *
     * Principios: OCP — nuevos formatos de URL se añaden sin modificar
     * la lógica de firma existente; solo se extiende _resolveAndSign.
     *
     * @param {Object|Object[]} submissions — una o varias submissions
     * @returns {Promise<Object|Object[]>}
     * @private
     */
    async _signFileUrls(submissions) {
        if (!this.storage || !this.storage.isAvailable || !this.storage.isAvailable()) return submissions;
        if (!submissions) return submissions;

        const list = Array.isArray(submissions) ? submissions : [submissions];
        await Promise.all(list.map(async (sub) => {
            if (!sub) return;
            try {
                const fileUri = sub.file_uri || sub.fileUri;
                if (fileUri) {
                    const signed = await this._resolveAndSign(fileUri);
                    if (signed) {
                        sub.file_uri = signed;
                        sub.fileUri = signed;
                    }
                }
            } catch (e) {
                console.warn('[SubmissionDomainService] Error signing URL for submission', sub.id, e.message);
            }
        }));
        return Array.isArray(submissions) ? list : list[0];
    }

    /**
     * Resuelve una URL/clave cruda a una URL pre-firmada de descarga.
     *
     * @param {string} raw — clave de objeto R2, URL pública, o URL ya firmada.
     * @returns {Promise<string|null>} URL pre-firmada o null si ya está firmada.
     * @private
     */
    async _resolveAndSign(raw) {
        if (!raw) return null;

        // Ya firmada — skip
        if (raw.includes('X-Amz-Signature')) return null;

        let objectKey = null;

        if (raw.startsWith('http://') || raw.startsWith('https://')) {
            // URL HTTP completa — extraer clave de objeto R2
            objectKey = this.storage.extractObjectKey(raw);
        } else if (!raw.startsWith('file://') && !raw.startsWith('content://')) {
            // Clave relativa almacenada directamente en BD (e.g. "submissions/123.pdf")
            objectKey = raw;
        }

        if (!objectKey) return null;

        return this.storage.generateDownloadUrl(objectKey, 3600);
    }

    /**
     * Obtiene el contenido de un archivo de entrega desde R2/HTTP.
     * Migrado desde index.legacy.js: POST /obtener-contenido-submission
     *
     * @param {{ submissionId?: number, taskId?: number, studentId?: number }} params
     * @returns {Result<Object>}
     */
    async getSubmissionContent({ submissionId, taskId, studentId }) {
        try {
            let submission = null;

            // Estrategia 1: Buscar por submissionId
            if (submissionId) {
                submission = await this.subRepo.findById(submissionId);
            }

            // Estrategia 2: Buscar por taskId + studentId
            if (!submission && taskId && studentId) {
                submission = await this.subRepo.findByUserAndTask(studentId, taskId);
            }

            if (!submission) {
                return Result.fail(new NotFoundError('Submission', submissionId || `task:${taskId}/student:${studentId}`));
            }

            const fileUri = submission.file_uri || submission.fileUri;
            const fileName = submission.file_name || submission.fileName || 'archivo';

            if (!fileUri) {
                return Result.fail(new NotFoundError('Archivo', 'No hay archivo asociado a esta entrega'));
            }

            // Obtener contenido del archivo
            const fileData = await this._fetchFileContent(fileUri, fileName);

            return Result.ok({
                submissionId: submission.id,
                taskId: submission.task_id,
                studentId: submission.student_id || submission.user_id,
                fileName,
                fileUri,
                submissionDate: submission.submission_date,
                grade: submission.grade,
                feedback: submission.feedback,
                content: fileData.content,
                contentType: fileData.contentType,
                fileType: this._getFileType(fileName),
                source: fileData.source,
            });
        } catch (err) {
            return Result.fail(new NotFoundError('Contenido', err.message));
        }
    }

    /**
     * Descarga contenido de archivo desde R2 o HTTP directo.
     * @private
     */
    async _fetchFileContent(fileUri, fileName) {
        // Intentar R2 autenticado
        if (this.storage && this.storage.isAvailable()) {
            try {
                const objectKey = this.storage.extractObjectKey(fileUri);
                if (objectKey) {
                    const { buffer, contentType } = await this.storage.fetchFile(objectKey);
                    const isText = this._isTextFile(fileName) || (contentType && contentType.includes('text'));
                    return {
                        content: isText ? buffer.toString('utf-8') : buffer.toString('base64'),
                        contentType,
                        source: 'r2_authenticated',
                    };
                }
            } catch (err) {
                console.warn('[SubmissionDomainService] R2 fetch failed:', err.message);
            }
        }

        // Fallback: HTTP directo
        if (fileUri.startsWith('http://') || fileUri.startsWith('https://')) {
            const { default: axios } = await
            import ('axios');
            const response = await axios.get(fileUri, {
                responseType: 'arraybuffer',
                timeout: 60000,
                headers: { 'User-Agent': 'YisusCompany-MCP-Server/3.0' },
            });
            const buffer = Buffer.from(response.data);
            const contentType = response.headers['content-type'] || 'application/octet-stream';
            const isText = this._isTextFile(fileName) || contentType.includes('text');

            return {
                content: isText ? buffer.toString('utf-8') : buffer.toString('base64'),
                contentType,
                source: 'http_direct',
            };
        }

        throw new Error(`No se pudo obtener el contenido del archivo: ${fileUri}`);
    }

    /** @private */
    _isTextFile(fileName) {
        const textExts = [
            '.txt', '.sql', '.py', '.js', '.ts', '.java', '.kt', '.swift',
            '.html', '.css', '.json', '.xml', '.md', '.csv', '.yaml', '.yml',
            '.sh', '.bat', '.c', '.cpp', '.h', '.cs', '.php', '.rb', '.go', '.rs',
        ];
        return textExts.some(ext => (fileName || '').toLowerCase().endsWith(ext));
    }

    /** @private */
    _getFileType(fileName) {
        const lower = (fileName || '').toLowerCase();
        const map = {
            '.pdf': 'pdf',
            '.docx': 'docx',
            '.doc': 'docx',
            '.xlsx': 'excel',
            '.xls': 'excel',
            '.pptx': 'powerpoint',
            '.txt': 'text',
            '.sql': 'sql',
            '.py': 'python',
            '.js': 'javascript',
            '.ts': 'javascript',
            '.java': 'java',
            '.kt': 'kotlin',
            '.html': 'html',
            '.css': 'css',
            '.json': 'json',
            '.xml': 'xml',
            '.md': 'markdown',
            '.csv': 'csv',
        };
        for (const [ext, type] of Object.entries(map)) {
            if (lower.endsWith(ext)) return type;
        }
        return 'unknown';
    }
}

export default SubmissionDomainService;