/**
 * MCPDomainService — Caso de uso para el protocolo MCP (Model Context Protocol).
 *
 * Expone herramientas MCP (query_database, get_user_info, get_course_info, etc.)
 * como operaciones de dominio, delegando a los repositorios existentes.
 *
 * NO importa nada de infraestructura.
 */

import { Result } from '../../shared/Result.js';
import { ValidationError, NotFoundError } from '../../shared/errors/index.js';
import { getCurrentTenantId, hasTenantClient, runInTenantContext } from '../../config/tenantRegistry.js';

export class MCPDomainService {
    constructor({
            userRepository,
            courseRepository,
            taskRepository,
            submissionRepository,
            notificationService,
            llmPort,
            supabaseService,
            subjectRepository,
            fileStoragePort,
        }) {
            this.userRepo = userRepository;
            this.courseRepo = courseRepository;
            this.taskRepo = taskRepository;
            this.submissionRepo = submissionRepository;
            this.notificationService = notificationService;
            this.llm = llmPort;
            this.supabase = supabaseService || null;
            this.subjectRepo = subjectRepository || null;
            this.storage = fileStoragePort || null;
        }
        /**
         * Obtiene el schema de la base de datos.
         * @returns {Promise<Result>}
         */
    async getDatabaseSchema() {
        try {
            if (this.supabase && typeof this.supabase.getDatabaseSchema === 'function') {
                const ddl = await this.supabase.getDatabaseSchema();
                return Result.ok(ddl);
            }
            // Fallback: ejecutar directamente la consulta information_schema
            return Result.fail(new ValidationError('supabaseService no disponible para obtener el esquema'));
        } catch (err) {
            return Result.fail(new ValidationError(`Schema fetch falló: ${err.message}`));
        }
    }

    /**
     * Ejecuta una consulta SQL cruda contra la base de datos.
     * @param {string} query - Sentencia SQL (SELECT/INSERT/UPDATE/DELETE/WITH).
     * @returns {Promise<Result>}
     */
    async executeQuery(query) {
        if (!query || typeof query !== 'string' || !query.trim()) {
            return Result.fail(new ValidationError('query es requerido y debe ser una cadena SQL no vacía'));
        }
        if (!this.supabase || typeof this.supabase.executeRawSQL !== 'function') {
            return Result.fail(new ValidationError('supabaseService no disponible para ejecutar consultas'));
        }
        try {
            const data = await this.supabase.executeRawSQL(query);
            return Result.ok({ query, results: data, rowCount: Array.isArray(data) ? data.length : null });
        } catch (err) {
            return Result.fail(new ValidationError(`Ejecución SQL falló: ${err.message}`));
        }
    }

    /**
     * Obtiene información de un usuario.
     * @param {{ userId?: number, username?: string }} params
     * @returns {Promise<Result>}
     */
    async getUserInfo({ userId, username }) {
        try {
            let user;
            if (userId) {
                user = await this.userRepo.findById(userId);
            } else if (username) {
                user = await this.userRepo.findByUsername(username);
            } else {
                return Result.fail(new ValidationError('userId o username es requerido'));
            }

            if (!user) return Result.fail(new NotFoundError('Usuario'));
            return Result.ok(user);
        } catch (err) {
            return Result.fail(new ValidationError(`getUserInfo falló: ${err.message}`));
        }
    }

    /**
     * Obtiene información de un curso.
     * @param {number} courseId
     * @returns {Promise<Result>}
     */
    async getCourseInfo(courseId) {
        if (!courseId) return Result.fail(new ValidationError('courseId es requerido'));

        try {
            const course = await this.courseRepo.findById(courseId);
            if (!course) return Result.fail(new NotFoundError('Curso'));
            return Result.ok(course);
        } catch (err) {
            return Result.fail(new ValidationError(`getCourseInfo falló: ${err.message}`));
        }
    }

    /**
     * Obtiene submissions de una tarea.
     * @param {number} taskId
     * @returns {Promise<Result>}
     */
    async getTaskSubmissions(taskId) {
        if (!taskId) return Result.fail(new ValidationError('taskId es requerido'));

        try {
            const submissions = await this.submissionRepo.findByTaskId(taskId);
            return Result.ok(submissions);
        } catch (err) {
            return Result.fail(new ValidationError(`getTaskSubmissions falló: ${err.message}`));
        }
    }

