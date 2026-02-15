/**
 * LearningContextService — Servicio de dominio para construir contexto de aprendizaje.
 *
 * Orquesta la recopilación de toda la información necesaria para generar
 * preguntas de refuerzo: tema, tarea, archivos, contenido RAG y preguntas
 * existentes para deduplicación.
 *
 * Principios SOLID aplicados:
 *   - Single Responsibility (S): ÚNICO propósito — construir contexto de aprendizaje.
 *   - Open/Closed (O): extensible a nuevas fuentes de contexto sin modificar el core.
 *   - Dependency Inversion (D): depende de puertos abstractos, no de implementaciones.
 *   - Interface Segregation (I): consume solo los métodos que necesita de cada puerto.
 *
 * Arquitectura Hexagonal:
 *   - Este servicio vive en el dominio y NO conoce infraestructura.
 *   - Los repositorios y servicios RAG se inyectan como puertos.
 */
import { Result } from '../../shared/Result.js';

export class LearningContextService {
    /**
     * @param {object} deps — Dependencias inyectadas (puertos).
     * @param {import('../ports/out/ITopicRepository.js').ITopicRepository} deps.topicRepository
     * @param {import('../ports/out/ITaskRepository.js').ITaskRepository} deps.taskRepository
     * @param {import('../ports/out/IContentItemRepository.js').IContentItemRepository} deps.contentItemRepository
     * @param {import('./RAGService.js').RAGService} deps.ragService — Puerto RAG para contenido e ingesta.
     * @param {import('./MCPService.js').MCPService} deps.mcpService — Para obtener preguntas existentes.
     */
    constructor({ topicRepository, taskRepository, contentItemRepository, ragService, mcpService }) {
        this.topicRepo = topicRepository;
        this.taskRepo = taskRepository;
        this.contentItemRepo = contentItemRepository;
        this.ragService = ragService;
        this.mcpService = mcpService;
    }

