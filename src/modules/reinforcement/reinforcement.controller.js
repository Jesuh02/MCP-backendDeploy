/**
 * ReinforcementController — Reinforcement question history.
 */
import Joi from 'joi';
import { ValidationError } from '../../shared/errors/index.js';

const normalizeText = (value = '') => String(value).trim().toLowerCase().replace(/\s+/g, ' ');

const questionItemSchema = Joi.object({
    question: Joi.string().trim().min(8).required(),
    options: Joi.array().items(Joi.string().trim().min(1).required()).min(4).required(),
    correctIndex: Joi.number().integer().min(0).required(),
    explanation: Joi.string().allow('', null).optional(),
});

// Accept both camelCase and snake_case field names from clients
const saveSessionSchema = Joi.object({
    userId: Joi.number().integer().optional(),
    user_id: Joi.number().integer().optional(),
    courseId: Joi.number().integer().optional(),
    course_id: Joi.number().integer().optional(),
    topicId: Joi.number().integer().allow(null).optional(),
    topic_id: Joi.number().integer().allow(null).optional(),
    taskId: Joi.number().integer().allow(null).optional(),
    task_id: Joi.number().integer().allow(null).optional(),
    questions: Joi.alternatives().try(
        Joi.array().items(Joi.object()),
        Joi.string()
    ).required(),
}).options({ allowUnknown: true });

// Schema for saving questions with full uniqueness flow
const saveQuestionsSchema = Joi.object({
    userId: Joi.number().integer().optional(),
    user_id: Joi.number().integer().optional(),
    courseId: Joi.number().integer().optional(),
    course_id: Joi.number().integer().optional(),
    topicId: Joi.number().integer().allow(null).optional(),
    topic_id: Joi.number().integer().allow(null).optional(),
    taskId: Joi.number().integer().allow(null).optional(),
    task_id: Joi.number().integer().allow(null).optional(),
    questions: Joi.alternatives().try(
        Joi.array().items(questionItemSchema).min(1).max(10).custom((items, helpers) => {
            const seenQuestions = new Set();

            for (const item of items) {
                const normalizedQuestion = normalizeText(item.question);
                if (seenQuestions.has(normalizedQuestion)) {
                    return helpers.error('any.invalid', { message: 'questions must be unique by question text' });
                }
                seenQuestions.add(normalizedQuestion);

                const uniqueOptions = new Set(item.options.map(option => normalizeText(option)));
                if (uniqueOptions.size < 4) {
                    return helpers.error('any.invalid', { message: 'each question must contain at least 4 unique options' });
                }

                if (item.correctIndex >= item.options.length) {
                    return helpers.error('any.invalid', { message: 'correctIndex is out of range for question options' });
                }
            }

            return items;
        }, 'strict question uniqueness validation'),
        Joi.string()
    ).required(),
}).options({ allowUnknown: true });

export class ReinforcementController {
    /**
     * @param {object} deps
     * @param {import('../../../domain/services/ReinforcementDomainService.js').ReinforcementDomainService} deps.reinforcementService
     * @param {import('../../../domain/services/LearningContextService.js').LearningContextService} [deps.learningContextService]
     */
    constructor({ reinforcementService, learningContextService = null }) {
        this.reinforcementService = reinforcementService;
        this.learningContextService = learningContextService;
    }

