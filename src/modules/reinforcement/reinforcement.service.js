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
    async generateQuestions(userId, courseId, topicId, taskId, difficulty, targetCount = 10, forceFresh = false) {
        // 1. Check cache first unless the caller explicitly forces a new generation.
        if (forceFresh) {
            this.questionCache.delete(userId, courseId, topicId, taskId, difficulty);
        } else {
            const cached = this.questionCache.get(userId, courseId, topicId, taskId, difficulty);
            if (cached && cached.length > 0) {
                console.log(`⚡ [ReinforcementService] generateQuestions: serving ${cached.length} from cache`);
                this.questionCache.delete(userId, courseId, topicId, taskId, difficulty);
                this._backgroundSave(userId, courseId, topicId, taskId, cached).catch(() => {});
                return Result.ok({ questions: cached, count: cached.length, source: 'cache' });
            }
        }

        if (!this.llmPort || !this.learningContextService) {
            return Result.fail('LLM or LearningContextService not available for server-side generation');
        }

        // 2. Dedup: si ya hay un LLM call en vuelo para esta misma clave, reutilizar
        const flightKey = `${userId}:${courseId}:${topicId || 0}:${taskId || 0}:${(difficulty || 'HARD').toUpperCase()}`;
        if (!forceFresh && this._inFlight.has(flightKey)) {
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
            const MIN_QUESTIONS_FOR_UI = 8;
            if (questions.length < MIN_QUESTIONS_FOR_UI) {
                console.warn(`⚠️ [ReinforcementService] Only ${questions.length} questions generated (min for UI: ${MIN_QUESTIONS_FOR_UI}). Returning empty to trigger retry.`);
                return Result.ok({ questions: [], count: 0, source: 'llm', message: `Only ${questions.length} questions generated, minimum ${MIN_QUESTIONS_FOR_UI} required` });
            }
            console.log(`\n═══ preguntas enviadas al cliente (${questions.length}) ═══`);
            questions.forEach((q, i) => console.log(`  [${i + 1}] type=${q.type} | ${q.question?.substring(0, 100)}`));
            console.log(`═══════════════════════════════════════════════════\n`);
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
     * Iterates until accumulating exactly targetCount valid unique questions.
     */
    async _generateQuestionsInternal(userId, courseId, topicId, taskId, difficulty, targetCount) {
        const startMs = Date.now();
        const MAX_ITERATIONS = 15;
        const MIN_ACCEPTABLE = Math.max(targetCount - 2, 1); // Accept minimum targetCount-2 (e.g. 8 of 10)

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

        // Step 2: Build shared context
        const contextBlock = this._buildContextBlock(topicName, ctx.topic?.description, taskName, ctx.task?.description, ragContent, ctx.ragFiles || []);
        const diffLabel = (difficulty || 'HARD').toUpperCase();
        const systemPrompt = this._buildSystemPrompt(diffLabel, targetCount);
        const topicHint = topicName
            ? `El tema es "${topicName}"${taskName ? ` y la tarea es "${taskName}"` : ''}. Analiza el dominio (matemáticas, SQL, programación, idiomas, ciencias, etc.) y elige los tipos de ejercicio MÁS AVANZADOS posibles para ese dominio.`
            : '';

        // Complexity enforcement added to the user prompt for HARD difficulty
        const hardEnforcement = diffLabel === 'HARD'
            ? `\n\n⚠️ NIVEL HARD — COMPLEJIDAD MÁXIMA OBLIGATORIA:\n- Identifica el dominio central del material (ej: SQL, álgebra, algoritmos, física, idioma).\n- Cada ejercicio fill_in_blank debe presentar un problema real no trivial: ecuaciones, consultas con JOINs/CTEs, algoritmos recursivos, problemas multi-fórmula, gramática avanzada.\n- Si el material habla de sumas, el fill_in_blank HARD debe ser una ecuación o sistema de ecuaciones — NUNCA "X + Y = ___" con números simples.\n- Si el material habla de SQL, el fill_in_blank HARD debe requerir completar un JOIN múltiple, window function o CTE — NUNCA un SELECT simple.\n- Si un ejercicio se puede resolver en menos de 5 segundos de pensamiento, NO es suficientemente difícil para nivel HARD. RECHÁZALO y genera uno más complejo.\n- Los distractores en multiple_choice deben ser respuestas que un estudiante intermedio elegiría por error — errores conceptuales plausibles, no disparates obvios.`
            : '';

        // Accumulate unique questions across iterations
        const accumulated = [];
        const allExcludedTexts = [...existingQuestions];

        let consecutiveZero = 0; // Track consecutive iterations yielding 0 new questions

        for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
            const remaining = targetCount - accumulated.length;
            if (remaining <= 0) break;

            // Only stop early if we have enough AND 2+ consecutive iterations yielded nothing
            if (accumulated.length >= MIN_ACCEPTABLE && consecutiveZero >= 2) {
                console.log(`✅ [ReinforcementService] Stopping early: ${accumulated.length}/${targetCount} (>= min ${MIN_ACCEPTABLE}) after ${consecutiveZero} empty iterations`);
                break;
            }

            // Build exclusion block including previously accumulated questions
            const exclusionList = allExcludedTexts.slice(-50);
            const existingBlock = exclusionList.length > 0
                ? `\nPREGUNTAS YA EXISTENTES (NO REPETIR):\n${exclusionList.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n`
                : '';

            // Ask for a minimum of 5 questions per iteration to maximize dedup yield
            const requestCount = Math.min(Math.max(remaining + 2, 5), 10);

            const userPrompt = `${contextBlock}\n${existingBlock}\n\n${topicHint}${hardEnforcement}\n\nGenera EXACTAMENTE ${requestCount} ejercicios de evaluación en formato JSON array. OBLIGATORIO: MEZCLA los tipos (multiple_choice, fill_in_blank, ordering) — incluye EJERCICIOS PRÁCTICOS donde el estudiante RESUELVA problemas reales y complejos. Cada ejercicio debe exigir razonamiento genuino acorde al nivel ${diffLabel}. Tu ÚNICA salida debe ser el JSON array, sin texto adicional.`;

            // Step 3: Call LLM (temperature increases on retries to encourage variety)
            const llmStartMs = Date.now();
            const llmResponse = await this.llmPort.chat(systemPrompt, userPrompt, {
                temperature: Math.min(0.4 + (iteration * 0.1), 0.9),
                maxTokens: 8000,
            });
            console.log(`🤖 [ReinforcementService] LLM responded in ${Date.now() - llmStartMs}ms (iteration ${iteration + 1}/${MAX_ITERATIONS})`);

            // Step 4: Parse JSON
            const content = llmResponse?.content || '';
            const questions = this._parseQuestionsJson(content);

            if (questions.length === 0) {
                console.warn(`[ReinforcementService] Iteration ${iteration + 1}: LLM returned 0 parseable questions`);
                consecutiveZero++;
                continue;
            }

            // Local dedup against existing + accumulated
            const deduped = this._localDedup(questions, allExcludedTexts);
            const prevAccumulated = accumulated.length;

            for (const q of deduped) {
                if (accumulated.length >= targetCount) break;
                accumulated.push(q);
                allExcludedTexts.push(q.question);
            }

            const newlyAdded = accumulated.length - prevAccumulated;
            console.log(`🔄 [ReinforcementService] Iteration ${iteration + 1}: parsed=${questions.length}, afterDedup=${deduped.length}, newlyAdded=${newlyAdded}, accumulated=${accumulated.length}/${targetCount}`);

            if (newlyAdded === 0) {
                consecutiveZero++;
            } else {
                consecutiveZero = 0;
            }

            if (accumulated.length >= targetCount) break;
            console.log(`⚠️ [ReinforcementService] Only ${accumulated.length}/${targetCount} after iteration ${iteration + 1}, retrying... (min acceptable: ${MIN_ACCEPTABLE})`);
        }

        console.log(`✅ [ReinforcementService] Final: ${accumulated.length}/${targetCount} unique questions (min acceptable: ${MIN_ACCEPTABLE}, total ${Date.now() - startMs}ms)`);

        // Log questions that will be shown in the UI
        console.log(`\n═══ preguntas mostradas en la interfaz (${accumulated.length}) ═══`);
        this.logQuestionBatch('preguntas mostradas en la interfaz', accumulated, {
            userId, courseId, topicId, taskId, difficulty: diffLabel,
            totalGenerated: accumulated.length,
            targetCount,
            minAcceptable: MIN_ACCEPTABLE,
            elapsedMs: Date.now() - startMs,
        });
        console.log(`═══════════════════════════════════════════════════\n`);

        if (accumulated.length < MIN_ACCEPTABLE) {
            console.warn(`⚠️ [ReinforcementService] WARNING: Only ${accumulated.length} questions generated (minimum acceptable: ${MIN_ACCEPTABLE}). Clients should NOT display until >= ${MIN_ACCEPTABLE}.`);
        }

        return accumulated.slice(0, targetCount);
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
            INTERMEDIATE: `NIVEL INTERMEDIO: ejercicios de análisis y aplicación. Escenarios prácticos multi-paso, resolución de problemas contextualizados. El estudiante debe ANALIZAR, DECIDIR y APLICAR conocimientos en situaciones con 2-3 variables o pasos de razonamiento.`,
            HARD: `NIVEL EXPERTO — COMPLEJIDAD MÁXIMA ABSOLUTA:
PROHIBIDO TERMINANTEMENTE generar ejercicios simples o de un solo paso. CADA ejercicio debe exigir razonamiento profundo, múltiples pasos y dominio avanzado del área.
- MATEMÁTICAS: Álgebra no lineal, sistemas de ecuaciones, cálculo diferencial/integral, estadística inferencial, optimización. PROHIBIDAS operaciones aritméticas puras (sumas, restas simples). Los fill_in_blank deben resolver ecuaciones, derivadas, integrales, o series.
- SQL/BASES DE DATOS: Obligatorio usar JOINs múltiples (≥2 tablas), subconsultas correlacionadas, funciones de ventana (OVER, PARTITION BY, RANK), CTEs (WITH), GROUP BY con HAVING, agregaciones anidadas. PROHIBIDAS consultas SELECT simples sin JOIN.
- PROGRAMACIÓN: Algoritmos de ordenamiento/búsqueda, complejidad O(n), recursión, patrones de diseño, estructuras de datos avanzadas (árboles, grafos, heaps). PROHIBIDOS ejercicios de sintaxis básica o "Hello World".
- FÍSICA/QUÍMICA: Problemas que requieren 3+ fórmulas encadenadas, conversiones de unidades múltiples, análisis de sistemas complejos. PROHIBIDOS cálculos de F=ma con un solo paso.
- IDIOMAS: Gramática avanzada (subjuntivo, condicionales perfectos, inversión), análisis de registro, pragmática, traducción de textos técnicos con matices.
- CUALQUIER OTRO DOMINIO: Llévalo a su expresión práctica más avanzada y compleja. Un ejercicio de HARD debe ser lo que un profesional o estudiante avanzado consideraría desafiante.`,
            FREE: `Genera ejercicios variados que cubran TODO el contenido. Mezcla niveles: comprensión, análisis, aplicación y creación.`,
        };

        // Domain-specific complexity rules conditioned on difficulty
        const hardComplexityOverrides = difficulty === 'HARD' ? `
══════════════════════════════════════════════════
REGLAS DE COMPLEJIDAD MÁXIMA PARA NIVEL HARD
══════════════════════════════════════════════════
DETECTA el dominio del material y aplica estas reglas SIN EXCEPCIÓN:

▸ MATEMÁTICAS / CÁLCULO:
  - fill_in_blank: ecuaciones cuadráticas (x²+5x-6=0, x=___), derivadas (d/dx[x³·ln(x)] = ___), integrales definidas, optimización (máximo/mínimo), sistemas 2×2 o 3×3.
  - ordering: pasos completos de demostración matemática o resolución de ecuaciones complejas.
  - multiple_choice: análisis de comportamiento de funciones, convergencia de series, interpretación gráfica de derivadas.
  - EJEMPLO fill_in_blank CORRECTO: { question: "Sea f(x) = x³ - 6x² + 9x + 2. Encuentra el mínimo local. f'(x) = 0 cuando x = ___ (entero positivo)", correctAnswer: "3", hint: "Deriva y factoriza: f'(x)=3x²-12x+9=3(x-1)(x-3)", explanation: "f'(x")=3x²-12x+9=0 → x=1 (máximo local) y x=3 (mínimo local). f(3)=27-54+27+2=2." }
  - PROHIBIDO: "Resuelve: 234 + 567 = ___" o cualquier aritmética pura.

▸ SQL / BASES DE DATOS:
  - fill_in_blank: completar CTEs, cláusulas WINDOW, subconsultas correlacionadas, GROUP BY + HAVING complejos.
  - ordering: pasos de optimización de consulta, diseño de índices, plan de ejecución.
  - multiple_choice: análisis de planes de ejecución, normalización avanzada (3NF vs BCNF), estrategias de indexación, transacciones ACID, aislamiento.
  - EJEMPLO fill_in_blank CORRECTO: { question: "Completa la función de ventana para calcular el salario acumulado por departamento ordenado por fecha:\nSELECT nombre, departamento, salario,\n  ___(salario) OVER (PARTITION BY departamento ORDER BY fecha_contratacion) AS salario_acum\nFROM empleados;", correctAnswer: "SUM", hint: "Función de agregado que suma progresivamente", explanation: "SUM() OVER(PARTITION BY ... ORDER BY ...) calcula una suma acumulada (running total) dentro de cada partición, reiniciándose por departamento." }
  - PROHIBIDO: "SELECT * FROM tabla WHERE id = ___" o cualquier consulta trivial sin JOIN.

▸ PROGRAMACIÓN:
  - fill_in_blank: completar algoritmos recursivos, implementar funciones de complejidad O(n log n), resolver casos de recursión mutua, completar implementaciones de estructuras de datos.
  - ordering: pasos de un algoritmo complejo (QuickSort, BFS/DFS, programación dinámica).
  - multiple_choice: analizar complejidad temporal/espacial de un fragmento de código dado, identificar patrones de diseño, razonar sobre condiciones de carrera o deadlocks.
  - EJEMPLO fill_in_blank CORRECTO: { question: "Completa la implementación de búsqueda binaria recursiva:\nfunction binarySearch(arr, target, lo, hi) {\n  if (lo > hi) return -1;\n  const mid = Math.floor((lo + hi) / 2);\n  if (arr[mid] === target) return mid;\n  if (arr[mid] < target) return binarySearch(arr, target, ___, hi);\n  return binarySearch(arr, target, lo, mid - 1);\n}", correctAnswer: "mid + 1", hint: "Si el elemento del medio es menor, busca en la mitad derecha", explanation: "Si arr[mid] < target, el objetivo está en [mid+1, hi]. Pasar lo=mid+1 descarta la mitad izquierda ya revisada." }

▸ FÍSICA / QUÍMICA:
  - fill_in_blank: problemas donde se encadenan 3+ fórmulas, análisis de circuitos RC/RL, equilibrio químico con Kp/Kc, termodinámica (ΔG=ΔH-TΔS).
  - ordering: pasos de análisis de un sistema físico complejo o reacción en varias etapas.
  - multiple_choice: interpretación de diagramas de fases, análisis de errores experimentales, predicción de comportamiento de sistemas.

▸ IDIOMAS (inglés, francés, etc.):
  - fill_in_blank: subjuntivo presente/pasado, condicionales mixtos (3rd conditional rewrite), voz pasiva en tiempos perfectos, verbos modales perfectos (should have, must have).
  - ordering: reordenar párrafos argumentativos, reconstruir secuencia de eventos en voz pasiva.
  - multiple_choice: análisis de registro formal/informal, corrección de errores sutiles en párrafos técnicos.

REGLA UNIVERSAL HARD: Si puedes describir el ejercicio en una línea simple ("suma X+Y", "SELECT * FROM tabla", "¿Qué hace console.log?"), NO es suficientemente complejo. El enunciado del ejercicio HARD debe presentar un escenario real, un fragmento de código no trivial, o una expresión matemática que requiera análisis.
══════════════════════════════════════════════════
` : '';

        const exerciseTypeInstructions = `
TIPOS DE EJERCICIOS DISPONIBLES (usa "type" para identificar cada uno):

1. "multiple_choice" — Pregunta de opción múltiple clásica.
   Campos: { type: "multiple_choice", question, options (array de 4), correctIndex (0-3), explanation }

2. "fill_in_blank" — Ejercicio PRÁCTICO donde el estudiante resuelve y escribe la respuesta.
   OBLIGATORIO para: cálculos matemáticos, resolver operaciones, completar código, completar frases, traducciones.
   Campos: { type: "fill_in_blank", question (usa "___" para marcar el espacio), correctAnswer (string), hint (pista opcional), explanation }
   Ejemplos por dominio (nivel HARD):
   - Matemáticas/Álgebra: { type: "fill_in_blank", question: "Resuelve el sistema: 3x + 2y = 12 y 5x - y = 7. El valor de x es ___", correctAnswer: "2", hint: "Despeja y de la segunda ecuación y sustituye en la primera", explanation: "De 5x-y=7 → y=5x-7. Sustituyendo: 3x+2(5x-7)=12 → 13x=26 → x=2, y=3." }
   - SQL: { type: "fill_in_blank", question: "Completa para obtener el segundo salario más alto:\nSELECT MAX(salario) FROM empleados WHERE salario < (___ SELECT MAX(salario) FROM empleados);", correctAnswer: "SELECT MAX(salario) FROM empleados WHERE salario <", hint: "Subconsulta que obtiene el máximo excluyendo el anterior", explanation: "La subconsulta interna obtiene el salario máximo global. La externa busca el máximo que sea menor que ese." }
   - Programación: { type: "fill_in_blank", question: "¿Cuál es la complejidad temporal de este código?\nfor(let i=0;i<n;i++) for(let j=i;j<n;j++) ops++;\nRespuesta: O(___)", correctAnswer: "n²", hint: "El bucle interno itera n-i veces para cada i", explanation: "La suma de i desde 0 a n-1 de (n-i) = n(n+1)/2 ≈ O(n²)." }
   - Física: { type: "fill_in_blank", question: "Un proyectil se lanza a 30° con v₀=40m/s. Ignorando fricción, su alcance máximo horizontal R = v₀²·sin(2θ)/g = ___ m (g=10m/s²)", correctAnswer: "138.56", hint: "sin(60°)≈0.866, R=1600·0.866/10", explanation: "R = (40²·sin(60°))/10 = (1600·0.866)/10 ≈ 138.56 m" }

3. "ordering" — Ordenar elementos en la secuencia correcta.
   Ideal para: pasos de un algoritmo, líneas de código, procesos complejos, pasos de demostración.
   Campos: { type: "ordering", question, items (array desordenado), correctOrder (array de índices del orden correcto), explanation }
   Ejemplo HARD: { type: "ordering", question: "Ordena los pasos de QuickSort para el arreglo [3,1,4,1,5]", items: ["Seleccionar pivote (ej: 3)", "Particionar: elementos < pivote a la izquierda, > a la derecha", "Llamar recursivamente a QuickSort en sub-arreglo izquierdo", "Llamar recursivamente a QuickSort en sub-arreglo derecho", "Combinar los sub-arreglos ordenados con el pivote en medio"], correctOrder: [0, 1, 2, 3, 4], explanation: "QuickSort: selecciona pivote, particiona O(n), aplica recursión en cada mitad, combina. Complejidad promedio O(n log n), peor caso O(n²)." }

DECISIÓN INTELIGENTE DE TIPOS — PRIORIZA EJERCICIOS PRÁCTICOS COMPLEJOS:
- PRIMERO identifica el DOMINIO del tema/tarea (matemáticas, SQL, programación, idiomas, ciencias, etc.)
- SEGUNDO lleva ese dominio a su EXPRESIÓN PRÁCTICA MÁS COMPLEJA según el nivel de dificultad.
- PRINCIPIO CLAVE: Si el tema involucra HACER (calcular, resolver, programar, escribir), usa "fill_in_blank" para que el estudiante HAGA, no solo elija respuestas — y que lo que haga sea realmente complejo.

REGLAS POR DOMINIO (aplica la versión del nivel seleccionado):
- MATEMÁTICAS: MÍNIMO 5 de ${targetCount} deben ser "fill_in_blank". EASY: aritmética básica. INTERMEDIATE: álgebra lineal, porcentajes compuestos. HARD: ecuaciones cuadráticas, sistemas, derivadas, integrales — NUNCA sumas simples.
- SQL/BASES DE DATOS: MÍNIMO 4 "fill_in_blank". EASY: SELECTs con WHERE. INTERMEDIATE: JOINs simples, GROUP BY. HARD: CTEs, window functions, subconsultas correlacionadas, optimización — NUNCA SELECTs sin JOIN.
- PROGRAMACIÓN: MÍNIMO 4 "fill_in_blank" para completar código, 2 "ordering" para algoritmos, resto "multiple_choice" para análisis de complejidad. HARD: algoritmos avanzados, nunca sintaxis básica.
- IDIOMAS: MÍNIMO 4 "fill_in_blank" para gramática avanzada/traducción técnica, resto "multiple_choice" para análisis pragmático.
- CIENCIAS (física, química, biología): MÍNIMO 3 "fill_in_blank" con problemas multi-fórmula, 1 "ordering" para procesos, resto "multiple_choice" con análisis de escenarios.
- HISTORIA, SOCIALES: 2-3 "ordering" para causalidad histórica compleja, resto "multiple_choice" para análisis crítico comparativo.
- OTROS DOMINIOS: MÍNIMO 3 "fill_in_blank" de resolución práctica, 1-2 "ordering", resto "multiple_choice" con escenarios de toma de decisiones.

REGLAS DE CALIDAD:
- Los ejercicios fill_in_blank deben tener UNA sola respuesta correcta clara y verificable.
- Para ordering, provee entre 4 y 6 items con secuencias no triviales.
- NO varíes la dificultad internamente en un set HARD — mantén la complejidad máxima en TODOS los ejercicios.
- Contextualiza: usa escenarios reales del mundo profesional, no de aula básica.

REGLA CRÍTICA DE LONGITUD EN OPCIONES (multiple_choice) — ANTI-SESGO DE LONGITUD:
- TODAS las opciones DEBEN tener longitud MUY SIMILAR (máximo 15% de diferencia en caracteres entre la más corta y la más larga).
- La respuesta correcta NUNCA debe ser más larga, más detallada ni más elaborada que las incorrectas.
- Si la respuesta correcta necesita ser específica, haz que TODAS las opciones sean IGUALMENTE específicas y detalladas.
- PROHIBIDO ABSOLUTO: opciones cortas como distractores y la correcta larga/detallada.
- TÉCNICA OBLIGATORIA: Escribe PRIMERO la respuesta correcta con el nivel de detalle necesario. Luego escribe CADA distractor con el MISMO nivel de detalle, la MISMA estructura gramatical y longitud SIMILAR.
- VERIFICACIÓN: Antes de finalizar cada pregunta multiple_choice, CUENTA los caracteres de cada opción. Si alguna difiere más de 15% del promedio, REESCRIBE las opciones.

DISTRIBUCIÓN OBLIGATORIA DE TIPOS:
- SIEMPRE incluye AL MENOS 3 ejercicios "fill_in_blank" y AL MENOS 1 "ordering" en cada set de ${targetCount}.
- NUNCA generes SOLO preguntas "multiple_choice". La variedad es OBLIGATORIA.
`;

        return `Eres un profesor experto de nivel universitario/profesional diseñando ${targetCount} ejercicios de evaluación.
${difficultyInstructions[difficulty] || difficultyInstructions.HARD}
${groundingRule}
${hardComplexityOverrides}
${exerciseTypeInstructions}
PROHIBIDO ejercicios de memorización pura o de un solo paso trivial. El estudiante debe RAZONAR, ANALIZAR y CONSTRUIR soluciones complejas.
La explicación debe ser detallada y educativa, mostrando el procedimiento completo de resolución.
REGLA ANTI-SESGO: En preguntas de opción múltiple, TODAS las opciones DEBEN tener la MISMA longitud y estructura. Escribe PRIMERO la correcta, luego iguala CADA distractor en largo y detalle. La respuesta correcta NUNCA debe ser la más larga. VERIFICA contando caracteres.
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
                const options = q.options.map(o => String(o ?? '').trim());

                // Anti-length-bias: equalize all option lengths
                const optionLens = options.map(o => o.length);
                const avgLen = optionLens.reduce((a, b) => a + b, 0) / optionLens.length;
                const correctLen = options[correctIndex].length;
                const maxOtherLen = Math.max(...options.filter((_, i) => i !== correctIndex).map(o => o.length));

                // If correct answer is >40% longer than the average of others, trim it
                if (avgLen > 0 && correctLen > avgLen * 1.4) {
                    console.warn(`[ReinforcementService] Length bias detected: correct="${options[correctIndex].substring(0, 40)}..." (${correctLen} chars) vs avg (${Math.round(avgLen)} chars). Equalizing.`);
                    const targetLen = Math.round(Math.max(maxOtherLen, avgLen * 1.1));
                    if (correctLen > targetLen) {
                        const trimmed = options[correctIndex].substring(0, targetLen);
                        // Find a natural break point (comma, period, dash, 'porque', 'ya que')
                        const breakPoints = [
                            trimmed.lastIndexOf(','),
                            trimmed.lastIndexOf('.'),
                            trimmed.lastIndexOf(' -'),
                            trimmed.lastIndexOf(' porque'),
                            trimmed.lastIndexOf(' ya que'),
                            trimmed.lastIndexOf(' debido'),
                        ].filter(p => p > targetLen * 0.4);
                        const bestBreak = breakPoints.length > 0 ? Math.max(...breakPoints) : -1;
                        if (bestBreak > 0) {
                            options[correctIndex] = options[correctIndex].substring(0, bestBreak).trim();
                        } else {
                            // Trim to last complete word within target length
                            const lastSpace = trimmed.lastIndexOf(' ');
                            if (lastSpace > targetLen * 0.5) {
                                options[correctIndex] = options[correctIndex].substring(0, lastSpace).trim();
                            }
                        }
                    }
                }

                return {
                    type: 'multiple_choice',
                    question: q.question.trim(),
                    options,
                    correctIndex,
                    explanation: String(q.explanation ?? '').trim() || `La respuesta correcta es: "${options[correctIndex]}"`,
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

