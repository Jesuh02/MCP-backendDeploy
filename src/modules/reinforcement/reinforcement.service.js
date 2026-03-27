/**
 * ReinforcementDomainService — Manages reinforcement question sessions/history.
 * 
 * Uses MCPService for full persistence with:
 *   - SHA-256 hash deduplication
 *   - Embedding generation for semantic uniqueness
 *   - question_sessions + questions_history + question_options tables
 */
import { Result } from '../../shared/Result.js';
import { MCPService } from '../ai/mcp-legacy.service.js';
import { RAGService } from '../ai/rag-legacy.service.js';
import { SupabaseService } from '../../shared/database/SupabaseService.js';
import { R2StorageAdapter } from '../storage/infrastructure/r2.storage.adapter.js';
import { QuestionCacheService } from './question-cache.service.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch (_) { pdfParse = null; }

// ─── Semaphore: máximo de llamadas LLM simultáneas en todo el proceso ───────
const MAX_CONCURRENT_LLM = 3;
let _activeLlmCalls = 0;
const _llmQueue = [];

async function withLlmSlot(fn) {
    if (_activeLlmCalls < MAX_CONCURRENT_LLM) {
        _activeLlmCalls++;
        try { return await fn(); } finally { _activeLlmCalls--; _drainLlmQueue(); }
    }
    // Encolar y esperar slot libre
    return new Promise((resolve, reject) => {
        _llmQueue.push(async () => {
            _activeLlmCalls++;
            try { resolve(await fn()); } catch (e) { reject(e); } finally { _activeLlmCalls--; _drainLlmQueue(); }
        });
    });
}
function _drainLlmQueue() {
    if (_llmQueue.length > 0 && _activeLlmCalls < MAX_CONCURRENT_LLM) {
        const next = _llmQueue.shift();
        next();
    }
}

export class ReinforcementDomainService {
    constructor({ reinforcementRepository, llmPort = null, learningContextService = null }) {
        this.reinforcementRepo = reinforcementRepository;
        this.llmPort = llmPort;
        this.learningContextService = learningContextService;
        this.REQUIRED_QUESTION_COUNT = 10;
        this.questionCache = QuestionCacheService.getInstance();
        // In-flight promises: evita llamadas LLM duplicadas para la misma clave
        this._inFlight = new Map();
    }

    /** Setter for late injection (avoids circular constructor deps) */
    setLearningContextService(svc) {
        this.learningContextService = svc;
    }