    saveSession = async(req, res, next) => {
        try {
            const { error, value } = saveSessionSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            // Normalize snake_case → camelCase, fallback to req.user from auth middleware
            const normalized = {
                userId: value.userId || value.user_id || req.user?.userId || req.user?.id || null,
                courseId: value.courseId || value.course_id,
                topicId: value.topicId || value.topic_id || null,
                taskId: value.taskId || value.task_id || null,
                questions: value.questions,
            };

            if (!normalized.userId) {
                return next(new ValidationError('userId is required (send in body or authenticate via JWT)'));
            }
            if (!normalized.courseId) {
                return next(new ValidationError('courseId is required'));
            }

            const result = await this.reinforcementService.saveSession(normalized);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /**
     * POST /save-questions — Save questions with full uniqueness (hash + embedding + semantic)
     * Called by Android after receiving questions from /procesar-prompt
     * Uses MCPService flow: session → hash check → embedding → semantic check → save
     */
    saveQuestions = async(req, res, next) => {
        try {
            const { error, value } = saveQuestionsSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const normalized = {
                userId: value.userId || value.user_id || req.user?.userId || req.user?.id || null,
                courseId: value.courseId || value.course_id,
                topicId: value.topicId || value.topic_id || null,
                taskId: value.taskId || value.task_id || null,
                questions: value.questions,
            };

            if (!normalized.userId) {
                return next(new ValidationError('userId is required'));
            }
            if (!normalized.courseId) {
                return next(new ValidationError('courseId is required'));
            }

            console.log(`📝 [ReinforcementController] saveQuestions: userId=${normalized.userId}, courseId=${normalized.courseId}, topicId=${normalized.topicId}, taskId=${normalized.taskId}, questions=${Array.isArray(normalized.questions) ? normalized.questions.length : 'string'}`);

            const result = await this.reinforcementService.saveSession(normalized);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /**
     * POST /ingest-context
     * Manual trigger to ensure RAG documents exist for a task.
     * Checks content_items and ingests them into rag_documents if missing.
     */
    ingestContext = async(req, res, next) => {
        try {
            const taskId = parseInt(req.body.taskId || req.body.task_id);
            const courseId = parseInt(req.body.courseId || req.body.course_id);
            const topicId = req.body.topicId || req.body.topic_id ? parseInt(req.body.topicId || req.body.topic_id) : null;

            if (!taskId || !courseId) {
                return next(new ValidationError('taskId and courseId are required'));
            }

            const result = await this.reinforcementService.ensureContentIngested(courseId, taskId, topicId);

            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getHistory = async(req, res, next) => {
        try {
            const userId = parseInt(req.params.userId);
            const courseId = parseInt(req.params.courseId);
            const result = await this.reinforcementService.getHistory(userId, courseId, req.query);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /**
     * GET /existing-questions?courseId=X&topicId=Y&taskId=Z
     * Returns full question objects already stored for this user+course+topic+task
     * so the client can use them for deduplication before LLM generation.
     */
    getExistingQuestions = async(req, res, next) => {
        try {
            const userId = req.user?.userId || req.user?.id;
            const courseId = parseInt(req.query.courseId || req.query.course_id);
            const topicId = req.query.topicId || req.query.topic_id ? parseInt(req.query.topicId || req.query.topic_id) : null;
            const taskId = req.query.taskId || req.query.task_id ? parseInt(req.query.taskId || req.query.task_id) : null;

            if (!userId) return next(new ValidationError('Authentication required'));
            if (!courseId) return next(new ValidationError('courseId is required'));

            const result = await this.reinforcementService.getExistingQuestions(userId, courseId, topicId, taskId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getMySessions = async(req, res, next) => {
        try {
            const result = await this.reinforcementService.getUserSessions(req.user.userId, req.query);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /**
     * GET /learning-context?courseId=X&topicId=Y&taskId=Z
     *
     * Endpoint unificado que retorna TODO el contexto de aprendizaje en una
     * sola llamada: tema, tarea, contenido RAG, archivos procesados y
     * preguntas existentes para deduplicación.
     *
     * El cliente Android usa esto para construir el prompt del LLM con datos
     * completos y verificados, eliminando múltiples llamadas API separadas.
     *
     * Respuesta incluye:
     *   - topic: { id, name, description }
     *   - task: { id, title, description }
     *   - ragContent: texto completo de documentos procesados
     *   - ragFiles: lista de archivos fuente
     *   - existingQuestions: preguntas previas para evitar duplicados
     *   - contentItems: metadatos de archivos adjuntos
     */
    getLearningContext = async(req, res, next) => {
        try {
            if (!this.learningContextService) {
                return next(new ValidationError('LearningContextService not configured'));
            }

            const _parseId = (v) => { const n = parseInt(v); return isNaN(n) ? null : n; };
            const courseId = _parseId(req.query.courseId || req.query.course_id);
            const topicId = _parseId(req.query.topicId || req.query.topic_id);
            const taskId = _parseId(req.query.taskId || req.query.task_id);
            const userId = req.user?.userId || req.user?.id || null;
            // Optional: explicit chunk page override (auto-calculated from history if omitted)
            const sessionIndex = req.query.sessionIndex != null
                ? _parseId(req.query.sessionIndex) : null;
            // Hybrid Retrieval params: query for semantic search, mode selection
            const query = req.query.query || req.query.q || null;
            const retrievalMode = req.query.retrievalMode || req.query.mode || 'auto';

            if (!courseId) {
                return next(new ValidationError('courseId is required'));
            }

            const result = await this.learningContextService.buildLearningContext({
                courseId, topicId, taskId, userId, sessionIndex, query, retrievalMode,
            });

            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /**
     * GET /rag-content?courseId=X&topicId=Y&taskId=Z
     * Returns raw text content from rag_documents for strict prompt grounding.
     * The client uses this to build prompts that prevent LLM hallucination.
     */
    getRagContent = async(req, res, next) => {
        try {
            const courseId = parseInt(req.query.courseId || req.query.course_id);
            const topicId = req.query.topicId || req.query.topic_id ? parseInt(req.query.topicId || req.query.topic_id) : null;
            const taskId = req.query.taskId || req.query.task_id ? parseInt(req.query.taskId || req.query.task_id) : null;

            if (!courseId) {
                return next(new ValidationError('courseId is required'));
            }

            const result = await this.reinforcementService.getRagContent(courseId, topicId, taskId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default ReinforcementController;

