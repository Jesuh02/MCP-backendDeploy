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
let mammoth;
try { mammoth = require('mammoth'); } catch (_) { mammoth = null; }

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

                        // Derive actual filename from URL path (item.title may lack extension)
                        let urlFileName = fileName;
                        try {
                            const urlPath = new URL(body).pathname;
                            const urlBase = decodeURIComponent(urlPath.split('/').pop() || '');
                            if (urlBase && urlBase.includes('.')) urlFileName = urlBase;
                        } catch (_) { /* keep original fileName */ }

                        const nameLower = (urlFileName || fileName).toLowerCase();
                        const ctLower = (fileData.contentType || '').toLowerCase();
                        const isPdf = nameLower.endsWith('.pdf') || ctLower.includes('pdf');
                        const isDocx = nameLower.endsWith('.docx') || nameLower.endsWith('.doc') ||
                            ctLower.includes('wordprocessingml') ||
                            ctLower.includes('openxmlformats') ||
                            ctLower.includes('msword');

                        // Magic-byte detection: if content is binary, check ZIP header (docx/xlsx/pptx are ZIP)
                        const isDocxFinal = isDocx || (
                            fileData.buffer &&
                            fileData.buffer[0] === 0x50 && fileData.buffer[1] === 0x4B &&
                            fileData.buffer[2] === 0x03 && fileData.buffer[3] === 0x04 &&
                            !nameLower.endsWith('.xlsx') && !nameLower.endsWith('.pptx')
                        );

                        if (isPdf && pdfParse) {
                            try {
                                const pdfBuffer = fileData.buffer || Buffer.from(fileData.content, fileData.isBase64 ? 'base64' : 'utf-8');
                                const pdfData = await pdfParse(pdfBuffer);
                                textToIngest = pdfData.text;
                                if (!textToIngest || textToIngest.trim().length < 50) textToIngest = null;
                            } catch (pdfErr) {
                                console.warn(`[ReinforcementService] PDF parse error for ${fileName}: ${pdfErr.message}`);
                            }
                        } else if (isDocxFinal && mammoth) {
                            try {
                                const buffer = fileData.buffer || Buffer.from(fileData.content, fileData.isBase64 ? 'base64' : 'binary');
                                const docxResult = await mammoth.extractRawText({ buffer });
                                textToIngest = docxResult.value;
                                if (!textToIngest || textToIngest.trim().length < 50) textToIngest = null;
                                console.log(`[ReinforcementService] DOCX extracted ${textToIngest?.length ?? 0} chars from "${urlFileName}"`);
                            } catch (docxErr) {
                                console.warn(`[ReinforcementService] DOCX parse error for ${fileName}: ${docxErr.message}`);
                            }
                        } else if (!fileData.isBase64) {
                            // Safety guard: reject content that looks like binary garbage
                            const sample = (fileData.content || '').substring(0, 500);
                            const controlChars = (sample.match(/[\x00-\x08\x0E-\x1F\x7F]/g) || []).length;
                            if (controlChars > sample.length * 0.05) {
                                console.warn(`[ReinforcementService] Skipping binary content disguised as text: ${urlFileName} (${controlChars} control chars)`);
                                continue;
                            }
                            textToIngest = fileData.content;
                        }
                    } catch (dlErr) {
                        console.warn(`[ReinforcementService] Download error for ${fileName}: ${dlErr.message}`);
                    }
                } else {
                    // Body is plain text content — guard against binary/Office XML garbage
                    if (this._looksLikeBinaryOrOfficeXml(body)) {
                        console.warn(`[ReinforcementService] Skipping binary/Office-XML body for content_item ${item.id} (${fileName})`);
                    } else {
                        textToIngest = body;
                    }
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

        // Step 2b: Detect domain to enforce topic boundary and prevent cross-domain contamination
        const domain = this._inferDomain(topicName, taskName, ragContent);
        const domainLockBlock = this._buildDomainLockBlock(domain, topicName, taskName);
        console.log(`🎯 [ReinforcementService] Detected domain: ${domain} (topic='${topicName}', task='${taskName}')`);

        const topicHint = topicName
            ? `El tema es "${topicName}"${taskName ? ` y la tarea es "${taskName}"` : ''}. Dominio detectado: ${domain}. TODOS los ejercicios son EXCLUSIVAMENTE de ese dominio. Lleva el dominio a su EXPRESIÓN MÁS COMPLEJA Y AVANZADA.\n\n${domainLockBlock}`
            : `\n${domainLockBlock}`;

        // Complexity enforcement added to the user prompt for HARD difficulty
        const hardEnforcement = diffLabel === 'HARD'
            ? `\n\n⚠️⚠️⚠️ NIVEL HARD — COMPLEJIDAD MÁXIMA NO NEGOCIABLE ⚠️⚠️⚠️\n\nPASO 1: El dominio YA FUE DETERMINADO: ${domain}. NO cambies de dominio.\nPASO 2: Lleva ese dominio a su EXPRESIÓN PRÁCTICA MÁS AVANZADA Y COMPLEJA posible.\nPASO 3: Genera CADA ejercicio al nivel que desafiaría a un profesional o estudiante avanzado del dominio ${domain}.\n\nREGLAS INQUEBRANTABLES PARA DOMINIO ${domain}:\n${domain === 'MATH' ? '- SUMAS: genera sumas de 7+ dígitos (ej: 1,023,232 + 12,213,456 + 987,654 = ___), sumas encadenadas de 4+ operandos, sumas con decimales extensos, sumatorias Σ, sumas de matrices, series aritméticas/geométricas. NUNCA sumas de 1-3 dígitos. NUNCA algoritmos de programación (Kahan, etc.).' : ''}\n${domain === 'MATH' ? '- ÁLGEBRA: ecuaciones cuadráticas, sistemas de ecuaciones, derivadas, integrales definidas. NUNCA ecuaciones lineales de un solo paso.' : ''}\n${domain === 'SQL' ? '- JOINs múltiples (≥2 tablas), subconsultas correlacionadas, funciones de ventana (OVER, PARTITION BY, RANK, ROW_NUMBER), CTEs (WITH), GROUP BY con HAVING. NUNCA SELECT simple sin JOIN.' : ''}\n${domain === 'PROGRAMMING' ? '- Algoritmos con análisis de complejidad O(n log n), recursión con memoización, programación dinámica, grafos. NUNCA sintaxis básica ni Hello World.' : ''}\n- CUALQUIER DOMINIO: identifica el concepto central y llévalo a su versión más compleja y profesional.\n\nTEST DE COMPLEJIDAD: Si un ejercicio se resuelve en <30 segundos de pensamiento activo → DESCÁRTALO y genera uno más complejo.`
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

            // Server-side complexity filter: reject trivial exercises in HARD mode
            const filtered = diffLabel === 'HARD' ? deduped.filter(q => {
                const trivial = this._isExerciseTrivialForHard(q, domain);
                if (trivial) {
                    console.warn(`[ReinforcementService] HARD filter rejected trivial/off-domain exercise: "${q.question.substring(0, 80)}..."`);
                }
                return !trivial;
            }) : deduped;

            const prevAccumulated = accumulated.length;

            for (const q of filtered) {
                if (accumulated.length >= targetCount) break;
                accumulated.push(q);
                allExcludedTexts.push(q.question);
            }

            const newlyAdded = accumulated.length - prevAccumulated;
            console.log(`🔄 [ReinforcementService] Iteration ${iteration + 1}: parsed=${questions.length}, afterDedup=${deduped.length}, afterComplexityFilter=${filtered.length}, newlyAdded=${newlyAdded}, accumulated=${accumulated.length}/${targetCount}`);

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

    /**
     * Infers the primary domain from topic/task name and RAG content.
     * Returns a normalized domain key used for domain-lock enforcement.
     * @private
     */
    _inferDomain(topicName = '', taskName = '', ragContent = '') {
        // Topic/task name is the STRONGEST signal — weight it much higher than RAG
        const topicText = `${topicName} ${taskName}`.toLowerCase();
        // RAG content may contain off-topic examples; only use first 1500 chars as weak signal
        const ragSample = ragContent.substring(0, 1500).toLowerCase();

        const DOMAIN_KEYWORDS = {
            MATH: {
                strong: ['suma', 'sumas', 'adición', 'sustracción', 'resta', 'multiplicación', 'división',
                    'aritmética', 'álgebra', 'cálculo', 'calculo', 'ecuación', 'ecuaciones', 'matemática',
                    'matemáticas', 'trigonometría', 'geometría', 'fracción', 'decimal', 'porcentaje',
                    'integral', 'derivada', 'límite', 'serie', 'sumatoria', 'logaritmo', 'exponente',
                    'polinomio', 'matriz', 'vector', 'probabilidad', 'estadística', 'binomial'],
                weak: ['número', 'números', 'operación', 'resultado', 'calcular', 'resolver'],
            },
            SQL: {
                strong: ['sql', 'select', 'query', 'base de datos', 'database', 'postgresql', 'mysql',
                    'supabase', 'joins', 'subconsulta', 'stored procedure', 'trigger', 'índice', 'índices'],
                weak: ['tabla', 'tablas', 'consulta', 'registro', 'campo'],
            },
            PROGRAMMING: {
                strong: ['programación', 'programming', 'algoritmo', 'algoritmos', 'javascript', 'python',
                    'java', 'typescript', 'c++', 'c#', 'kotlin', 'swift', 'react', 'vue', 'angular',
                    'api', 'frontend', 'backend', 'fullstack', 'recursión', 'poo', 'oop', 'clase',
                    'función', 'variable', 'estructura de datos', 'grafo', 'árbol binario'],
                weak: ['código', 'función', 'objeto', 'método', 'loop', 'ciclo'],
            },
            PHYSICS: {
                strong: ['física', 'physics', 'fuerza', 'energía', 'velocidad', 'aceleración', 'mecánica',
                    'termodinámica', 'óptica', 'electromagnetismo', 'ondas', 'newton', 'joule', 'watt'],
                weak: ['masa', 'tiempo', 'distancia', 'potencia'],
            },
            CHEMISTRY: {
                strong: ['química', 'chemistry', 'reacción', 'mol', 'átomo', 'molécula', 'concentración',
                    'ph', 'oxidación', 'reducción', 'estequiometría', 'enlace', 'tabla periódica'],
                weak: ['elemento', 'compuesto', 'mezcla', 'solución'],
            },
            LANGUAGE: {
                strong: ['inglés', 'español', 'francés', 'alemán', 'idioma', 'gramática', 'vocabulario',
                    'conjugación', 'sintaxis', 'semántica', 'escritura', 'comprensión lectora', 'redacción',
                    'ortografía', 'puntuación', 'subjuntivo', 'condicional'],
                weak: ['verbo', 'sustantivo', 'adjetivo', 'adverbio', 'preposición'],
            },
            HISTORY: {
                strong: ['historia', 'history', 'guerra', 'revolución', 'siglo', 'época', 'civilización',
                    'independencia', 'colonización', 'monarquía', 'república', 'imperio', 'tratado',
                    'movimiento social', 'dictadura'],
                weak: ['año', 'período', 'personaje', 'país', 'evento'],
            },
            ACCOUNTING: {
                strong: ['contabilidad', 'accounting', 'balance', 'debe', 'haber', 'activo', 'pasivo',
                    'patrimonio', 'asiento', 'estado financiero', 'flujo de caja', 'depreciación',
                    'amortización', 'auditoría', 'finanzas', 'presupuesto', 'tributación'],
                weak: ['cuenta', 'ingreso', 'egreso', 'gasto', 'capital'],
            },
            BIOLOGY: {
                strong: ['biología', 'biology', 'célula', 'adn', 'proteína', 'genética', 'evolución',
                    'ecosistema', 'mitosis', 'meiosis', 'fotosíntesis', 'respiración celular', 'tejido'],
                weak: ['organismo', 'especie', 'gen', 'cromosoma'],
            },
        };

        const scores = {};
        for (const [domain, kw] of Object.entries(DOMAIN_KEYWORDS)) {
            let score = 0;
            // Strong match in topic name → very high weight (10 pts each)
            score += kw.strong.filter(k => topicText.includes(k)).length * 10;
            // Weak match in topic name → medium weight (4 pts each)
            score += kw.weak.filter(k => topicText.includes(k)).length * 4;
            // Strong match in RAG sample → low weight (1 pt each)
            score += kw.strong.filter(k => ragSample.includes(k)).length * 1;
            scores[domain] = score;
        }

        const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        const [bestDomain, bestScore] = sorted[0];
        const [secondDomain, secondScore] = sorted[1] || ['GENERAL', 0];

        // Only declare a domain if the best score is meaningfully higher than the second
        if (bestScore === 0) return 'GENERAL';
        // If MATH scores highest, return MATH even if score is 10 (one keyword match)
        return bestScore >= 4 ? bestDomain : 'GENERAL';
    }

    /**
     * Builds a hard domain-lock instruction block that prohibits off-domain questions.
     * @private
     */
    _buildDomainLockBlock(domain, topicName, taskName) {
        const DOMAIN_LABELS = {
            MATH: 'MATEMÁTICAS / ARITMÉTICA',
            SQL: 'SQL / BASES DE DATOS',
            PROGRAMMING: 'PROGRAMACIÓN / ALGORITMOS',
            PHYSICS: 'FÍSICA',
            CHEMISTRY: 'QUÍMICA',
            LANGUAGE: 'IDIOMAS / LENGUAJE',
            HISTORY: 'HISTORIA / CIENCIAS SOCIALES',
            ACCOUNTING: 'CONTABILIDAD / FINANZAS',
            BIOLOGY: 'BIOLOGÍA / CIENCIAS NATURALES',
            GENERAL: 'CONOCIMIENTO GENERAL (según el material)',
        };

        const FORBIDDEN_DOMAINS = {
            MATH: 'SQL, programación (Python/JS/Java/etc.), algoritmos de software, bases de datos, historia, idiomas. ESPECIALMENTE prohibido: algoritmos como Kahan, búsqueda binaria, QuickSort, BFS, DFS o cualquier pseudocódigo de programación.',
            SQL: 'matemáticas puras, física, química, historia, idiomas, código de programación que no sea SQL',
            PROGRAMMING: 'historia, idiomas básicos, ciencias puras sin relación al código',
            PHYSICS: 'programación, SQL, historia, idiomas, contabilidad, biología',
            CHEMISTRY: 'programación, SQL, historia, idiomas, matemáticas sin relación a la química',
            LANGUAGE: 'programación, SQL, matemáticas, física, química, biología',
            HISTORY: 'programación, SQL, matemáticas, física, química, biología',
            ACCOUNTING: 'programación, física, química, historia, idiomas',
            BIOLOGY: 'programación, SQL, historia, idiomas, contabilidad',
            GENERAL: '(ningún dominio específico prohibido — sigue el tema del material)',
        };

        const label = DOMAIN_LABELS[domain] || domain;
        const forbidden = FORBIDDEN_DOMAINS[domain] || '';
        const topicCtx = topicName ? `"${topicName}"${taskName ? ` → Tarea: "${taskName}"` : ''}` : '(ver material adjunto)';

        return `
🔒🔒🔒 BLOQUEO ABSOLUTO DE DOMINIO — REGLA NO NEGOCIABLE 🔒🔒🔒

El material de estudio pertenece EXCLUSIVAMENTE al dominio: ██ ${label} ██
Tema activo: ${topicCtx}

▶ TODOS los ejercicios deben pertenecer al dominio: ${label}
▶ PROHIBICIÓN TOTAL de ejercicios sobre: ${forbidden}

⚠️ ADVERTENCIA CRÍTICA: Si el material de referencia contiene ejemplos de ${forbidden} como contexto o analogía, IGNÓRALOS completamente para la generación de ejercicios. Solo genera ejercicios del dominio ${label}.

VERIFICACIÓN OBLIGATORIA antes de cada ejercicio:
  → Pregunta: "¿Este ejercicio es sobre ${label}?"
  → Si la respuesta es NO → DESCARTA el ejercicio y genera uno correcto del dominio ${label}.
  → Si el ejercicio menciona código, algoritmos de software, SQL, o lenguajes de programación y el dominio es MATH → DESCARTA y reemplaza.

🔒🔒🔒 FIN BLOQUEO DE DOMINIO 🔒🔒🔒`.trim();
    }

    /** @private Build system prompt based on difficulty */
    _buildSystemPrompt(difficulty, targetCount) {
        const groundingRule = `REGLA: Basa los ejercicios EXCLUSIVAMENTE en el material proporcionado. NO inventes información.`;

        const difficultyInstructions = {
            EASY: `NIVEL INTRODUCTORIO: ejercicios de comprensión y práctica básica. Operaciones simples, conceptos fundamentales. Usa "¿Por qué?", "¿Para qué?", "¿Qué pasaría si...?" para preguntas; ejercicios directos y sencillos para práctica.`,
            INTERMEDIATE: `NIVEL INTERMEDIO: ejercicios de análisis y aplicación. Escenarios prácticos multi-paso, resolución de problemas contextualizados. El estudiante debe ANALIZAR, DECIDIR y APLICAR conocimientos en situaciones con 2-3 variables o pasos de razonamiento.`,
            HARD: `NIVEL EXPERTO — COMPLEJIDAD MÁXIMA ABSOLUTA (NO NEGOCIABLE):

══ PASO 0 OBLIGATORIO: ANÁLISIS DE DOMINIO ══
ANTES de generar cualquier ejercicio:
1. Identifica el DOMINIO CENTRAL del material (matemáticas, SQL, programación, física, idiomas, contabilidad, etc.)
2. Identifica los CONCEPTOS MÁS AVANZADOS presentes en el material
3. Lleva esos conceptos a su EXPRESIÓN PRÁCTICA MÁS COMPLEJA posible
TODOS los ejercicios deben estar al nivel de complejidad máxima de ese dominio.

══ REGLA ABSOLUTA: CERO EJERCICIOS TRIVIALES ══
Si un ejercicio puede resolverse en menos de 30 segundos de pensamiento activo → DESCÁRTALO.
Si un ejercicio involucra solo UNA operación, UN paso, o UNA consulta simple → es INACEPTABLE.
CADA ejercicio HARD debe requerir MÍNIMO 3 pasos de razonamiento encadenados.

REGLAS POR DOMINIO (OBLIGATORIAS):
- MATEMÁTICAS: Usa números GRANDES y operaciones COMPUESTAS. Si el tema es sumas, genera sumas de 7+ dígitos (ej: 1023232 + 12213123), sumas encadenadas de 4+ números, sumas con decimales extensos, sumatorias con notación Σ, sumas de series geométricas/aritméticas, sumas de matrices. PROHIBIDO: sumas de 1-3 dígitos como "24+18" o "234+567". Para álgebra: sistemas de ecuaciones, ecuaciones cuadráticas, derivadas, integrales. PROHIBIDO: ecuaciones lineales de un paso.
- SQL/BASES DE DATOS: JOINs múltiples (≥2 tablas), subconsultas correlacionadas, funciones de ventana (OVER, PARTITION BY, RANK, ROW_NUMBER, LAG, LEAD), CTEs (WITH/WITH RECURSIVE), GROUP BY con HAVING, CASE WHEN anidados. PROHIBIDO: SELECT simple, WHERE sin JOIN, consultas de una sola tabla.
- PROGRAMACIÓN: Algoritmos con análisis de complejidad O(n log n), recursión con memoización, programación dinámica, grafos (BFS/DFS/Dijkstra), patrones de diseño, concurrencia. PROHIBIDO: sintaxis básica, Hello World, bucles for simples, console.log.
- FÍSICA/QUÍMICA: Problemas con 3+ fórmulas encadenadas, circuitos RC/RL/RLC, termodinámica de procesos reales, equilibrio químico multi-etapa. PROHIBIDO: F=ma de un solo paso, conversiones simples.
- IDIOMAS: Gramática avanzada (subjuntivo compuesto, condicionales mixtos tipo 3, inversión estilística), análisis pragmático, traducción técnica. PROHIBIDO: present simple, vocabulario básico.
- CONTABILIDAD/FINANZAS: Asientos compuestos multi-cuenta, análisis de ratios encadenados, flujo de caja descontado. PROHIBIDO: asientos simples de una cuenta.
- CUALQUIER OTRO DOMINIO: Identifica el concepto central y pregúntate: "¿Un profesional con 5 años de experiencia encontraría este ejercicio desafiante?" Si NO → hazlo más complejo.

══ AUTO-VALIDACIÓN OBLIGATORIA ══
Antes de incluir CADA ejercicio en el JSON, verifica:
✓ ¿Requiere 3+ pasos de razonamiento? Si NO → RECHAZAR.
✓ ¿Un estudiante de primer semestre podría resolverlo en 10 segundos? Si SÍ → RECHAZAR.
✓ ¿Involucra solo una operación/concepto aislado? Si SÍ → RECHAZAR.
✓ ¿Es del nivel más avanzado posible dentro del dominio? Si NO → escalar complejidad.

══ VERIFICACIÓN MATEMÁTICA RIGUROSA (OBLIGATORIA) ══
⚠️ NO asumas que tu primer cálculo es correcto. DEBES hacer doble verificación:
1. Realiza el cálculo paso a paso.
2. VERIFICA el resultado repitiendo el cálculo con un método diferente (ej: suma en orden inverso, descomposición, etc.).
3. Si el resultado de la verificación NO coincide → REHAZ el cálculo desde cero.
4. Si el cálculo es demasiado complejo para tu ventana de contexto (>8 dígitos, >5 operandos), SIMPLIFICA los números pero AUMENTA la complejidad del razonamiento lógico (más pasos, conversiones, redondeo).
5. PROHIBIDO generar respuestas con más de 8 dígitos significativos en fill_in_blank. Si el resultado natural tiene más, redondea y pide el resultado redondeado explícitamente.
6. La explicación DEBE mostrar EXACTAMENTE los mismos pasos que producen el correctAnswer. Si hay discrepancia → la pregunta es INVÁLIDA.

══ CALIDAD DE DISTRACTORES (multiple_choice) ══
⚠️ NUNCA generes opciones con el mismo valor numérico o la misma explicación.
Cada distractor DEBE representar un error conceptual plausible:
- Error de acarreo (ej: olvidar llevar 1 en una suma)
- Error de fórmula (ej: usar suma en vez de resta)
- Error de redondeo (ej: redondear hacia arriba vs abajo)
- Error de orden de operaciones (ej: sumar antes de multiplicar)
Si NO puedes generar 3 distractores plausibles y DISTINTOS → convierte la pregunta a fill_in_blank.
VERIFICACIÓN: Las 4 opciones DEBEN ser valores DIFERENTES entre sí. Si dos opciones son iguales → la pregunta es INVÁLIDA.

══ PRECISION EN fill_in_blank ══
- PROHIBIDO pedir respuestas con más de 2 decimales. Si el resultado tiene más decimales, pide explícitamente que redondeen (ej: "redondea a 2 decimales").
- PROHIBIDO pedir números de más de 8 dígitos sin separadores. Si el resultado es grande, permite separadores o pide el resultado en notación simplificada.
- La respuesta correcta (correctAnswer) NUNCA debe incluir separadores de miles (comas, puntos). Solo dígitos y opcionalmente un punto decimal.
- "Difícil" NO significa "números más largos". Significa mayor PROFUNDIDAD COGNITIVA: más pasos, conversiones, análisis de casos, redondeo estratégico.`,
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

▸ REGLA DE ESCALADO POR DOMINIO (APLICA A CUALQUIER TEMA):
  - Identifica el NÚCLEO del contenido RAG.
  - Pregúntate: "¿Cuál es la versión más avanzada y profesional de aplicar este conocimiento?"
  - Genera ejercicios a ESE nivel. Ejemplos:
    * Tema "sumas" → sumatorias Σ, series geométricas, sumas parciales, sumas de Riemann
    * Tema "variables en Python" → closures, scope chains, generadores, decoradores con estado
    * Tema "SELECT en SQL" → window functions con PARTITION BY, CTEs recursivos, subconsultas correlacionadas
    * Tema "fuerzas en física" → sistemas de poleas con fricción, planos inclinados con resortes
    * Tema "present tense" en inglés → present perfect continuous vs simple, inversión estilística
    * Tema "contabilidad básica" → asientos de ajuste con depreciación, amortización, provisiones

▸ AUTO-CHECK FINAL (OBLIGATORIO antes de emitir el JSON):
  Para cada ejercicio, verifica mentalmente:
  1. ¿El enunciado tiene MÁS de 2 líneas o incluye código/fórmulas? ✓
  2. ¿Requiere combinar 2+ conceptos del material? ✓
  3. ¿Un profesional del área tardaría >30 segundos en resolverlo? ✓
  Si algún ejercicio no cumple los 3 puntos, REEMPLÁZALO por uno más complejo.
══════════════════════════════════════════════════
` : '';

        const exerciseTypeInstructions = `
TIPOS DE EJERCICIOS DISPONIBLES (usa "type" para identificar cada uno):

1. "multiple_choice" — Pregunta de opción múltiple clásica.
   Campos: { type: "multiple_choice", question, options (array de 4), correctIndex (0-3), explanation }

2. "fill_in_blank" — Ejercicio PRÁCTICO donde el estudiante resuelve y escribe la respuesta.
   OBLIGATORIO para: cálculos matemáticos, resolver operaciones, completar código, completar frases, traducciones.
   Campos: { type: "fill_in_blank", question (usa "___" para marcar el espacio), correctAnswer (string), hint (pista opcional), explanation }
   Ejemplos por dominio y dificultad:
   EASY:
   - Matemáticas: { type: "fill_in_blank", question: "Resuelve: 24 + 18 = ___", correctAnswer: "42", hint: "Suma las unidades primero", explanation: "24 + 18 = 42" }
   INTERMEDIATE:
   - Matemáticas: { type: "fill_in_blank", question: "Resuelve: 4,827 + 3,695 = ___", correctAnswer: "8522", hint: "Suma columna por columna con acarreo", explanation: "7+5=12 (lleva 1), 2+9+1=12 (lleva 1), 8+6+1=15 (lleva 1), 4+3+1=8. Resultado: 8,522" }
   HARD (COMPLEJIDAD MÁXIMA — los ejemplos para HARD son los que debes seguir):
   - Matemáticas/Suma: { type: "fill_in_blank", question: "Una empresa tiene 3 sucursales con ventas mensuales de $45,230, $78,945 y $63,120. Calcula el total de ventas y luego aplica un impuesto del 16%. ¿Cuál es el monto total con impuesto? (redondea a entero)", correctAnswer: "217422", hint: "Primero suma las 3 cantidades, luego multiplica por 1.16", explanation: "Paso 1: 45230 + 78945 + 63120 = 187295. Paso 2: 187295 × 1.16 = 217262.2 → redondeado: 217262. VERIFICACIÓN: 187295 × 0.16 = 29967.2, + 187295 = 217262." }
   - Matemáticas/Álgebra: { type: "fill_in_blank", question: "Sea f(x) = x³ - 6x² + 9x + 2. Encuentra el valor de x donde ocurre el mínimo local. f'(x) = 0 cuando x = ___ (entero positivo)", correctAnswer: "3", hint: "Deriva y factoriza: f'(x)=3x²-12x+9=3(x-1)(x-3)", explanation: "f'(x)=3x²-12x+9=0 → x=1 (máximo local) y x=3 (mínimo local). VERIFICACIÓN: f''(x)=6x-12, f''(3)=6>0 confirma mínimo local. f(3)=27-54+27+2=2." }
   - SQL: { type: "fill_in_blank", question: "Completa la función de ventana para calcular el salario acumulado por departamento:\nSELECT nombre, departamento, salario,\n  ___(salario) OVER (PARTITION BY departamento ORDER BY fecha_contratacion) AS salario_acum\nFROM empleados;", correctAnswer: "SUM", hint: "Función de agregado que suma progresivamente", explanation: "SUM() OVER(PARTITION BY ... ORDER BY ...) calcula una suma acumulada (running total) dentro de cada partición." }
   - Programación: { type: "fill_in_blank", question: "Completa la búsqueda binaria recursiva:\nfunction binarySearch(arr, target, lo, hi) {\n  if (lo > hi) return -1;\n  const mid = Math.floor((lo + hi) / 2);\n  if (arr[mid] === target) return mid;\n  if (arr[mid] < target) return binarySearch(arr, target, ___, hi);\n  return binarySearch(arr, target, lo, mid - 1);\n}", correctAnswer: "mid + 1", hint: "Si el elemento del medio es menor, busca en la mitad derecha", explanation: "Si arr[mid] < target, el objetivo está en [mid+1, hi]. Pasar lo=mid+1 descarta la mitad izquierda." }
   - Física: { type: "fill_in_blank", question: "Un proyectil se lanza a 30° con v₀=40m/s. Su alcance horizontal R = v₀²·sin(2θ)/g = ___ m (g=10m/s², sin(60°)≈0.866)", correctAnswer: "138.56", hint: "R=1600·0.866/10", explanation: "R = (40²·sin(60°))/10 = (1600·0.866)/10 ≈ 138.56 m" }

3. "ordering" — Ordenar elementos en la secuencia correcta.
   Ideal para: pasos de un algoritmo, líneas de código, procesos complejos, pasos de demostración.
   Campos: { type: "ordering", question, items (array desordenado), correctOrder (array de índices del orden correcto), explanation }
   Ejemplo EASY: { type: "ordering", question: "Ordena los pasos para resolver 234 + 178", items: ["Obtener resultado: 412", "Sumar unidades: 4+8=12, escribir 2, llevar 1", "Sumar centenas: 2+1+1=4", "Sumar decenas: 3+7+1=11, escribir 1, llevar 1"], correctOrder: [1, 3, 2, 0], explanation: "Se suman de derecha a izquierda." }
   Ejemplo HARD: { type: "ordering", question: "Ordena los pasos de QuickSort para el arreglo [3,8,1,5,2,7]", items: ["Seleccionar pivote (ej: 5)", "Particionar: [3,1,2] [5] [8,7]", "Recursión izquierda: [1,2,3]", "Recursión derecha: [7,8]", "Combinar: [1,2,3,5,7,8]"], correctOrder: [0, 1, 2, 3, 4], explanation: "QuickSort: selecciona pivote, particiona O(n), aplica recursión en cada mitad. Complejidad promedio O(n log n)." }

DECISIÓN INTELIGENTE DE TIPOS — PRIORIZA EJERCICIOS PRÁCTICOS:
- PRIMERO identifica el DOMINIO del tema/tarea (matemáticas, programación, idiomas, ciencias, etc.)
- SEGUNDO decide qué tipos de ejercicios MIDEN MEJOR la competencia del estudiante en ese dominio.
- PRINCIPIO CLAVE: Si el tema involucra HACER (calcular, resolver, programar, escribir), usa "fill_in_blank" para que el estudiante HAGA, no solo elija respuestas.

REGLAS POR DOMINIO (AJUSTA COMPLEJIDAD según dificultad seleccionada):
- MATEMÁTICAS: MÍNIMO 5 de ${targetCount} deben ser "fill_in_blank". Escala de complejidad: EASY (1-2 dígitos: 3+5), INTERMEDIATE (3-4 dígitos: 4827+3695), HARD (7+ dígitos, 3+ operandos, operaciones mezcladas: 1023232+12213456+987654, o sumatorias Σ, series, sistemas de ecuaciones, derivadas, integrales). PROHIBIDO EN HARD: sumas de menos de 5 dígitos o de solo 2 números simples.
- SQL/BASES DE DATOS: MÍNIMO 4 "fill_in_blank". EASY: SELECTs con WHERE. INTERMEDIATE: JOINs simples, GROUP BY. HARD: CTEs, window functions, subconsultas correlacionadas — NUNCA SELECTs sin JOIN.
- PROGRAMACIÓN: MÍNIMO 4 "fill_in_blank" para completar código, 2 "ordering" para algoritmos. HARD: algoritmos avanzados (recursión, grafos, programación dinámica), análisis de complejidad. NUNCA sintaxis básica.
- IDIOMAS: MÍNIMO 4 "fill_in_blank". HARD: gramática avanzada (subjuntivo, condicionales mixtos), traducción técnica. NUNCA vocabulario básico.
- CIENCIAS: MÍNIMO 3 "fill_in_blank" con problemas multi-fórmula. HARD: 3+ ecuaciones encadenadas. NUNCA cálculos de un solo paso.
- HISTORIA, SOCIALES: 2-3 "ordering" para causalidad compleja, resto "multiple_choice" para análisis crítico.
- OTROS DOMINIOS: MÍNIMO 3 "fill_in_blank", 1-2 "ordering". HARD: Lleva el tema a su expresión práctica más compleja y profesional.

REGLAS DE CALIDAD:
- Los ejercicios fill_in_blank deben tener UNA sola respuesta correcta clara y verificable.
- Para ordering, provee entre 4 y 6 items con secuencias no triviales.
- NO varíes la dificultad internamente en un set HARD — mantén la complejidad máxima en TODOS los ejercicios.
- Contextualiza: en HARD usa escenarios del mundo profesional, no de aula básica.

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
                let correctAnswer = String(q.correctAnswer ?? q.correct_answer ?? '').trim();
                if (!correctAnswer) return null;

                // Normalize numeric answers: strip thousand separators, limit decimals
                const numericClean = correctAnswer.replace(/,/g, '').replace(/\s/g, '');
                const numericVal = Number(numericClean);
                if (Number.isFinite(numericVal) && /^-?\d/.test(numericClean)) {
                    // Strip thousand separators from correct answer (always store as plain digits)
                    correctAnswer = numericClean;
                    // Limit to max 2 decimal places
                    if (correctAnswer.includes('.')) {
                        const parts = correctAnswer.split('.');
                        if (parts[1] && parts[1].length > 2) {
                            correctAnswer = String(Math.round(numericVal * 100) / 100);
                        }
                    }
                }

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

                // Anti-duplicate-options: reject if options are not all unique
                const uniqueOpts = new Set(options.map(o => o.toLowerCase().replace(/[^a-záéíóúñü0-9]/g, '').trim()));
                if (uniqueOpts.size < options.length) {
                    console.warn(`[ReinforcementService] Duplicate options detected in: "${q.question.substring(0, 60)}..." — rejecting question`);
                    return null;
                }

                // Anti-duplicate numeric options: for numeric-looking options, compare values
                const numericOpts = options.map(o => {
                    const cleaned = o.replace(/[^0-9.\-]/g, '');
                    const n = Number(cleaned);
                    return cleaned && Number.isFinite(n) ? n : null;
                });
                if (numericOpts.every(n => n !== null)) {
                    const uniqueNums = new Set(numericOpts);
                    if (uniqueNums.size < numericOpts.length) {
                        console.warn(`[ReinforcementService] Duplicate numeric option values in: "${q.question.substring(0, 60)}..." — rejecting question`);
                        return null;
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

    // ═══════════════════════════════════════════════════════════════════════════
    // MATH VERIFICATION — Programmatic answer validation
    // LLMs are notoriously unreliable at multi-digit arithmetic.
    // These methods recompute the answer using JavaScript and fix errors.
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Verifies and fixes math in a generated question by recomputing the answer
     * programmatically. Returns the corrected question, or null to reject it.
     * @private
     */
    _verifyMathAnswer(q) {
        if (!q) return q;
        const text = q.question;
        const lower = (text || '').toLowerCase();

        // Only verify questions that involve numeric computation
        const mathSignals = /calcula|suma|total|multiplica|divide|resta|resultado|costo\s+total|precio\s+total|monto\s+total|redondea|¿cuánto|cuántos|cuántas|promedio|media|porcentaje/i;
        const hasSignificantNumbers = /\d{3,}/.test(text.replace(/,/g, ''));
        if (!mathSignals.test(lower) && !hasSignificantNumbers) return q;

        try {
            const result = this._computeExpectedAnswer(text);
            if (result === null) return q; // Can't reliably compute — pass through

            const requestedDecimals = this._extractRequestedDecimals(text);
            let finalAnswer = result.value;
            if (requestedDecimals !== null) {
                finalAnswer = parseFloat(finalAnswer.toFixed(requestedDecimals));
            } else if (!Number.isInteger(finalAnswer)) {
                finalAnswer = parseFloat(finalAnswer.toFixed(2));
            }

            if (q.type === 'fill_in_blank') {
                const currentAnswer = parseFloat(String(q.correctAnswer).replace(/,/g, ''));
                if (!Number.isFinite(currentAnswer)) return q;

                const tolerance = Math.max(Math.abs(finalAnswer) * 0.001, 0.01);
                if (Math.abs(currentAnswer - finalAnswer) > tolerance) {
                    console.warn(`🔧 [MathVerify] CORRECTED fill_in_blank: "${text.substring(0, 100)}..." LLM="${q.correctAnswer}" → Correct="${finalAnswer}"`);
                    q.correctAnswer = String(finalAnswer);
                    q.explanation = `${result.steps.join('. ')}. Resultado final: ${finalAnswer}.`;
                }
            } else if (q.type === 'multiple_choice') {
                // Parse numeric value from each option
                const optionValues = q.options.map(opt => {
                    const nums = opt.match(/[\d,]+\.?\d*/g);
                    if (!nums) return NaN;
                    const parsed = nums.map(n => parseFloat(n.replace(/,/g, ''))).filter(Number.isFinite);
                    return parsed.length > 0 ? parsed.reduce((a, b) => Math.abs(a) > Math.abs(b) ? a : b) : NaN;
                });

                let closestIdx = -1;
                let closestDiff = Infinity;
                for (let i = 0; i < optionValues.length; i++) {
                    if (!Number.isFinite(optionValues[i])) continue;
                    const diff = Math.abs(optionValues[i] - finalAnswer);
                    if (diff < closestDiff) {
                        closestDiff = diff;
                        closestIdx = i;
                    }
                }

                const tolerance = Math.max(Math.abs(finalAnswer) * 0.001, 0.01);
                if (closestIdx >= 0 && closestDiff <= tolerance) {
                    if (closestIdx !== q.correctIndex) {
                        console.warn(`🔧 [MathVerify] CORRECTED multiple_choice: "${text.substring(0, 100)}..." correctIndex ${q.correctIndex}→${closestIdx} (computed=${finalAnswer})`);
                        q.correctIndex = closestIdx;
                        q.explanation = `${result.steps.join('. ')}. Resultado final: ${finalAnswer}.`;
                    }
                } else {
                    // No option matches the computed answer — reject the question
                    console.warn(`🔧 [MathVerify] REJECTED multiple_choice: "${text.substring(0, 100)}..." No option ≈ computed=${finalAnswer} (opts: ${optionValues.join(', ')})`);
                    return null;
                }
            }
        } catch (err) {
            // Non-blocking: if verification fails, let the question through unchanged
            console.warn(`[MathVerify] Error (non-blocking): ${err.message}`);
        }
        return q;
    }

    /**
     * Attempt to compute the expected math answer from question text.
     * Returns { value: number, steps: string[] } or null.
     * @private
     */
    _computeExpectedAnswer(text) {
        // Strategy 1: Explicit inline arithmetic (e.g. "12,345 + 9,876 + ...")
        const explicit = this._tryExplicitArithmetic(text);
        if (explicit !== null) return explicit;

        // Strategy 2: Word problem — sum data numbers, apply rate/percentage
        const wordProblem = this._tryWordProblem(text);
        if (wordProblem !== null) return wordProblem;

        // Strategy 3: Fallback — extract all numbers and try sum + percentage
        const sumFallback = this._trySumFallback(text);
        if (sumFallback !== null) return sumFallback;

        return null;
    }

    /**
     * Parse and evaluate explicit arithmetic: "12,345,678.45 + 9,876,543.21 + ..."
     * Supports +, -, ×, *, ÷, /
     * @private
     */
    _tryExplicitArithmetic(text) {
        // Strip currency symbols so "$45,230 + $78,945" matches as arithmetic
        const cleaned = text.replace(/[$€¥£₡₿]\s*/g, '');
        // Match chains: number op number [op number...] where op ∈ {+, -, ×, *, ÷, /}
        const numberPat = '\\d[\\d,]*\\.?\\d*';
        const opPat = '[+\\-×*÷/]';
        const exprRegex = new RegExp(
            `(${numberPat})\\s*(${opPat})\\s*(${numberPat}(?:\\s*${opPat}\\s*${numberPat})*)`, 'g'
        );
        const match = exprRegex.exec(cleaned);
        if (!match) return null;

        const expr = match[0];
        const tokens = expr.split(/\s*([+\-×*÷/])\s*/).filter(t => t.trim());

        let result = parseFloat(tokens[0].replace(/,/g, ''));
        if (!Number.isFinite(result)) return null;

        const steps = [];
        for (let i = 1; i < tokens.length; i += 2) {
            const op = tokens[i];
            const num = parseFloat((tokens[i + 1] || '').replace(/,/g, ''));
            if (!Number.isFinite(num)) return null;

            const prev = result;
            switch (op) {
                case '+': result += num; break;
                case '-': result -= num; break;
                case '×': case '*': result *= num; break;
                case '÷': case '/': if (num === 0) return null; result /= num; break;
                default: return null;
            }
            steps.push(`${prev} ${op} ${num} = ${result}`);
        }

        // Check for follow-up operation in the remaining text
        const afterExpr = cleaned.substring(cleaned.indexOf(match[0]) + match[0].length);
        const followUp = this._detectFollowUpOperation(afterExpr);
        if (followUp) {
            const prev = result;
            result = followUp.apply(result);
            steps.push(followUp.describe(prev, result));
        }

        return { value: result, steps };
    }

    /**
     * Parse word problems: extract data numbers, detect operations (sum, multiply).
     * Handles "calcula el total de X, Y, Z. Luego multiplica por W" patterns.
     * @private
     */
    _tryWordProblem(text) {
        const lower = text.toLowerCase();

        // Must look like a sum/total problem
        if (!/total|suma|calcula|acumulad|promedio|media|¿cuánto|cuántos|monto|resultado/i.test(lower)) return null;

        // Extract "data" numbers — numbers associated with labels (Nodo A: 12345, Sucursal: 9876, etc.)
        const dataNumbers = [];
        // Pattern 1: labeled numbers — "Label: $12,345,678.45"
        // Note: use [a-zA-Z...] instead of \w to avoid matching digits in the label
        const labeledPattern = /(?:[a-zA-ZáéíóúñÁÉÍÓÚÑ][a-zA-ZáéíóúñÁÉÍÓÚÑ\s]*[:=]\s*\$?)([\d,]+\.?\d*)/gi;
        let m;
        while ((m = labeledPattern.exec(text)) !== null) {
            const num = parseFloat(m[1].replace(/,/g, ''));
            if (Number.isFinite(num) && num >= 10) dataNumbers.push(num);
        }

        // Pattern 1b: currency amounts — "$45,230", "$78,945.50"
        if (dataNumbers.length < 2) {
            dataNumbers.length = 0;
            const currencyPat = /\$\s?([\d,]+\.?\d*)/gi;
            while ((m = currencyPat.exec(text)) !== null) {
                const num = parseFloat(m[1].replace(/,/g, ''));
                if (Number.isFinite(num) && num >= 1) dataNumbers.push(num);
            }
        }

        // Pattern 1c: "de" amounts — "ventas de 45,230", "valor de 78,945"
        if (dataNumbers.length < 2) {
            dataNumbers.length = 0;
            const dePat = /(?:de|por|con|=)\s*\$?\s*([\d,]+\.?\d*)/gi;
            while ((m = dePat.exec(text)) !== null) {
                const num = parseFloat(m[1].replace(/,/g, ''));
                if (Number.isFinite(num) && num >= 10) dataNumbers.push(num);
            }
        }

        // Pattern 2: if not enough, extract all significant numbers (≥10)
        if (dataNumbers.length < 2) {
            dataNumbers.length = 0;
            // Strip currency for clean extraction
            const stripped = text.replace(/[$€¥£₡₿]\s*/g, '');
            const allNums = stripped.match(/\d[\d,]*\.?\d*/g) || [];
            // Collect percentages to exclude from data
            const pctSet = new Set();
            const pctRe = /([\d,.]+)\s*%/g;
            let pm;
            while ((pm = pctRe.exec(text)) !== null) {
                pctSet.add(parseFloat(pm[1].replace(/,/g, '')));
            }
            for (const raw of allNums) {
                const num = parseFloat(raw.replace(/,/g, ''));
                if (!Number.isFinite(num) || num < 10) continue;
                if (pctSet.has(num)) continue;                         // skip percentages
                if (num >= 1900 && num <= 2100 && Number.isInteger(num)) continue; // skip years
                dataNumbers.push(num);
            }
        }

        if (dataNumbers.length < 2) return null;

        // Detect the primary aggregation
        let result;
        const steps = [];

        if (/promedio|media\b/i.test(lower)) {
            const sum = dataNumbers.reduce((a, b) => a + b, 0);
            result = sum / dataNumbers.length;
            steps.push(`Suma: ${dataNumbers.join(' + ')} = ${sum}`);
            steps.push(`Promedio: ${sum} / ${dataNumbers.length} = ${result}`);
        } else {
            // Default: sum
            result = dataNumbers.reduce((a, b) => a + b, 0);
            steps.push(`Suma: ${dataNumbers.join(' + ')} = ${result}`);
        }

        // Look for a rate/cost multiplier
        const ratePatterns = [
            /costo\s+(?:de\s+(?:procesamiento|producción|envío|operación|mantenimiento))?\s*(?:de|es|por|=)?\s*\$?([\d,.]+)/i,
            /precio\s+(?:de|por|unitario|cada)?\s*\$?([\d,.]+)/i,
            /cada\s+\w+\s+(?:tiene\s+)?(?:un\s+)?(?:costo|precio|valor)\s+(?:de\s*)?\$?([\d,.]+)/i,
            /(?:multiplic[aá]r?|×)\s*(?:por)?\s*\$?([\d,.]+)/i,
            /(?:tasa|tarifa|factor|coeficiente)\s+(?:de\s+)?(?:[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+\s+)*(?:del?\s+)?\$?([\d,.]+)(?!\s*%)/i,
            /(?:se\s+)?aplic[aá]\s+(?:un\s+)?(?:[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+\s+)*(?:del?\s+)?\$?([\d,.]+)(?!\s*%)/i,
            /\$\s*([\d,.]+)\s*(?:por|\/)\s*(?:cada|unidad|GB|kg|litro|km|hora)/i,
        ];
        for (const re of ratePatterns) {
            const rm = text.match(re);
            if (rm) {
                const rate = parseFloat(rm[1].replace(/,/g, ''));
                if (Number.isFinite(rate) && rate > 0 && rate < result) {
                    const prev = result;
                    result = result * rate;
                    steps.push(`Costo/Multiplicación: ${prev} × ${rate} = ${result}`);
                    break;
                }
            }
        }

        // Look for percentage (impuesto, descuento, incremento)
        const pctMatch = text.match(/(?:impuesto|descuento|incremento|aumento|IVA|ISR|interés)\s+(?:del?)?\s*([\d,.]+)\s*%/i);
        if (pctMatch) {
            const pct = parseFloat(pctMatch[1].replace(/,/g, ''));
            if (Number.isFinite(pct) && pct > 0 && pct <= 200) {
                const prev = result;
                if (/descuento/i.test(pctMatch[0])) {
                    result = result * (1 - pct / 100);
                    steps.push(`Descuento ${pct}%: ${prev} × ${1 - pct / 100} = ${result}`);
                } else {
                    result = result * (1 + pct / 100);
                    steps.push(`+ ${pct}%: ${prev} × ${1 + pct / 100} = ${result}`);
                }
            }
        }

        // Look for post-operation addition (e.g. "se agrega un tráfico de respaldo de 5,000,000.500")
        const addMatch = text.match(/(?:se\s+)?(?:agrega[rn]?|añad[aeir]+|suma[rn]?|adiciona[rn]?|incorpora[rn]?)\s+(?:\S+\s+){0,8}?([\d,]+\.?\d*)/i);
        if (addMatch) {
            const addVal = parseFloat(addMatch[1].replace(/,/g, ''));
            if (Number.isFinite(addVal) && addVal > 0 && !dataNumbers.includes(addVal)) {
                const prev = result;
                result += addVal;
                steps.push(`Adición: ${prev} + ${addVal} = ${result}`);
            }
        }

        // Only return if we performed at least a sum
        if (steps.length === 0) return null;
        return { value: result, steps };
    }

    /**
     * Detect a follow-up operation in text after an explicit expression.
     * e.g., "... multiply by 0.0375" or "aplica impuesto del 16%"
     * @private
     */
    _detectFollowUpOperation(text) {
        if (!text) return null;

        // Multiplication: "multiply by X", "× X", "costo de $X"
        const multPatterns = [
            /(?:multiplic[aá]r?\s+por|×)\s*\$?([\d,.]+)/i,
            /(?:costo|precio|tarifa|tasa)\s+(?:de\s+(?:\w+\s+)*)?(?:de\s*)?\$?([\d,.]+)/i,
            /cada\s+\w+\s+.*?\$?([\d,.]+)/i,
        ];
        for (const re of multPatterns) {
            const m = text.match(re);
            if (m) {
                const factor = parseFloat(m[1].replace(/,/g, ''));
                if (Number.isFinite(factor) && factor > 0) {
                    return {
                        apply: (v) => v * factor,
                        describe: (prev, result) => `Multiplicación: ${prev} × ${factor} = ${result}`,
                    };
                }
            }
        }

        // Percentage
        const pctMatch = text.match(/(?:impuesto|descuento|incremento|aumento|IVA)\s+(?:del?)?\s*([\d,.]+)\s*%/i);
        if (pctMatch) {
            const pct = parseFloat(pctMatch[1].replace(/,/g, ''));
            if (Number.isFinite(pct) && pct > 0) {
                const isDiscount = /descuento/i.test(pctMatch[0]);
                const factor = isDiscount ? (1 - pct / 100) : (1 + pct / 100);
                return {
                    apply: (v) => v * factor,
                    describe: (prev, result) => `${isDiscount ? 'Descuento' : 'Incremento'} ${pct}%: ${prev} × ${factor} = ${result}`,
                };
            }
        }

        return null;
    }

    /**
     * Extract the requested number of decimal places from the question text.
     * e.g., "redondea a 2 decimales" → 2
     * @private
     */
    _extractRequestedDecimals(text) {
        const match = text.match(/redonde[ao].*?(\d+)\s*decimal/i);
        if (match) return parseInt(match[1]);
        // Also detect "a X cifras decimales"
        const match2 = text.match(/(\d+)\s*(?:cifras?\s+)?decimal/i);
        if (match2) return parseInt(match2[1]);
        return null;
    }

    /**
     * Fallback strategy: extract ALL significant numbers from the text,
     * compute their sum, and optionally apply a percentage found in the text.
     * More aggressive than _tryWordProblem — used as a last-resort catch-all.
     * @private
     */
    _trySumFallback(text) {
        const lower = text.toLowerCase();
        // Only apply when the question clearly asks for a numeric result
        if (!/(?:total|suma|calcula|resultado|¿cuánto|cuántos|monto|costo|precio|valor)/i.test(lower)) return null;

        // Strip currency symbols for clean extraction
        const cleaned = text.replace(/[$€¥£₡₿]\s*/g, '');

        // Collect percentage values to exclude from data numbers
        const pctValues = new Set();
        const pctRe = /([\d,.]+)\s*%/g;
        let pm;
        while ((pm = pctRe.exec(text)) !== null) {
            pctValues.add(parseFloat(pm[1].replace(/,/g, '')));
        }

        // Extract all numbers
        const numRe = /\d[\d,]*\.?\d*/g;
        let nm;
        const candidates = [];
        while ((nm = numRe.exec(cleaned)) !== null) {
            const val = parseFloat(nm[0].replace(/,/g, ''));
            if (!Number.isFinite(val)) continue;
            if (pctValues.has(val)) continue;                                    // skip percentages
            if (val <= 5) continue;                                              // skip tiny counts
            if (val >= 1900 && val <= 2100 && Number.isInteger(val)) continue;   // skip years
            candidates.push(val);
        }

        if (candidates.length < 2) return null;

        // Separate data numbers from metadata by magnitude clustering
        const sorted = [...candidates].sort((a, b) => a - b);
        const largest = sorted[sorted.length - 1];
        const dataNumbers = sorted.filter(n => n >= largest * 0.001 && n >= 10);
        if (dataNumbers.length < 2) return null;

        let result;
        const steps = [];

        if (/promedio|media\b/i.test(lower)) {
            const sum = dataNumbers.reduce((a, b) => a + b, 0);
            result = sum / dataNumbers.length;
            steps.push(`Suma: ${dataNumbers.join(' + ')} = ${sum}`);
            steps.push(`Promedio: ${sum} / ${dataNumbers.length} = ${result}`);
        } else {
            result = dataNumbers.reduce((a, b) => a + b, 0);
            steps.push(`Suma: ${dataNumbers.join(' + ')} = ${result}`);
        }

        // Apply percentage if present
        if (pctValues.size > 0) {
            const pct = [...pctValues][0];
            if (Number.isFinite(pct) && pct > 0 && pct <= 200) {
                const prev = result;
                if (/descuento/i.test(lower)) {
                    result *= (1 - pct / 100);
                    steps.push(`Descuento ${pct}%: ${prev} × ${(1 - pct / 100)} = ${result}`);
                } else if (/impuesto|iva|incremento|aumento|interés|recargo/i.test(lower)) {
                    result *= (1 + pct / 100);
                    steps.push(`+ ${pct}%: ${prev} × ${(1 + pct / 100)} = ${result}`);
                }
            }
        }

        // Look for a rate/cost multiplier
        const ratePatterns = [
            /(?:multiplic[aá]r?|×)\s*(?:por)?\s*\$?([\d,.]+)/i,
            /(?:costo|precio|tarifa|tasa|factor|coeficiente)\s+(?:de\s+)?(?:[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+\s+)*(?:del?\s+)?\$?([\d,.]+)(?!\s*%)/i,
            /(?:se\s+)?aplic[aá]\s+(?:un\s+)?(?:[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+\s+)*(?:del?\s+)?\$?([\d,.]+)(?!\s*%)/i,
        ];
        for (const re of ratePatterns) {
            const rm = text.match(re);
            if (rm) {
                const rate = parseFloat(rm[1].replace(/,/g, ''));
                if (Number.isFinite(rate) && rate > 0 && rate < result) {
                    const prev = result;
                    result *= rate;
                    steps.push(`Multiplicación: ${prev} × ${rate} = ${result}`);
                    break;
                }
            }
        }

        // Look for post-operation addition
        const addMatchFb = text.match(/(?:se\s+)?(?:agrega[rn]?|añad[aeir]+|suma[rn]?|adiciona[rn]?|incorpora[rn]?)\s+(?:\S+\s+){0,8}?([\d,]+\.?\d*)/i);
        if (addMatchFb) {
            const addVal = parseFloat(addMatchFb[1].replace(/,/g, ''));
            if (Number.isFinite(addVal) && addVal > 0 && !candidates.includes(addVal)) {
                const prev = result;
                result += addVal;
                steps.push(`Adición: ${prev} + ${addVal} = ${result}`);
            }
        }

        if (steps.length === 0) return null;
        return { value: result, steps };
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
                    const normalized = parsed
                        .map(q => this._normalizeQuestion(q))
                        .filter(Boolean)
                        .map(q => this._verifyMathAnswer(q))
                        .filter(Boolean);
                    if (normalized.length > 0) return normalized;
                }
            } catch (_) { /* fall through to repair */ }
        }

        // Strategy 2: extract individual objects (handles truncated/malformed arrays)
        console.warn('[ReinforcementService] JSON parse failed, attempting object extraction repair...');
        const searchIn = start !== -1 ? content.substring(start) : content;
        const objects = this._extractObjectsFromBrokenArray(searchIn);
        if (objects.length > 0) {
            const normalized = objects
                .map(q => this._normalizeQuestion(q))
                .filter(Boolean)
                .map(q => this._verifyMathAnswer(q))
                .filter(Boolean);
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

    _isExerciseTrivialForHard(q, domain = 'GENERAL') {
        const text = (q.question || '').toLowerCase();
        const answer = String(q.correct_answer || q.correctAnswer || '').toLowerCase();
        const allText = text + ' ' + answer;

        // 0. Cross-domain contamination check — reject questions from the wrong domain
        if (domain === 'MATH') {
            // Programming/SQL signals are forbidden in a MATH topic
            const programmingSignals = [
                'select ', ' from ', ' where ', ' join ', 'function(', 'function (', '() {', '() =>',
                'algorithm', 'class ', 'new class', '= new ', 'api ', '\.push(', '\.pop(', '\.map(',
                'const ', 'let ', 'var ', 'def ', 'import ', 'console.log', 'system.out',
                'kahan', 'binary search', 'quicksort', 'mergesort', 'heapsort', 'bfs', 'dfs',
                'dijkstra', 'memoization', 'dynamic programming', 'programación dinámica',
                'recursion', 'recursive', 'recursivo', 'linked list', 'graph ', ' grafo',
                'hash map', 'hashmap', 'stack overflow', 'time complexity', 'space complexity',
                'big-o', 'o(n)', 'o(log', 'pseudocódigo', 'pseudocode', 'sintaxis de', 'punto flotante de doble'
            ];
            if (programmingSignals.some(s => text.includes(s))) {
                return true; // Reject: programming/SQL question in a MATH topic
            }
        }

        if (domain === 'SQL') {
            // Pure math/science questions are off-domain for SQL topics
            const mathOnlySignals = [/\b\d+\s*[+\-*\/]\s*\d+\s*=\s*___/, /calcula\s+la\s+(integral|derivada|sumatoria)/i];
            if (mathOnlySignals.some(r => r.test(text))) return true;
        }

        // 1. Simple arithmetic: reject if ALL numbers have < 5 digits in MATH domain
        if (domain === 'MATH' && /^\s*¿?(cuánto|calcula|resuelve|resultado)\b/.test(text)) {
            const numbers = text.match(/\d+/g) || [];
            if (numbers.length >= 2 && numbers.every(n => n.length < 5)) return true;
        } else if (/^\s*¿?(cuánto|calcula|resuelve|resultado)\b/.test(text)) {
            const numbers = text.match(/\d+/g) || [];
            if (numbers.length >= 2 && numbers.every(n => n.length < 5)) return true;
        }

        // 2. Very short fill_in_blank without code/math
        if (q.type === 'fill_in_blank') {
            const wordCount = text.split(/\s+/).length;
            if (wordCount < 12 && !/[=<>{}()\[\]|&;]/.test(text) && !/\d{5,}/.test(text)) return true;
        }

        // 3. Simple numeric answers (1-4 digits) without math/code context
        if (/^\d{1,4}$/.test(answer.trim()) && !/[∫∑σ√π]/.test(text) && !/\b(select|from|where|function|class|algorithm)\b/i.test(text)) {
            const numbers = text.match(/\d+/g) || [];
            if (numbers.every(n => n.length < 5)) return true;
        }

        // 4. SQL without JOINs, subqueries, window functions, CTEs, or HAVING
        if (/\b(select|sql|consulta|query)\b/i.test(allText)) {
            const hasComplexSQL = /\b(join|subquer|window|over\s*\(|partition\s+by|cte|with\s+\w+\s+as|having|union|intersect|except|lateral|cross\s+apply)\b/i.test(allText);
            if (!hasComplexSQL && /\bselect\b/i.test(allText)) return true;
        }

        // 5. Pure definition questions
        if (/^¿?(qué es|what is|define|definición de|concepto de)\b/i.test(text.trim())) return true;

        return false;
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

    _looksLikeBinaryOrOfficeXml(text) {
        if (!text || text.length < 50) return false;
        const sample = text.substring(0, 2000);
        if (sample.startsWith('PK\x03\x04') || sample.startsWith('PK')) return true;
        const officeXmlPatterns = [
            'schemas.openxmlformats.org', 'schemas.microsoft.com/office',
            '<w:document', '<w:body', '<w:r>', '<w:p>', '<w:t>',
            '<w:rPr>', '<w:pPr>', '<w:sz', '<w:rFonts',
            'word/document.xml', 'word/_rels', '[Content_Types].xml', 'docProps/core.xml',
        ];
        const matchCount = officeXmlPatterns.filter(p => sample.includes(p)).length;
        if (matchCount >= 2) return true;
        const controlChars = (sample.match(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/g) || []).length;
        if (controlChars > sample.length * 0.03) return true;
        const lines = sample.split('\n');
        const b64Lines = lines.filter(l => l.length > 100 && /^[A-Za-z0-9+/=]+$/.test(l.trim()));
        if (b64Lines.length > 3) return true;
        return false;
    }
}
export default ReinforcementDomainService;