    logQuestionBatch(label, questions, context = {}) {
        if (!Array.isArray(questions)) {
            console.log(`[ReinforcementDomainService] ${label}: questions payload is not an array`);
            return;
        }

        const contextSummary = Object.entries(context)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}=${value ?? 'null'}`)
            .join(', ');

        console.log(
            `🧠 [ReinforcementDomainService] ${label}: totalQuestions=${questions.length}` +
            `${contextSummary ? `, ${contextSummary}` : ''}`
        );

        questions.forEach((item, questionIndex) => {
            const questionText = String(item?.question || '').trim() || '(sin texto de pregunta)';
            const options = Array.isArray(item?.options) ? item.options : [];
            const correctIndex = Number.isInteger(item?.correctIndex) ? item.correctIndex : null;

            console.log(`   Q${questionIndex + 1}: ${questionText}`);

            if (options.length === 0) {
                console.log('      opciones: (sin opciones)');
                return;
            }

            options.forEach((option, optionIndex) => {
                const marker = correctIndex === optionIndex ? '[correcta]' : '[opcion]';
                console.log(`      ${marker} (${optionIndex}) ${String(option || '').trim()}`);
            });
        });
    }

    /**
     * Ensure content for a task/topic is ingested into RAG (rag_documents).
     * If missing, fetches from content_items and ingests.
     */
    async ensureContentIngested(courseId, taskId, topicId = null) {
        try {
            const ragService = new RAGService();
            const supabase = SupabaseService.getInstance();
            
            // ⛔ NO hacer check a nivel task — si un content_item fue ingresado
            // pero se agregó otro archivo después, el check task-level bloquearía
            // la ingesta del nuevo archivo. ingestDocument() verifica por contentItemId.

            console.log(`📝 [ReinforcementService] Checking RAG ingestion for Task ${taskId}. Fetching content_items...`);

            // 2. Fetch source content from content_items
            // Also fetch items linked to the topic (not just task) so ALL relevant files are ingested
            let queryBuilder = supabase.client
                .from('content_items')
                .select('*');
            
            if (taskId && topicId) {
                // Fetch items for BOTH task AND topic
                queryBuilder = queryBuilder.or(`task_id.eq.${taskId},topic_id.eq.${topicId}`);
            } else if (taskId) {
                queryBuilder = queryBuilder.eq('task_id', taskId);
            } else if (topicId) {
                queryBuilder = queryBuilder.eq('topic_id', topicId);
            }

            const { data: items, error } = await queryBuilder;

            if (error) throw error;

            if (!items || items.length === 0) {
                return Result.ok({ message: 'No content_items found for this task/topic', ingested: false });
            }

            let ingestedCount = 0;
            let r2Service = null;

            // 3. Ingest each item (handles both plain text and URL-based content)
            for (const item of items) {
                const body = (item.body || '').trim();
                const fileName = item.title || `content_${item.id}`;
                const isUrl = body.startsWith('http://') || body.startsWith('https://');
                const effectiveTopicId = topicId || item.topic_id;
                let textToIngest = null;

                if (!body || body.length < 10) continue;

                if (isUrl) {
                    // Download file content from URL
                    try {
                        if (!r2Service) r2Service = new R2StorageAdapter();
                        const fileData = await r2Service.getSubmissionFileContent(body, fileName);
                        if (!fileData || !fileData.content) {
                            console.warn(`[ReinforcementService] No content from download: ${fileName}`);
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
                                console.warn(`[ReinforcementService] PDF parse error for ${fileName}: ${pdfErr.message}`);
                            }
                        } else if (!fileData.isBase64) {
                            textToIngest = fileData.content;
                        }
                    } catch (dlErr) {
                        console.warn(`[ReinforcementService] Download error for ${fileName}: ${dlErr.message}`);
                    }
                } else {
                    // Body is plain text content
                    textToIngest = body;
                }

                if (textToIngest && textToIngest.length >= 50) {
                    console.log(`💾 Ingesting content_item ${item.id} (${fileName}) into RAG...`);

                    await ragService.ingestDocument(textToIngest, {
                        courseId: courseId,
                        taskId: taskId,
                        topicId: effectiveTopicId,
                        contentItemId: item.id,
                        fileName,
                        fileType: 'txt'
                    });
                    ingestedCount++;
                }
            }

            return Result.ok({ 
                success: true, 
                message: `Ingested ${ingestedCount} content items into RAG`, 
                ingested: true,
                count: ingestedCount 
            });

        } catch (error) {
            console.error('[ReinforcementService] Ingestion error:', error);
            // Non-blocking failure, return fail result but don't crash
            return Result.fail(error);
        }
    }

    /**
     * Save a full question session with uniqueness validation.
     * Delegates to MCPService.saveReinforcementHistory() which handles:
     *   - Session creation in question_sessions
     *   - Hash + semantic dedup in questions_history  
     *   - Option embedding storage in question_options
     */
    async saveSession(data) {
        const { userId, courseId, topicId, taskId, questions } = data;

        // Parse questions if they come as a string
        let parsedQuestions = questions;
        if (typeof questions === 'string') {
            try {
                parsedQuestions = JSON.parse(questions);
            } catch (e) {
                console.warn('[ReinforcementDomainService] Failed to parse questions string:', e.message);
                parsedQuestions = [];
            }
        }

        this.logQuestionBatch('respuestas mostradas en ReinforcementLearningScreen.kt', parsedQuestions, {
            userId,
            courseId,
            topicId,
            taskId,
        });

        // If we have questions, use MCPService for full embedding + uniqueness flow
        if (Array.isArray(parsedQuestions) && parsedQuestions.length > 0) {
            try {
                const mcpService = new MCPService();
                const saveResult = await mcpService.saveReinforcementHistory(
                    userId,
                    courseId,
                    parsedQuestions,
                    topicId || null,
                    taskId || null
                );

                const savedCount = saveResult?.savedCount || 0;
                const cumulativeCount = saveResult?.cumulativeCount || savedCount;
                const requiredCount = saveResult?.requiredCount || this.REQUIRED_QUESTION_COUNT;
                const isComplete = cumulativeCount >= requiredCount;

                let accumulatedQuestions = [];
                try {
                    const allHistory = await mcpService.getReinforcementHistory(userId, courseId, topicId, taskId);
                    accumulatedQuestions = (allHistory || []).map(h => ({
                        question: h.question || '',
                        options: h.options || [],
                        correctIndex: h.answer_index ?? 0,
                        explanation: h.explanation || '',
                    }));
                } catch (_) { /* non-blocking */ }

                if (saveResult && isComplete) {
                    const finalQuestions = accumulatedQuestions.slice(0, requiredCount);
                    console.log(`✅ [ReinforcementDomainService] ACUMULACIÓN COMPLETA: ${cumulativeCount}/${requiredCount} preguntas únicas. savedThisBatch=${savedCount}, duplicates=${parsedQuestions.length - savedCount}`);
                    this.logQuestionBatch(
                        `LOTE COMPLETO — ${finalQuestions.length} preguntas únicas acumuladas`,
                        finalQuestions,
                        { userId, courseId, topicId, taskId }
                    );
                    return Result.ok({
                        success: true,
                        savedCount,
                        cumulativeCount,
                        duplicateCount: (parsedQuestions.length - savedCount),
                        totalSubmitted: parsedQuestions.length,
                        requiredCount,
                        accumulatedQuestions: finalQuestions,
                        message: `Lote completo: ${cumulativeCount} preguntas únicas acumuladas`
                    });
                } else {
                    const shortfall = Math.max(requiredCount - cumulativeCount, 0);
                    console.log(`🔄 [ReinforcementDomainService] ACUMULACIÓN PARCIAL: ${savedCount} nuevas guardadas, ${cumulativeCount}/${requiredCount} acumuladas. Faltan ${shortfall}. duplicates=${parsedQuestions.length - savedCount}`);
                    return Result.ok({
                        success: false,
                        savedCount,
                        cumulativeCount,
                        duplicateCount: (parsedQuestions.length - savedCount),
                        totalSubmitted: parsedQuestions.length,
                        requiredCount,
                        shortfall: Math.max(requiredCount - cumulativeCount, 0),
                        allDuplicates: savedCount === 0,
                        needsRegeneration: true,
                        existingQuestions: accumulatedQuestions,
                        message: `Guardadas ${savedCount} este ciclo, ${cumulativeCount}/${requiredCount} acumuladas. Faltan ${Math.max(requiredCount - cumulativeCount, 0)}.`
                    });
                }
            } catch (e) {
                console.error('[ReinforcementDomainService] MCPService save error:', e.message);
                // Fallback: create session only
                const session = await this.reinforcementRepo.saveSession({ userId, courseId, topicId, taskId });
                return Result.ok({ ...session, savedCount: 0, message: 'Session created, questions save failed' });
            }
        }

        // No questions provided — just create session
        const session = await this.reinforcementRepo.saveSession({ userId, courseId, topicId, taskId });
        return Result.ok(session);
    }

    /**
     * Get existing questions for a user+course filtered by topic/task.
     * Returns full question objects (text, options, correctIndex, explanation)
     * so the client can use them for deduplication before generating new ones.
     */
    async getExistingQuestions(userId, courseId, topicId = null, taskId = null) {
        try {
            const mcpService = new MCPService();
            const history = await mcpService.getReinforcementHistory(userId, courseId, topicId, taskId);

            if (!Array.isArray(history) || history.length === 0) {
                console.log(
                    `🧠 [ReinforcementDomainService] getExistingQuestions: totalQuestions=0, userId=${userId}, courseId=${courseId}, topicId=${topicId ?? 'null'}, taskId=${taskId ?? 'null'}`
                );
                return Result.ok({ questions: [], count: 0 });
            }

            // Return structured question objects for client-side dedup
            const questions = history.map(h => ({
                question: h.question || '',
                options: h.options || [],
                correctIndex: h.answer_index ?? 0,
                explanation: h.explanation || '',
            }));

            this.logQuestionBatch('getExistingQuestions returning questions', questions, {
                userId,
                courseId,
                topicId,
                taskId,
            });

            return Result.ok({ questions, count: questions.length });
        } catch (error) {
            console.error('[ReinforcementDomainService] getExistingQuestions error:', error.message);
            return Result.ok({ questions: [], count: 0 });
        }
    }

    /**
     * Retrieve all raw text content from rag_documents for a task/topic/course.
     * Used by the client to build RAG-grounded prompts that prevent hallucination.
     * @param {number} courseId
     * @param {number|null} topicId
     * @param {number|null} taskId
     * @returns {Promise<Result>} { content: string, chunks: number, files: string[] }
     */
    async getRagContent(courseId, topicId = null, taskId = null) {
        try {
            const ragService = new RAGService();
            const filter = { courseId };
            if (topicId) filter.topicId = topicId;
            if (taskId) filter.taskId = taskId;

            const result = await ragService.getRagContent(filter);
            return Result.ok(result);
        } catch (error) {
            console.error('[ReinforcementDomainService] getRagContent error:', error.message);
            return Result.ok({ content: '', chunks: 0, files: [] });
        }
    }

    /**
     * Get cached questions if available (instant response).
     */
    async getCachedQuestions(userId, courseId, topicId, taskId, difficulty) {
        const cached = this.questionCache.get(userId, courseId, topicId, taskId, difficulty);
        if (cached && cached.length > 0) {
            console.log(`⚡ [ReinforcementService] Cache HIT: ${cached.length} questions for user=${userId}, course=${courseId}, topic=${topicId}, task=${taskId}, diff=${difficulty}`);
            return Result.ok({
                questions: cached,
                count: cached.length,
                source: 'cache',
                generating: false,
            });
        }
        const isGenerating = this.questionCache.isGenerating(userId, courseId, topicId, taskId, difficulty);
        console.log(`💨 [ReinforcementService] Cache MISS for user=${userId}, course=${courseId}, topic=${topicId}, task=${taskId}. generating=${isGenerating}`);
        return Result.ok({
            questions: [],
            count: 0,
            source: 'none',
            generating: isGenerating,
        });
    }

    /**
     * Prefetch: start generating questions in background and cache them.
     * Returns immediately (fire-and-forget). The client polls /cached-questions.
     */
    async prefetchQuestions(userId, courseId, topicId, taskId, difficulty) {
        if (!this.llmPort || !this.learningContextService) {
            console.warn('[ReinforcementService] prefetch skipped: llmPort or learningContextService not available');
            return Result.ok({ status: 'skipped', reason: 'dependencies_unavailable' });
        }

        // Already cached or generating?
        const existing = this.questionCache.get(userId, courseId, topicId, taskId, difficulty);
        if (existing && existing.length > 0) {
            return Result.ok({ status: 'already_cached', count: existing.length });
        }
        if (this.questionCache.isGenerating(userId, courseId, topicId, taskId, difficulty)) {
            return Result.ok({ status: 'already_generating' });
        }

        // Fire-and-forget background generation
        this._generateAndCache(userId, courseId, topicId, taskId, difficulty).catch(err => {
            console.error('[ReinforcementService] Background prefetch error:', err.message);
        });

        return Result.ok({ status: 'started' });
    }

    /**
     * Generate questions server-side in a single call:
     * 1. Fetch learning context
     * 2. Build prompt & call LLM
     * 3. Return questions immediately
     * 4. Save with embeddings in background (non-blocking)
     */
    async generateQuestions(userId, courseId, topicId, taskId, difficulty, targetCount = 10) {
        // 1. Check cache first
        const cached = this.questionCache.get(userId, courseId, topicId, taskId, difficulty);
        if (cached && cached.length > 0) {
            console.log(`⚡ [ReinforcementService] generateQuestions: serving ${cached.length} from cache`);
            this.questionCache.delete(userId, courseId, topicId, taskId, difficulty);
            this._backgroundSave(userId, courseId, topicId, taskId, cached).catch(() => {});
            return Result.ok({ questions: cached, count: cached.length, source: 'cache' });
        }

        if (!this.llmPort || !this.learningContextService) {
            return Result.fail('LLM or LearningContextService not available for server-side generation');
        }

        // 2. Dedup: si ya hay un LLM call en vuelo para esta misma clave, reutilizar
        const flightKey = `${userId}:${courseId}:${topicId || 0}:${taskId || 0}:${(difficulty || 'HARD').toUpperCase()}`;
        if (this._inFlight.has(flightKey)) {
            console.log(`🔄 [ReinforcementService] Reusing in-flight LLM call for key=${flightKey}`);
            try {
                const questions = await this._inFlight.get(flightKey);
                return Result.ok({ questions, count: questions.length, source: 'llm_shared' });
            } catch (error) {
                return Result.fail(error.message || 'Question generation failed');
            }
        }

        // 3. Nueva llamada: registrar en _inFlight y limitar con semáforo global
        const generationPromise = withLlmSlot(() =>
            this._generateQuestionsInternal(userId, courseId, topicId, taskId, difficulty, targetCount)
        );
        this._inFlight.set(flightKey, generationPromise);

        try {
            const questions = await generationPromise;
            if (!questions || questions.length === 0) {
                return Result.ok({ questions: [], count: 0, source: 'llm', message: 'LLM returned no valid questions' });
            }
            this._backgroundSave(userId, courseId, topicId, taskId, questions).catch(() => {});
            return Result.ok({ questions, count: questions.length, source: 'llm' });
        } catch (error) {
            console.error('[ReinforcementService] generateQuestions error:', error.message);
            return Result.fail(error.message || 'Question generation failed');
        } finally {
            this._inFlight.delete(flightKey);
        }
    }

    /**
     * @private Generate questions and store in cache.
     */
    async _generateAndCache(userId, courseId, topicId, taskId, difficulty) {
        this.questionCache.markGenerating(userId, courseId, topicId, taskId, difficulty);
        try {
            const questions = await withLlmSlot(() =>
                this._generateQuestionsInternal(userId, courseId, topicId, taskId, difficulty, this.REQUIRED_QUESTION_COUNT)
            );
            if (questions && questions.length > 0) {
                this.questionCache.set(userId, courseId, topicId, taskId, difficulty, questions);
                console.log(`✅ [ReinforcementService] Prefetch complete: ${questions.length} questions cached`);
            }
        } finally {
            this.questionCache.clearGenerating(userId, courseId, topicId, taskId, difficulty);
        }
    }

    /**
     * @private Core question generation logic (context + LLM call).
     */
    async _generateQuestionsInternal(userId, courseId, topicId, taskId, difficulty, targetCount) {
        const startMs = Date.now();

        // Step 1: Get learning context (parallel DB queries + RAG)
        const contextResult = await this.learningContextService.buildLearningContext({
            courseId, topicId, taskId, userId,
            query: null,
            retrievalMode: 'hybrid',
        });

        if (contextResult.isFail()) {
            throw new Error('Failed to build learning context: ' + contextResult.getError());
        }

        const ctx = contextResult.getValue();
        const topicName = ctx.topic?.name || '';
        const taskName = ctx.task?.title || '';
        const ragContent = ctx.ragContent || '';
        const existingQuestions = (ctx.existingQuestions || []).map(q => q.question || '');

        console.log(`📚 [ReinforcementService] Context built in ${Date.now() - startMs}ms: topic='${topicName}', task='${taskName}', ragChunks=${ctx.ragChunks || 0}, existingQ=${existingQuestions.length}`);

        // Step 2: Build prompt
        const contextBlock = this._buildContextBlock(topicName, ctx.topic?.description, taskName, ctx.task?.description, ragContent, ctx.ragFiles || []);
        const existingBlock = existingQuestions.length > 0
            ? `\nPREGUNTAS YA EXISTENTES (NO REPETIR):\n${existingQuestions.slice(-50).map((q, i) => `${i + 1}. ${q}`).join('\n')}\n`
            : '';

        const diffLabel = (difficulty || 'HARD').toUpperCase();
        const systemPrompt = this._buildSystemPrompt(diffLabel, targetCount);
        const userPrompt = `${contextBlock}\n${existingBlock}\n\nGenera EXACTAMENTE ${targetCount} ejercicios de evaluación en formato JSON array. MEZCLA tipos (multiple_choice, fill_in_blank, ordering) según el tema. Tu ÚNICA salida debe ser el JSON array.`;

        // Step 3: Call LLM
        const llmStartMs = Date.now();
        const llmResponse = await this.llmPort.chat(systemPrompt, userPrompt, {
            temperature: 0.4,
            maxTokens: 8000,
        });
        console.log(`🤖 [ReinforcementService] LLM responded in ${Date.now() - llmStartMs}ms`);

        // Step 4: Parse JSON
        const content = llmResponse?.content || '';
        const questions = this._parseQuestionsJson(content);

        if (questions.length > 0) {
            // Local dedup against existing
            const deduped = this._localDedup(questions, existingQuestions);
            console.log(`✅ [ReinforcementService] Generated ${questions.length} questions, ${deduped.length} after local dedup (total ${Date.now() - startMs}ms)`);
            return deduped.slice(0, targetCount);
        }

        return questions;
    }

    /** @private Build the context text block for the prompt */
    _buildContextBlock(topicName, topicDesc, taskName, taskDesc, ragContent, ragFiles) {
        let block = '';
        if (topicName) {
            block += `TEMA: ${topicName}\n`;
            if (topicDesc) block += `Descripción: ${topicDesc}\n`;
        }
        if (taskName) {
            block += `TAREA: ${taskName}\n`;
            if (taskDesc) block += `Descripción: ${taskDesc}\n`;
        }
        if (ragContent) {
            block += `\n═══ MATERIAL DE REFERENCIA VERIFICADO ═══\n${ragContent}\n═══════════════════════════════════════\n`;
            if (ragFiles.length > 0) block += `Archivos fuente: ${ragFiles.join(', ')}\n`;
        }
        return block;
    }

    /** @private Build system prompt based on difficulty */
    _buildSystemPrompt(difficulty, targetCount) {
        const groundingRule = `REGLA: Basa los ejercicios EXCLUSIVAMENTE en el material proporcionado. NO inventes información.`;

        const difficultyInstructions = {
            EASY: `NIVEL INTRODUCTORIO: ejercicios de comprensión y práctica básica. Operaciones simples, conceptos fundamentales. Usa "¿Por qué?", "¿Para qué?", "¿Qué pasaría si...?" para preguntas; ejercicios directos y sencillos para práctica.`,
            INTERMEDIATE: `NIVEL INTERMEDIO: ejercicios de análisis y aplicación. Escenarios prácticos, resolución de problemas contextualizados. El estudiante debe ANALIZAR, DECIDIR y APLICAR conocimientos.`,
            HARD: `NIVEL MÁXIMO: ejercicios de evaluación y síntesis. Escenarios complejos, problemas multi-paso. Taxonomía de Bloom: Aplicar, Analizar, Evaluar, Crear. Opciones sutilmente plausibles en preguntas; ejercicios que requieren razonamiento profundo.`,
            FREE: `Genera ejercicios variados que cubran TODO el contenido. Mezcla niveles: comprensión, análisis, aplicación y creación.`,
        };

        const exerciseTypeInstructions = `
TIPOS DE EJERCICIOS DISPONIBLES (usa "type" para identificar cada uno):

1. "multiple_choice" — Pregunta de opción múltiple clásica.
   Campos: { type: "multiple_choice", question, options (array de 4), correctIndex (0-3), explanation }

2. "fill_in_blank" — Ejercicio práctico donde el estudiante debe escribir la respuesta.
   Ideal para: operaciones matemáticas, completar código, completar frases, traducciones.
   Campos: { type: "fill_in_blank", question (usa "___" para marcar el espacio), correctAnswer (string), hint (pista opcional), explanation }
   Ejemplos:
   - Matemáticas: { type: "fill_in_blank", question: "Resuelve: 15 × 3 = ___", correctAnswer: "45", hint: "Multiplica paso a paso", explanation: "15 × 3 = 45" }
   - Programación: { type: "fill_in_blank", question: "Completa: console.___(\"Hola\")", correctAnswer: "log", hint: "Método para imprimir en consola", explanation: "console.log() imprime mensajes en la consola" }
   - Inglés: { type: "fill_in_blank", question: "Complete: She ___ (go) to school yesterday.", correctAnswer: "went", hint: "Past simple del verbo go", explanation: "El pasado simple de 'go' es 'went'" }

3. "ordering" — Ordenar elementos en la secuencia correcta.
   Ideal para: pasos de un algoritmo, líneas de código, procesos, cronología.
   Campos: { type: "ordering", question, items (array desordenado), correctOrder (array de índices del orden correcto), explanation }
   Ejemplo: { type: "ordering", question: "Ordena los pasos para compilar un programa en C", items: ["Ejecutar", "Escribir código", "Compilar", "Depurar"], correctOrder: [1, 2, 3, 0], explanation: "Primero se escribe, luego compila, depura y finalmente ejecuta" }

DECISIÓN INTELIGENTE DE TIPOS:
- Analiza el TEMA y TAREA del estudiante para decidir qué tipos de ejercicios son más apropiados.
- Si el tema es MATEMÁTICAS, FÍSICA, QUÍMICA: prioriza "fill_in_blank" para cálculos y "multiple_choice" para conceptos.
- Si el tema es PROGRAMACIÓN: usa "fill_in_blank" para completar código, "ordering" para ordenar líneas, "multiple_choice" para conceptos.
- Si el tema es IDIOMAS (inglés, etc.): usa "fill_in_blank" para gramática/vocabulario, "multiple_choice" para comprensión.
- Si el tema es HISTORIA, CIENCIAS SOCIALES: prioriza "multiple_choice" y "ordering" para cronología.
- Si el tema es PROCESOS, METODOLOGÍAS: prioriza "ordering" para secuencias.
- MEZCLA los tipos: de ${targetCount} ejercicios, incluye al menos 2-3 tipos diferentes.
- Los ejercicios fill_in_blank deben tener UNA sola respuesta correcta clara y verificable.
- Para ordering, provee entre 3 y 6 items.
`;

        return `Eres un profesor experto diseñando ${targetCount} ejercicios de evaluación inteligente.
${difficultyInstructions[difficulty] || difficultyInstructions.HARD}
${groundingRule}
${exerciseTypeInstructions}
PROHIBIDO ejercicios de memorización pura. El estudiante debe PENSAR y APLICAR conocimientos.
La explicación debe ser clara y educativa.
FORMATO: JSON array con los campos según el type de cada ejercicio.`;
    }

    /** @private Validate and normalize a single parsed question/exercise object */
    _normalizeQuestion(q) {
        if (!q || typeof q.question !== 'string' || q.question.trim().length < 5) return null;
        const type = String(q.type || 'multiple_choice').trim().toLowerCase();

        switch (type) {
            case 'fill_in_blank': {
                const correctAnswer = String(q.correctAnswer ?? q.correct_answer ?? '').trim();
                if (!correctAnswer) return null;
                return {
                    type: 'fill_in_blank',
                    question: q.question.trim(),
                    correctAnswer,
                    hint: String(q.hint ?? '').trim() || null,
                    explanation: String(q.explanation ?? '').trim() || `La respuesta correcta es: "${correctAnswer}"`,
                };
            }
            case 'ordering': {
                const items = Array.isArray(q.items) ? q.items.map(i => String(i ?? '').trim()) : [];
                const correctOrder = Array.isArray(q.correctOrder ?? q.correct_order)
                    ? (q.correctOrder ?? q.correct_order).map(Number)
                    : [];
                if (items.length < 3 || correctOrder.length !== items.length) return null;
                if (!correctOrder.every(i => Number.isInteger(i) && i >= 0 && i < items.length)) return null;
                return {
                    type: 'ordering',
                    question: q.question.trim(),
                    items,
                    correctOrder,
                    explanation: String(q.explanation ?? '').trim() || 'Revisa el orden correcto en la explicación.',
                };
            }
            default: {
                // multiple_choice (backward compatible)
                if (!Array.isArray(q.options) || q.options.length < 2) return null;
                const correctIndex = Number(q.correctIndex ?? q.correct_index ?? 0);
                if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= q.options.length) return null;
                return {
                    type: 'multiple_choice',
                    question: q.question.trim(),
                    options: q.options.map(o => String(o ?? '').trim()),
                    correctIndex,
                    explanation: String(q.explanation ?? '').trim() || `La respuesta correcta es: "${q.options[correctIndex]}"`,
                };
            }
        }
    }

    /** @private Extract complete JSON objects from a potentially truncated array string */
    _extractObjectsFromBrokenArray(jsonStr) {
        const results = [];
        let depth = 0;
        let inString = false;
        let escape = false;
        let objStart = -1;

        for (let i = 0; i < jsonStr.length; i++) {
            const ch = jsonStr[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;

            if (ch === '{') {
                if (depth === 0) objStart = i;
                depth++;
            } else if (ch === '}') {
                depth--;
                if (depth === 0 && objStart !== -1) {
                    try {
                        const obj = JSON.parse(jsonStr.substring(objStart, i + 1));
                        results.push(obj);
                    } catch (_) { /* skip malformed object */ }
                    objStart = -1;
                }
            }
        }
        return results;
    }

    /** @private Parse questions from LLM JSON output with fallback repair */
    _parseQuestionsJson(content) {
        const start = content.indexOf('[');
        const end = content.lastIndexOf(']');

        // Strategy 1: clean JSON array
        if (start !== -1 && end !== -1 && start < end) {
            try {
                const parsed = JSON.parse(content.substring(start, end + 1));
                if (Array.isArray(parsed)) {
                    const normalized = parsed.map(q => this._normalizeQuestion(q)).filter(Boolean);
                    if (normalized.length > 0) return normalized;
                }
            } catch (_) { /* fall through to repair */ }
        }

        // Strategy 2: extract individual objects (handles truncated/malformed arrays)
        console.warn('[ReinforcementService] JSON parse failed, attempting object extraction repair...');
        const searchIn = start !== -1 ? content.substring(start) : content;
        const objects = this._extractObjectsFromBrokenArray(searchIn);
        if (objects.length > 0) {
            const normalized = objects.map(q => this._normalizeQuestion(q)).filter(Boolean);
            if (normalized.length > 0) {
                console.log(`[ReinforcementService] Repair recovered ${normalized.length} questions from broken JSON`);
                return normalized;
            }
        }

        console.warn('[ReinforcementService] JSON repair failed, no valid questions extracted');
        return [];
    }

    /** @private Fast local dedup using normalized text comparison */
    _localDedup(newQuestions, existingTexts) {
        const normalize = (text) => text.toLowerCase().replace(/[^a-záéíóúñü0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        const existingNorm = new Set(existingTexts.map(normalize));

        return newQuestions.filter(q => {
            const norm = normalize(q.question);
            if (existingNorm.has(norm)) return false;
            // Jaccard similarity check
            const words = new Set(norm.split(' '));
            for (const existing of existingNorm) {
                const existingWords = new Set(existing.split(' '));
                const intersection = [...words].filter(w => existingWords.has(w)).length;
                const union = new Set([...words, ...existingWords]).size;
                if (union > 0 && intersection / union > 0.8) return false;
            }
            existingNorm.add(norm); // Avoid in-batch duplicates
            return true;
        });
    }

    /** @private Save questions with embeddings in background (non-blocking) */
    async _backgroundSave(userId, courseId, topicId, taskId, questions) {
        try {
            const mcpService = new MCPService();
            await mcpService.saveReinforcementHistory(
                userId, courseId, questions,
                topicId || null, taskId || null
            );
            console.log(`💾 [ReinforcementService] Background save complete: ${questions.length} questions`);
        } catch (e) {
            console.error('[ReinforcementService] Background save error:', e.message);
            // Non-blocking, just log
        }
    }

    async getHistory(userId, courseId, pagination = {}) {
        const sessions = await this.reinforcementRepo.findByUserAndCourse(userId, courseId, pagination);
        return Result.ok(sessions);
    }

    async getUserSessions(userId, pagination = {}) {
        const sessions = await this.reinforcementRepo.findByUser(userId, pagination);
        return Result.ok(sessions);
    }
}
export default ReinforcementDomainService;

