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

export class MCPDomainService {
    constructor({
            userRepository,
            courseRepository,
            taskRepository,
            submissionRepository,
            notificationService,
            llmPort,
            supabaseService,
        }) {
            this.userRepo = userRepository;
            this.courseRepo = courseRepository;
            this.taskRepo = taskRepository;
            this.submissionRepo = submissionRepository;
            this.notificationService = notificationService;
            this.llm = llmPort;
            this.supabase = supabaseService || null;
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

            for (const subject of plan.subjects) {
                const subjectRow = await execInsert(
                    `INSERT INTO subjects (name, description, course_id, created_by)
                     VALUES ('${esc(subject.name)}', '${esc(subject.description)}', ${courseId}, ${userId})
                     RETURNING id`,
                );
                const subjectId = subjectRow?.id;
                if (!subjectId) continue;

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

            return Result.ok({ courseId, topicsCreated, tasksCreated });
        } catch (err) {
            return Result.fail(new ValidationError(`createCourseStructure falló: ${err.message}`));
        }
    }

    /**
     * Envía notificación vía MCP.
     * @param {{ userId: number, title: string, message: string, type?: string }} params
     * @returns {Promise<Result>}
     */
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