    /**
     * Crea la estructura completa de un curso (course → subjects → topics → tasks) en la BD.
     * @param {{ plan: Object, userId: number }} params
     * @returns {Promise<Result>}
     */
    async createCourseStructure({ plan, userId }) {
        if (!plan || !plan.title || !Array.isArray(plan.subjects) || plan.subjects.length === 0) {
            return Result.fail(new ValidationError('plan es requerido con title y al menos un subject'));
        }
        if (!userId) {
            return Result.fail(new ValidationError('userId es requerido para crear el curso'));
        }
        if (!this.supabase || typeof this.supabase.executeRawSQL !== 'function') {
            return Result.fail(new ValidationError('supabaseService no disponible para crear el curso'));
        }

        const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");
        const execInsert = async (sql) => {
            const data = await this.supabase.executeRawSQL(sql);
            return Array.isArray(data) ? data[0] : null;
        };

        try {
            const courseRow = await execInsert(
                `INSERT INTO courses (title, description, category, price, is_premium, is_active, creator_user_id)
                 VALUES ('${esc(plan.title)}', '${esc(plan.description)}', '${esc(plan.category || 'General')}', 0, false, true, ${userId})
                 RETURNING id`,
            );
            const courseId = courseRow?.id;
            if (!courseId) throw new Error('No se obtuvo el id del curso recién creado');

            let topicsCreated = 0;
            let tasksCreated = 0;
            const subjectsForThumbnails = [];

            for (const subject of plan.subjects) {
                const subjectRow = await execInsert(
                    `INSERT INTO subjects (name, description, course_id, created_by)
                     VALUES ('${esc(subject.name)}', '${esc(subject.description)}', ${courseId}, ${userId})
                     RETURNING id`,
                );
                const subjectId = subjectRow?.id;
                if (!subjectId) continue;
                subjectsForThumbnails.push({
                    subjectId,
                    name: subject.name,
                    description: subject.description || '',
                });

                for (const topic of (subject.topics || [])) {
                    const topicRow = await execInsert(
                        `INSERT INTO topics (name, description, materia_id, created_by)
                         VALUES ('${esc(topic.title)}', '${esc(topic.description)}', ${subjectId}, ${userId})
                         RETURNING id`,
                    );
                    const topicId = topicRow?.id;
                    if (!topicId) continue;
                    topicsCreated++;

                    for (const task of (topic.tasks || [])) {
                        const dueExpr = task.dueWeek && Number.isInteger(task.dueWeek) && task.dueWeek > 0
                            ? `NOW() + INTERVAL '${task.dueWeek} weeks'`
                            : 'NULL';
                        const taskRow = await execInsert(
                            `INSERT INTO tasks (title, description, topic_id, due_date, created_by)
                             VALUES ('${esc(task.title)}', '${esc(task.description)}', ${topicId}, ${dueExpr}, ${userId})
                             RETURNING id`,
                        );
                        if (taskRow?.id) tasksCreated++;
                    }
                }
            }

            this._generateSubjectThumbnailsInBackground({
                courseId,
                courseTitle: plan.title,
                category: plan.category || 'General',
                subjects: subjectsForThumbnails,
            });

            return Result.ok({
                courseId,
                topicsCreated,
                tasksCreated,
                thumbnailsInProgress: Boolean(this.storage && this.storage.isAvailable && this.storage.isAvailable()),
            });
        } catch (err) {
            return Result.fail(new ValidationError(`createCourseStructure falló: ${err.message}`));
        }
    }

    /** Genera miniaturas IA para materias sin bloquear la creacion del curso. */
    _generateSubjectThumbnailsInBackground({ courseId, courseTitle, category, subjects }) {
        if (!Array.isArray(subjects) || subjects.length === 0) return;
        if (!this.storage || typeof this.storage.isAvailable !== 'function' || !this.storage.isAvailable()) return;
        if (!this.subjectRepo || typeof this.subjectRepo.update !== 'function') return;

        const bgTenantId = getCurrentTenantId();
        const runBackground = async () => {
            for (const subject of subjects) {
                try {
                    const { buffer, contentType, ext } = await this._generateThumbnailImage(
                        `${subject.name}, ${courseTitle}, ${category}, ${subject.description || 'materia academica educativa'}`,
                    );
                    const key = `courses/${courseId}/subjects/${subject.subjectId}/thumbnail_${Date.now()}.${ext}`;
                    const thumbnailUrl = await this.storage.uploadFile(buffer, key, contentType, buffer.length);
                    await this.subjectRepo.update(subject.subjectId, { thumbnailUrl });
                    console.log(`[MCPDomainService] Subject thumbnail uploaded: subjectId=${subject.subjectId}`);
                } catch (err) {
                    console.error(`[MCPDomainService] Subject thumbnail failed id=${subject.subjectId}: ${err.message}`);
                }
            }
        };

        setImmediate(() => {
            const job = (bgTenantId && hasTenantClient(bgTenantId))
                ? runInTenantContext(bgTenantId, runBackground)
                : runBackground();
            Promise.resolve(job).catch(err =>
                console.error(`[MCPDomainService] Subject thumbnail background job failed: ${err?.message || err}`));
        });
    }

