/**
 * ReinforcementDomainService — Manages reinforcement question sessions/history.
 * 
 * Uses MCPService for full persistence with:
 *   - SHA-256 hash deduplication
 *   - Embedding generation for semantic uniqueness
 *   - question_sessions + questions_history + question_options tables
 */
import { Result } from '../../shared/Result.js';
import { MCPService } from './MCPService.js';
import { RAGService } from './RAGService.js';
import { SupabaseService } from '../../infrastructure/database/SupabaseService.js';
import { R2StorageAdapter } from '../../infrastructure/storage/R2StorageAdapter.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch (_) { pdfParse = null; }

export class ReinforcementDomainService {
    constructor({ reinforcementRepository }) {
        this.reinforcementRepo = reinforcementRepository;
        this.REQUIRED_QUESTION_COUNT = 10;
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

                if (saveResult && isComplete) {
                    return Result.ok({
                        success: true,
                        savedCount,
                        cumulativeCount,
                        duplicateCount: (parsedQuestions.length - savedCount),
                        totalSubmitted: parsedQuestions.length,
                        requiredCount,
                        message: `Lote completo: ${cumulativeCount} preguntas únicas acumuladas`
                    });
                } else {
                    console.warn(`[ReinforcementDomainService] Partial save: ${savedCount} this batch, ${cumulativeCount}/${requiredCount} cumulative.`);
                    // Fetch existing questions so client can use them for regeneration
                    let existingQuestions = [];
                    try {
                        const existing = await mcpService.getReinforcementHistory(userId, courseId, topicId, taskId);
                        existingQuestions = (existing || []).map(h => ({
                            question: h.question || '',
                            options: h.options || [],
                            correctIndex: h.answer_index ?? 0,
                            explanation: h.explanation || '',
                        }));
                    } catch (_) { /* non-blocking */ }

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
                        existingQuestions,
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
                return Result.ok({ questions: [], count: 0 });
            }

            // Return structured question objects for client-side dedup
            const questions = history.map(h => ({
                question: h.question || '',
                options: h.options || [],
                correctIndex: h.answer_index ?? 0,
                explanation: h.explanation || '',
            }));

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

