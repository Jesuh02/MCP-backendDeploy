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
import { R2StorageAdapter } from '../storage/infrastructure/r2.storage.adapter.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch (_) { pdfParse = null; }

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
    async buildLearningContext({ courseId, topicId = null, taskId = null, userId = null, sessionIndex = null, query = null, retrievalMode = 'auto' }) {
            try {
                if (!courseId) {
                    return Result.fail(new Error('courseId es requerido'));
                }

                // ── PARALLEL PHASE 1: Fetch topic, task, content items, and existing questions concurrently ──
                const [topicDetails, taskDetails, contentItemsResult, existingQuestions] = await Promise.all([
                    this._getTopicDetails(topicId),
                    this._getTaskDetails(taskId),
                    this._getContentItems(taskId, topicId),
                    this._getExistingQuestions(userId, courseId, topicId, taskId),
                ]);

            const { all: contentItems, taskItems: taskContentItems, topicItems: topicContentItems } = contentItemsResult;

            // ── PARALLEL PHASE 2: RAG ingestion + RAG content retrieval concurrently ──
            // Auto-calculate session index: each session generates ~10 questions,
            // so sessionIndex = floor(existingCount / 10) advances through the document.
            const effectiveSessionIndex = sessionIndex ?? Math.floor(existingQuestions.length / 10);
            const effectiveMode = this._resolveRetrievalMode(retrievalMode, query);

            // Start ingestion (non-blocking) and RAG retrieval in parallel
            const ingestionPromise = this._ensureRagIngestion(courseId, topicId, taskId, contentItems);

            let ragData;
            if (effectiveMode === 'hybrid' || effectiveMode === 'semantic') {
                const dbQuery = this._buildSearchQuery(topicDetails, taskDetails);
                const searchQuery = dbQuery || query || '';
                ragData = await this._getHybridRagContent(
                    courseId, topicId, taskId, searchQuery,
                    effectiveMode === 'hybrid' ? effectiveSessionIndex : null,
                    topicDetails, taskDetails
                );
            } else {
                ragData = await this._getProgressiveRagContent(courseId, topicId, taskId, effectiveSessionIndex);
            }

            // ── 7. Construir respuesta estructurada ──
            const mapContentItem = (item) => ({
                id: item.id,
                title: item.title,
                contentType: item.content_type || item.contentType || 'text',
                hasBody: !!(item.body && item.body.length > 50),
                source: item._source || 'unknown',
            });

            const learningContext = {
                topic: topicDetails,
                task: taskDetails,
                // Todos los content_items combinados (backward-compatible)
                contentItems: contentItems.map(mapContentItem),
                // Content items separados por origen para prompt diferenciado
                topicContentItems: topicContentItems.map(mapContentItem),
                taskContentItems: taskContentItems.map(mapContentItem),
                ragContent: ragData.content || '',
                ragFiles: ragData.files || [],
                ragChunks: ragData.chunks || 0,
                ragPage: ragData.page ?? 0,
                ragTotalPages: ragData.totalPages ?? 1,
                ragTotalChunks: ragData.totalChunks ?? ragData.chunks ?? 0,
                // Hybrid retrieval metadata
                retrievalMode: effectiveMode,
                semanticHits: ragData.semanticHits ?? 0,
                expandedChunks: ragData.expandedChunks ?? 0,
                usedProgressiveFallback: ragData.usedProgressiveFallback ?? false,
                reranked: ragData.reranked ?? false,
                rerankMethod: ragData.rerankMethod ?? 'none',
                existingQuestions: existingQuestions.map(q => ({
                    question: q.question || '',
                    options: q.options || [],
                    correctIndex: q.correctIndex ?? q.answer_index ?? 0,
                    explanation: q.explanation || '',
                })),
                existingQuestionCount: existingQuestions.length,
                ingestion: await ingestionPromise,
                contextReady: true,
            };

            console.log(
                `📚 [LearningContextService] Context built: topic="${topicDetails?.name || 'N/A'}", ` +
                `task="${taskDetails?.title || 'N/A'}", mode=${effectiveMode}, ragChunks=${ragData.chunks}/${ragData.totalChunks || '?'}, ` +
                `page=${(ragData.page ?? 0) + 1}/${ragData.totalPages ?? '?'}, ` +
                `semanticHits=${ragData.semanticHits ?? 0}, expanded=${ragData.expandedChunks ?? 0}, ` +
                `reranked=${ragData.reranked ?? false} (${ragData.rerankMethod ?? 'none'}), ` +
                `files=${ragData.files?.length || 0}, topicFiles=${topicContentItems.length}, taskFiles=${taskContentItems.length}, ` +
                `existingQ=${existingQuestions.length}`
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
     * Combina ambas fuentes sin duplicados y etiqueta cada item con su origen.
     * @private
     * @returns {{ all: Array, taskItems: Array, topicItems: Array }}
     */
    async _getContentItems(taskId, topicId) {
        const all = [];
        const taskItems = [];
        const topicItems = [];
        const seenIds = new Set();

        // Content items de la tarea
        if (taskId && taskId > 0) {
            try {
                const items = await this.contentItemRepo.findByTask(taskId);
                for (const item of (items || [])) {
                    if (!seenIds.has(item.id)) {
                        seenIds.add(item.id);
                        const labeled = { ...item, _source: 'task' };
                        all.push(labeled);
                        taskItems.push(labeled);
                    }
                }
            } catch (error) {
                console.warn(`[LearningContextService] Error fetching task content items:`, error.message);
            }
        }

        // Content items del tema
        if (topicId && topicId > 0) {
            try {
                const items = await this.contentItemRepo.findByTopic(topicId);
                for (const item of (items || [])) {
                    if (!seenIds.has(item.id)) {
                        seenIds.add(item.id);
                        const labeled = { ...item, _source: 'topic' };
                        all.push(labeled);
                        topicItems.push(labeled);
                    }
                }
            } catch (error) {
                console.warn(`[LearningContextService] Error fetching topic content items:`, error.message);
            }
        }

        return { all, taskItems, topicItems };
    }

    /**
     * Asegura que los content_items estén ingestados en rag_documents.
     * Procesa items con body suficiente que no estén ya ingestados.
     * Si el body es una URL, descarga el archivo y extrae su texto (PDF, etc).
     * @private
     */
    async _ensureRagIngestion(courseId, topicId, taskId, contentItems) {
        const result = { ingested: false, filesProcessed: 0, skipped: false, errors: [] };

        if (!this.ragService || !taskId || taskId <= 0) {
            console.warn('[LearningContextService] Skipping RAG ingestion: ragService missing or invalid taskId');
            return result;
        }

        try {
            // ⛔ NO hacer check a nivel task — si se ingirió un content_item pero
            // otro se agregó después, el check task-level bloquearía la ingesta
            // del nuevo archivo. Cada content_item se verifica individualmente
            // dentro de ragService.ingestDocument() via contentItemId.

            // Filter items with body present (URLs are usually short, so no length filter here)
            const ingestableItems = contentItems.filter(item => {
                const body = (item.body || '').trim();
                return body.length > 10;
            });

            if (ingestableItems.length === 0) {
                console.warn(`[LearningContextService] No ingestable content_items for task=${taskId}`);
                return result;
            }

            // Lazily create R2 adapter only when needed for URL downloads
            let r2Service = null;

            for (const item of ingestableItems) {
                const body = (item.body || '').trim();
                const fileName = item.title || `content_item_${item.id}`;
                const isUrl = body.startsWith('http://') || body.startsWith('https://');
                const effectiveTopicId = topicId || item.topic_id;
                let textToIngest = null;

                if (isUrl) {
                    // Download file content from URL (same logic as RAGController.ingestTaskContent)
                    try {
                        if (!r2Service) r2Service = new R2StorageAdapter();
                        const fileData = await r2Service.getSubmissionFileContent(body, fileName);
                        if (!fileData || !fileData.content) {
                            result.errors.push({ file: fileName, error: 'No content from download' });
                            continue;
                        }

                        const nameLower = fileName.toLowerCase();
                        const isPdf = nameLower.endsWith('.pdf') || (fileData.contentType || '').includes('pdf');

                        if (isPdf && pdfParse) {
                            try {
                                const pdfBuffer = Buffer.from(fileData.content, fileData.isBase64 ? 'base64' : 'utf-8');
                                const pdfData = await pdfParse(pdfBuffer);
                                textToIngest = pdfData.text;
                                if (!textToIngest || textToIngest.trim().length < 50) textToIngest = null;
                            } catch (pdfErr) {
                                result.errors.push({ file: fileName, error: `PDF parse: ${pdfErr.message}` });
                            }
                        } else if (!fileData.isBase64) {
                            textToIngest = fileData.content;
                        }
                    } catch (dlErr) {
                        result.errors.push({ file: fileName, error: `Download: ${dlErr.message}` });
                    }
                } else {
                    // Body is plain text content
                    textToIngest = body;
                }

                if (textToIngest && textToIngest.length >= 50) {
                    try {
                        await this.ragService.ingestDocument(textToIngest, {
                            courseId,
                            taskId,
                            topicId: effectiveTopicId,
                            contentItemId: item.id,
                            fileName,
                            fileType: 'txt',
                        });
                        result.filesProcessed++;
                    } catch (ingestErr) {
                        result.errors.push({ file: fileName, error: ingestErr.message });
                    }
                }
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

    // ═══════════════════════════════════════════════════════════
    // HYBRID RETRIEVAL HELPERS
    // ═══════════════════════════════════════════════════════════

    /**
     * Determines the effective retrieval mode based on input.
     * @private
     * @param {string} requestedMode - 'auto', 'hybrid', 'semantic', 'progressive'
     * @param {string|null} query - The search query (if any)
     * @returns {string} - Resolved mode
     */
    _resolveRetrievalMode(requestedMode, query) {
        if (requestedMode === 'hybrid' || requestedMode === 'semantic' || requestedMode === 'progressive') {
            return requestedMode;
        }
        // 'auto' mode: always prefer hybrid — _buildSearchQuery will build from topic/task details
        // even if the client didn't provide a query
        return 'hybrid';
    }

    /**
     * Builds a composite search query from topic AND task details.
     * Blends both sources to ensure hybrid retrieval covers material
     * related to the topic's conceptual scope AND the task's requirements.
     * @private
     */
    _buildSearchQuery(topicDetails, taskDetails) {
        const parts = [];

        // Topic context — conceptual scope
        if (topicDetails?.name) parts.push(topicDetails.name);
        if (topicDetails?.description) {
            // Use first 200 chars of description for query efficiency
            parts.push(topicDetails.description.substring(0, 200));
        }

        // Task context — specific requirements
        if (taskDetails?.title) parts.push(taskDetails.title);
        if (taskDetails?.description) {
            parts.push(taskDetails.description.substring(0, 200));
        }

        // Duplicate the titles for higher weight in semantic search
        if (topicDetails?.name && taskDetails?.title) {
            parts.push(`${topicDetails.name} ${taskDetails.title}`);
        }

        return parts.join(' ').trim() || '';
    }

    /**
     * Obtiene contenido RAG usando Hybrid Retrieval Architecture.
     * Combina búsqueda semántica + window expansion + reranking + progressive coverage.
     *
     * @param {number} courseId
     * @param {number|null} topicId
     * @param {number|null} taskId
     * @param {string} query - Search query for semantic component
     * @param {number|null} sessionIndex - If set, also applies progressive coverage
     * @param {object|null} topicDetails - Topic details for reranking context
     * @param {object|null} taskDetails - Task details for reranking context
     * @returns {Promise<{ content: string, chunks: number, files: string[], semanticHits: number, expandedChunks: number, reranked: boolean, rerankMethod: string, page: number, totalPages: number, totalChunks: number }>}
     * @private
     */
    async _getHybridRagContent(courseId, topicId, taskId, query, sessionIndex = null, topicDetails = null, taskDetails = null) {
        if (!this.ragService) {
            return { content: '', chunks: 0, files: [], semanticHits: 0, expandedChunks: 0, reranked: false, rerankMethod: 'none', page: 0, totalPages: 0, totalChunks: 0 };
        }

        try {
            const filter = { courseId };
            if (topicId && topicId > 0) filter.topicId = topicId;
            if (taskId && taskId > 0) filter.taskId = taskId;

            // Use hybrid retrieval if the method exists, otherwise fall back to progressive
            if (typeof this.ragService.getHybridRagContent === 'function') {
                return await this.ragService.getHybridRagContent(query, filter, {
                    semanticTopK: 5,
                    windowSize: 2,
                    semanticThreshold: 0.45,
                    sessionIndex,  // Only used as progressive fallback when semantic=0
                    maxChunks: 12,
                    rerank: true,  // Enable reranking for better relevance
                    topicName: topicDetails?.name || null,
                    taskTitle: taskDetails?.title || null,
                });
            }

            // Fallback: progressive retrieval
            console.warn('[LearningContextService] getHybridRagContent not available, falling back to progressive');
            const result = await this.ragService.getProgressiveRagContent(filter, sessionIndex || 0);
            return { ...result, semanticHits: 0, expandedChunks: 0, reranked: false, rerankMethod: 'none' };
        } catch (error) {
            console.warn('[LearningContextService] getHybridRagContent error (non-blocking):', error.message);
            return { content: '', chunks: 0, files: [], semanticHits: 0, expandedChunks: 0, reranked: false, rerankMethod: 'none', page: 0, totalPages: 0, totalChunks: 0 };
        }
    }
}

export default LearningContextService;
