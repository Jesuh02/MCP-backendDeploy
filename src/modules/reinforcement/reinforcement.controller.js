/**
 * ReinforcementController — Reinforcement question history.
 */
import Joi from 'joi';
import { ValidationError } from '../../shared/errors/index.js';

// ─── In-memory job store for polling-based generation ────────────────────────
// Jobs are cleaned up after 2 hours to allow long-running first-time ingestion.
const _jobs = new Map();
let _jobSeq = 0;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

function _createJob() {
    const jobId = `rljob_${Date.now()}_${++_jobSeq}`;
    _jobs.set(jobId, { status: 'pending', questions: null, error: null, createdAt: Date.now() });
    return jobId;
}

function _cleanStaleJobs() {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of _jobs) {
        if (job.createdAt < cutoff) _jobs.delete(id);
    }
}
// Run cleanup every 10 minutes
setInterval(_cleanStaleJobs, 10 * 60 * 1000).unref?.();

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

const coachConversationSchema = Joi.object({
    userId: Joi.number().integer().optional(),
    user_id: Joi.number().integer().optional(),
    courseId: Joi.number().integer().optional(),
    course_id: Joi.number().integer().optional(),
    topicId: Joi.number().integer().allow(null).optional(),
    topic_id: Joi.number().integer().allow(null).optional(),
    taskId: Joi.number().integer().allow(null).optional(),
    task_id: Joi.number().integer().allow(null).optional(),
    difficulty: Joi.string().valid('EASY', 'INTERMEDIATE', 'HARD').default('HARD'),
    message: Joi.string().trim().min(2).max(4000).required(),
    history: Joi.array().items(Joi.object({
        role: Joi.string().valid('user', 'assistant').required(),
        content: Joi.string().allow('').max(4000).required(),
        stance: Joi.string().allow('', null).optional(),
        question: Joi.string().allow('', null).optional(),
    }).unknown(true)).max(12).default([]),
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

    /**
     * GET /cached-questions?courseId=X&topicId=Y&taskId=Z&difficulty=HARD
     * Returns cached pre-generated questions (instant, <100ms).
     * Returns { questions: [], generating: true/false } if cache miss.
     */
    getCachedQuestions = async(req, res, next) => {
        try {
            const _parseId = (v) => { const n = parseInt(v); return isNaN(n) ? null : n; };
            const userId = req.user?.userId || req.user?.id;
            const courseId = _parseId(req.query.courseId || req.query.course_id);
            const topicId = _parseId(req.query.topicId || req.query.topic_id);
            const taskId = _parseId(req.query.taskId || req.query.task_id);
            const difficulty = req.query.difficulty || 'HARD';

            if (!userId) return next(new ValidationError('Authentication required'));
            if (!courseId) return next(new ValidationError('courseId is required'));

            const result = await this.reinforcementService.getCachedQuestions(userId, courseId, topicId, taskId, difficulty);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /**
     * POST /prefetch — Fire-and-forget: start background question generation.
     * Client should call this as soon as the reinforcement screen loads.
     * Then poll GET /cached-questions to check if ready.
     */
    prefetch = async(req, res, next) => {
        try {
            const userId = req.user?.userId || req.user?.id || parseInt(req.body.userId || req.body.user_id);
            const courseId = parseInt(req.body.courseId || req.body.course_id);
            const topicId = req.body.topicId || req.body.topic_id ? parseInt(req.body.topicId || req.body.topic_id) : null;
            const taskId = req.body.taskId || req.body.task_id ? parseInt(req.body.taskId || req.body.task_id) : null;
            const difficulty = req.body.difficulty || 'HARD';

            if (!userId) return next(new ValidationError('userId is required'));
            if (!courseId) return next(new ValidationError('courseId is required'));

            const result = await this.reinforcementService.prefetchQuestions(userId, courseId, topicId, taskId, difficulty);
            if (result.isFail()) return next(result.getError());
            res.status(202).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /**
     * POST /generate-questions — Unified server-side generation:
     *   1. Fetches learning context internally
     *   2. Calls LLM to generate questions
     *   3. Returns questions immediately
     *   4. Saves with embeddings in background (non-blocking)
     *
     * This replaces the 3-step client flow:
     *   GET /learning-context → POST /procesar-prompt → POST /save-questions
     */
    generateQuestions = async(req, res, next) => {
        try {
            const userId = req.user?.userId || req.user?.id || parseInt(req.body.userId || req.body.user_id);
            const courseId = parseInt(req.body.courseId || req.body.course_id);
            const topicId = req.body.topicId || req.body.topic_id ? parseInt(req.body.topicId || req.body.topic_id) : null;
            const taskId = req.body.taskId || req.body.task_id ? parseInt(req.body.taskId || req.body.task_id) : null;
            const difficulty = req.body.difficulty || 'HARD';
            const targetCount = parseInt(req.body.targetCount) || 10;
            const forceFresh = req.body.forceFresh === true || req.body.forceFresh === 'true';

            if (!userId) return next(new ValidationError('userId is required'));
            if (!courseId) return next(new ValidationError('courseId is required'));

            console.log(`🚀 [ReinforcementController] generateQuestions: userId=${userId}, courseId=${courseId}, topicId=${topicId}, taskId=${taskId}, difficulty=${difficulty}, target=${targetCount}, forceFresh=${forceFresh}`);

            const result = await this.reinforcementService.generateQuestions(userId, courseId, topicId, taskId, difficulty, targetCount, forceFresh);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /**
     * POST /start-generation — Kick off async question generation, return a jobId immediately.
     * The client then polls GET /poll-generation/:jobId until status === 'done'.
     */
    startGeneration = async(req, res, next) => {
        try {
            const userId = req.user?.userId || req.user?.id || parseInt(req.body.userId || req.body.user_id);
            const courseId = parseInt(req.body.courseId || req.body.course_id);
            const topicId = req.body.topicId || req.body.topic_id ? parseInt(req.body.topicId || req.body.topic_id) : null;
            const taskId = req.body.taskId || req.body.task_id ? parseInt(req.body.taskId || req.body.task_id) : null;
            const difficulty = req.body.difficulty || 'HARD';
            const targetCount = parseInt(req.body.targetCount) || 10;
            const forceFresh = req.body.forceFresh === true || req.body.forceFresh === 'true';

            if (!userId) return next(new ValidationError('userId is required'));
            if (!courseId) return next(new ValidationError('courseId is required'));

            const jobId = _createJob();
            console.log(`🚀 [ReinforcementController] startGeneration: jobId=${jobId}, userId=${userId}, courseId=${courseId}, topicId=${topicId}, taskId=${taskId}, difficulty=${difficulty}`);

            // Fire-and-forget: generation runs in background
            this.reinforcementService
                .generateQuestions(userId, courseId, topicId, taskId, difficulty, targetCount, forceFresh)
                .then(result => {
                    const job = _jobs.get(jobId);
                    if (!job) return; // job was cleaned up
                    if (result.isFail()) {
                        job.status = 'error';
                        job.error = result.getError()?.message || result.getError() || 'Generation failed';
                    } else {
                        const data = result.getValue();
                        job.status = 'done';
                        job.questions = data.questions || [];
                    }
                })
                .catch(err => {
                    const job = _jobs.get(jobId);
                    if (job) { job.status = 'error'; job.error = err.message || 'Generation failed'; }
                    console.error(`[ReinforcementController] startGeneration job ${jobId} failed:`, err.message);
                });

            res.status(202).json({ success: true, data: { jobId } });
        } catch (err) { next(err); }
    };

    /**
     * GET /poll-generation/:jobId — Check status of an async generation job.
     * Returns { status: 'pending'|'done'|'error', questions?, error? }
     */
    pollGeneration = async(req, res, next) => {
        try {
            const { jobId } = req.params;
            if (!jobId) return next(new ValidationError('jobId is required'));

            const job = _jobs.get(jobId);
            if (!job) {
                return res.json({
                    success: true,
                    data: {
                        status: 'error',
                        error: 'La sesión de generación expiró o no existe. Intenta iniciar una nueva generación.',
                    },
                });
            }

            if (job.status === 'done') {
                _jobs.delete(jobId); // clean up immediately once consumed
                return res.json({ success: true, data: { status: 'done', questions: job.questions } });
            }
            if (job.status === 'error') {
                _jobs.delete(jobId);
                return res.json({ success: true, data: { status: 'error', error: job.error } });
            }
            res.json({ success: true, data: { status: 'pending' } });
        } catch (err) { next(err); }
    };


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

    coachConversation = async(req, res, next) => {
        try {
            const { error, value } = coachConversationSchema.validate(req.body);
            if (error) return next(error);

            const parseNullableId = (v) => {
                const n = parseInt(v);
                return Number.isFinite(n) ? n : null;
            };

            const userId = req.user?.userId || req.user?.id || value.userId || value.user_id || null;
            const courseId = parseNullableId(value.courseId || value.course_id);
            const topicId = parseNullableId(value.topicId || value.topic_id);
            const taskId = parseNullableId(value.taskId || value.task_id);

            if (!courseId) return next(new ValidationError('courseId is required'));

            const result = await this.reinforcementService.coachConversation({
                userId,
                courseId,
                topicId,
                taskId,
                difficulty: value.difficulty,
                message: value.message,
                history: value.history || [],
            });

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