    /**
     * Construye el contexto completo de aprendizaje para generación de preguntas.
     *
     * Flujo:
     * 1. Obtiene detalles del tema (título, descripción)
     * 2. Obtiene detalles de la tarea (título, descripción)
     * 3. Obtiene content_items asociados a la tarea y al tema
     * 4. Asegura que el contenido esté ingestado en RAG (rag_documents)
     * 5. Obtiene el contenido RAG de forma PROGRESIVA — cada sesión usa
     *    una ventana diferente de chunks del documento, evitando que
     *    el LLM vea siempre el mismo contenido y genere duplicados.
     * 6. Obtiene preguntas existentes para deduplicación
     *
     * @param {object} params
     * @param {number} params.courseId
     * @param {number} [params.topicId]
     * @param {number} [params.taskId]
     * @param {number} [params.userId] — Para obtener preguntas existentes.
     * @param {number} [params.sessionIndex] — Explicit page override (auto-calculated from history if omitted).
     * @returns {Promise<Result<LearningContext>>}
     */
    async buildLearningContext({ courseId, topicId = null, taskId = null, userId = null, sessionIndex = null }) {
            try {
                if (!courseId) {
                    return Result.fail(new Error('courseId es requerido'));
                }

                // ── 1. Obtener detalles del tema ──
                const topicDetails = await this._getTopicDetails(topicId);
            // ── 2. Obtener detalles de la tarea ──
            const taskDetails = await this._getTaskDetails(taskId);

            // ── 3. Obtener content_items ──
            const contentItems = await this._getContentItems(taskId, topicId);

            // ── 4. Asegurar ingesta RAG ──
            const ingestionResult = await this._ensureRagIngestion(courseId, topicId, taskId, contentItems);

            // ── 5. Obtener preguntas existentes (needed BEFORE RAG to compute sessionIndex) ──
            const existingQuestions = await this._getExistingQuestions(userId, courseId, topicId, taskId);

            // ── 6. Obtener contenido RAG de forma PROGRESIVA ──
            // Auto-calculate session index: each session generates ~10 questions,
            // so sessionIndex = floor(existingCount / 10) advances through the document.
            const effectiveSessionIndex = sessionIndex ?? Math.floor(existingQuestions.length / 10);
            const ragData = await this._getProgressiveRagContent(courseId, topicId, taskId, effectiveSessionIndex);

            // ── 7. Construir respuesta estructurada ──
            const learningContext = {
                topic: topicDetails,
                task: taskDetails,
                contentItems: contentItems.map(item => ({
                    id: item.id,
                    title: item.title,
                    contentType: item.content_type || item.contentType || 'text',
                    hasBody: !!(item.body && item.body.length > 50),
                })),
                ragContent: ragData.content || '',
                ragFiles: ragData.files || [],
                ragChunks: ragData.chunks || 0,
                ragPage: ragData.page ?? 0,
                ragTotalPages: ragData.totalPages ?? 1,
                ragTotalChunks: ragData.totalChunks ?? ragData.chunks ?? 0,
                existingQuestions: existingQuestions.map(q => ({
                    question: q.question || '',
                    options: q.options || [],
                    correctIndex: q.correctIndex ?? q.answer_index ?? 0,
                    explanation: q.explanation || '',
                })),
                existingQuestionCount: existingQuestions.length,
                ingestion: ingestionResult,
                contextReady: true,
            };

            console.log(
                `📚 [LearningContextService] Context built: topic="${topicDetails?.name || 'N/A'}", ` +
                `task="${taskDetails?.title || 'N/A'}", ragChunks=${ragData.chunks}/${ragData.totalChunks || '?'}, ` +
                `page=${(ragData.page ?? 0) + 1}/${ragData.totalPages ?? '?'}, ` +
                `files=${ragData.files?.length || 0}, existingQ=${existingQuestions.length}`
            );

            return Result.ok(learningContext);
        } catch (error) {
            console.error('[LearningContextService] buildLearningContext error:', error);
            return Result.fail(error);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // MÉTODOS PRIVADOS — Cada uno con responsabilidad única (SRP)
    // ═══════════════════════════════════════════════════════════

    /**
     * Obtiene título y descripción del tema.
     * @private
     */
    async _getTopicDetails(topicId) {
        if (!topicId || topicId <= 0) return null;
        try {
            const topic = await this.topicRepo.findById(topicId);
            if (!topic) return null;
            return {
                id: topic.id,
                name: topic.name || topic.title || '',
                description: topic.description || '',
                courseId: topic.course_id || topic.courseId || null,
            };
        } catch (error) {
            console.warn(`[LearningContextService] Error fetching topic ${topicId}:`, error.message);
            return null;
        }
    }

    /**
     * Obtiene título y descripción de la tarea.
     * @private
     */
    async _getTaskDetails(taskId) {
        if (!taskId || taskId <= 0) return null;
        try {
            const task = await this.taskRepo.findById(taskId);
            if (!task) return null;
            return {
                id: task.id,
                title: task.title || task.name || '',
                description: task.description || '',
                topicId: task.topic_id || task.topicId || null,
                dueDate: task.due_date || task.dueDate || null,
            };
        } catch (error) {
            console.warn(`[LearningContextService] Error fetching task ${taskId}:`, error.message);
            return null;
        }
    }

    /**
     * Obtiene content_items de la tarea y/o el tema.
     * Combina ambas fuentes sin duplicados.
     * @private
     */
    async _getContentItems(taskId, topicId) {
        const items = [];
        const seenIds = new Set();

        // Content items de la tarea
        if (taskId && taskId > 0) {
            try {
                const taskItems = await this.contentItemRepo.findByTask(taskId);
                for (const item of (taskItems || [])) {
                    if (!seenIds.has(item.id)) {
                        seenIds.add(item.id);
                        items.push(item);
                    }
                }
            } catch (error) {
                console.warn(`[LearningContextService] Error fetching task content items:`, error.message);
            }
        }

        // Content items del tema
        if (topicId && topicId > 0) {
            try {
                const topicItems = await this.contentItemRepo.findByTopic(topicId);
                for (const item of (topicItems || [])) {
                    if (!seenIds.has(item.id)) {
                        seenIds.add(item.id);
                        items.push(item);
                    }
                }
            } catch (error) {
                console.warn(`[LearningContextService] Error fetching topic content items:`, error.message);
            }
        }

        return items;
    }

    /**
     * Asegura que los content_items estén ingestados en rag_documents.
     * Solo procesa items con body > 50 chars que no estén ya ingestados.
     * @private
     */
    async _ensureRagIngestion(courseId, topicId, taskId, contentItems) {
        const result = { ingested: false, filesProcessed: 0, skipped: false };

        if (!this.ragService || !taskId || taskId <= 0) {
            return result;
        }

        try {
            // Verificar si ya existe contenido RAG para este task
            const exists = await this.ragService.vectorStore.exists({
                taskId,
                courseId,
                ...(topicId ? { topicId } : {}),
            });

            if (exists) {
                result.skipped = true;
                return result;
            }

            // Ingestar cada content_item con body suficiente
            const ingestableItems = contentItems.filter(item => item.body && item.body.length > 50);

            for (const item of ingestableItems) {
                const effectiveTopicId = topicId || item.topic_id;
                await this.ragService.ingestDocument(item.body, {
                    courseId,
                    taskId,
                    topicId: effectiveTopicId,
                    contentItemId: item.id,
                    fileName: item.title || `content_${item.id}`,
                    fileType: 'txt',
                });
                result.filesProcessed++;
            }

            result.ingested = result.filesProcessed > 0;
            return result;
        } catch (error) {
            console.warn('[LearningContextService] RAG ingestion error (non-blocking):', error.message);
            return result;
        }
    }

    /**
     * Obtiene el contenido RAG procesado (texto completo reconstruido).
     * @private
     */
    async _getRagContent(courseId, topicId, taskId) {
        if (!this.ragService) {
            return { content: '', chunks: 0, files: [] };
        }

        try {
            const filter = { courseId };
            if (topicId && topicId > 0) filter.topicId = topicId;
            if (taskId && taskId > 0) filter.taskId = taskId;

            return await this.ragService.getRagContent(filter);
        } catch (error) {
            console.warn('[LearningContextService] getRagContent error (non-blocking):', error.message);
            return { content: '', chunks: 0, files: [] };
        }
    }

    /**
     * Obtiene contenido RAG de forma progresiva — cada sesión devuelve una
     * ventana diferente de chunks del documento.
     *
     * Esto resuelve el problema de que el LLM siempre ve el mismo contenido
     * y genera preguntas duplicadas.
     *
     * @param {number} courseId
     * @param {number|null} topicId
     * @param {number|null} taskId
     * @param {number} sessionIndex — Controla qué ventana de chunks retornar.
     * @returns {Promise<{ content: string, chunks: number, files: string[], page: number, totalPages: number, totalChunks: number }>}
     * @private
     */
    async _getProgressiveRagContent(courseId, topicId, taskId, sessionIndex) {
        if (!this.ragService) {
            return { content: '', chunks: 0, files: [], page: 0, totalPages: 0, totalChunks: 0 };
        }

        try {
            const filter = { courseId };
            if (topicId && topicId > 0) filter.topicId = topicId;
            if (taskId && taskId > 0) filter.taskId = taskId;

            // Use progressive chunking if the method exists, otherwise fall back
            if (typeof this.ragService.getProgressiveRagContent === 'function') {
                return await this.ragService.getProgressiveRagContent(filter, sessionIndex);
            }

            // Fallback for backward compatibility
            const result = await this.ragService.getRagContent(filter);
            return { ...result, page: 0, totalPages: 1, totalChunks: result.chunks };
        } catch (error) {
            console.warn('[LearningContextService] getProgressiveRagContent error (non-blocking):', error.message);
            return { content: '', chunks: 0, files: [], page: 0, totalPages: 0, totalChunks: 0 };
        }
    }

    /**
     * Obtiene preguntas existentes para deduplicación.
     * @private
     */
    async _getExistingQuestions(userId, courseId, topicId, taskId) {
        if (!userId || userId <= 0 || !this.mcpService) {
            return [];
        }

        try {
            const history = await this.mcpService.getReinforcementHistory(
                userId, courseId, topicId || null, taskId || null
            );

            if (!Array.isArray(history)) return [];

            return history.map(h => ({
                question: h.question || '',
                options: h.options || [],
                correctIndex: h.answer_index ?? 0,
                explanation: h.explanation || '',
            }));
        } catch (error) {
            console.warn('[LearningContextService] getExistingQuestions error (non-blocking):', error.message);
            return [];
        }
    }
}

export default LearningContextService;