    async _generateThumbnailImage(description) {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured for image generation');

        const imageModel = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image';
        const prompt = [
            `Professional, photorealistic educational subject thumbnail: ${String(description || '').slice(0, 240)}.`,
            'Realistic academic setting, relevant objects for the subject, natural light, high detail,',
            'clean 16:9 composition, no text overlays, no logos, no watermarks.',
        ].join(' ');

        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.OPENROUTER_REFERER || process.env.SITE_URL || 'https://coursev.app',
                'X-Title': 'CourseV',
            },
            body: JSON.stringify({
                model: imageModel,
                modalities: ['image', 'text'],
                messages: [{ role: 'user', content: prompt }],
            }),
            signal: AbortSignal.timeout(90_000),
        });
        if (!resp.ok) {
            const msg = await resp.text().catch(() => '');
            throw new Error(`OpenRouter image API ${resp.status}: ${msg.slice(0, 300)}`);
        }

        const json = await resp.json();
        const imageRef = this._extractImageRef(json?.choices?.[0]?.message);
        if (!imageRef) throw new Error(`OpenRouter image generation returned no image for model ${imageModel}`);
        return this._imageRefToBuffer(imageRef);
    }

    _extractImageRef(message) {
        const fromImages = message?.images?.[0]?.image_url?.url;
        if (fromImages) return fromImages;

        if (Array.isArray(message?.content)) {
            for (const block of message.content) {
                if ((block?.type === 'image_url' || block?.type === 'output_image') && block.image_url?.url) return block.image_url.url;
                if (block?.type === 'image' && block.source?.type === 'base64' && block.source?.data) {
                    return `data:${block.source.media_type || 'image/png'};base64,${block.source.data}`;
                }
                if (block?.type === 'image' && block.source?.url) return block.source.url;
                if (block?.inlineData?.data) return `data:${block.inlineData.mimeType || 'image/png'};base64,${block.inlineData.data}`;
                if (block?.data && block?.mimeType) return `data:${block.mimeType};base64,${block.data}`;
            }
        }

        if (typeof message?.content === 'string') {
            const mdImg = message.content.match(/!\[.*?\]\((data:image\/[^)]+)\)/);
            if (mdImg) return mdImg[1];
            const dataUri = message.content.match(/(data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{20,})/);
            if (dataUri) return dataUri[1];
        }

        return '';
    }

    async _imageRefToBuffer(ref) {
        const dataMatch = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(ref);
        if (dataMatch) {
            const contentType = dataMatch[1].toLowerCase();
            const ext = (contentType.split('/')[1] || 'png').replace('jpeg', 'jpg');
            return { buffer: Buffer.from(dataMatch[2], 'base64'), contentType, ext };
        }

        const imgResp = await fetch(ref, { signal: AbortSignal.timeout(30_000) });
        if (!imgResp.ok) throw new Error(`Image download failed: ${imgResp.status}`);
        const contentType = (imgResp.headers.get('content-type') || 'image/png').split(';')[0].toLowerCase();
        const ext = (contentType.split('/')[1] || 'png').replace('jpeg', 'jpg');
        return { buffer: Buffer.from(await imgResp.arrayBuffer()), contentType, ext };
    }

    async sendNotification({ userId, title, message, type }) {
        if (!userId || !title || !message) {
            return Result.fail(new ValidationError('userId, title y message son requeridos'));
        }

        try {
            const result = await this.notificationService.sendNotification({
                userId,
                title,
                message,
                type: type || 'mcp',
            });
            return result; // NotificationDomainService already returns Result
        } catch (err) {
            return Result.fail(new ValidationError(`Notificación MCP falló: ${err.message}`));
        }
    }

    /**
     * Lista de herramientas MCP disponibles.
     * @returns {Object[]}
     */
    getToolsList() {
        return [
            { name: 'query_database', description: 'Execute SQL queries (SELECT, INSERT, UPDATE, DELETE) on the Supabase database', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
            { name: 'get_database_schema', description: 'Get complete database schema', inputSchema: { type: 'object', properties: {} } },
            { name: 'create_course_structure', description: 'Creates a complete course with subjects, topics, and tasks in the database. Use when a user wants to create a new course.', inputSchema: { type: 'object', properties: { plan: { type: 'object', description: 'Course plan object with title, description, category, subjects array' }, userId: { type: 'number', description: 'Creator user ID' } }, required: ['plan', 'userId'] } },
            { name: 'get_user_info', description: 'Get user information', inputSchema: { type: 'object', properties: { userId: { type: 'number' }, username: { type: 'string' } } } },
            { name: 'get_course_info', description: 'Get course information', inputSchema: { type: 'object', properties: { courseId: { type: 'number' } }, required: ['courseId'] } },
            { name: 'get_task_submissions', description: 'Get task submissions', inputSchema: { type: 'object', properties: { taskId: { type: 'number' } }, required: ['taskId'] } },
            { name: 'send_notification', description: 'Send notification to user', inputSchema: { type: 'object', properties: { userId: { type: 'number' }, title: { type: 'string' }, message: { type: 'string' }, type: { type: 'string' } }, required: ['userId', 'title', 'message'] } },
        ];
    }
}
export default MCPDomainService;

