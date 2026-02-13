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

export class ReinforcementDomainService {
    constructor({ reinforcementRepository }) {
        this.reinforcementRepo = reinforcementRepository;
    }

    /**
     * Ensure content for a task/topic is ingested into RAG (rag_documents).
     * If missing, fetches from content_items and ingests.
     */
    async ensureContentIngested(courseId, taskId, topicId = null) {
        try {
            const ragService = new RAGService();
            const supabase = SupabaseService.getInstance();
            
            // 1. Check if RAG documents exist for this task
            const ragExists = await ragService.vectorStore.exists({
                taskId: taskId,
                courseId: courseId,
                ...(topicId ? { topicId } : {})
            });

            if (ragExists) {
                return Result.ok({ message: 'RAG content already exists', ingested: false });
            }

            console.log(`📝 [ReinforcementService] No RAG docs for Task ${taskId}. Fetching content_items...`);

            // 2. Fetch source content from content_items
            // We select items linked to this task
            const { data: items, error } = await supabase.client
                .from('content_items')
                .select('*')
                .eq('task_id', taskId);

            if (error) throw error;

            if (!items || items.length === 0) {
                return Result.ok({ message: 'No content_items found for this task', ingested: false });
            }

            let ingestedCount = 0;

            // 3. Ingest each item
            for (const item of items) {
                if (item.body && item.body.length > 50) {
                    console.log(`💾 Ingesting content_item ${item.id} into RAG...`);
                    
                    // Use item.topic_id as fallback if not passed
                    const effectiveTopicId = topicId || item.topic_id;

                    await ragService.ingestDocument(item.body, {
                        courseId: courseId,
                        taskId: taskId,
                        topicId: effectiveTopicId,
                        contentItemId: item.id,
                        fileName: item.title || `content_${item.id}`,
                        fileType: 'txt' // Assuming text body
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

                if (saveResult && saveResult.success) {
                    return Result.ok({
                        success: true,
                        savedCount: saveResult.savedCount,
                        duplicateCount: (parsedQuestions.length - saveResult.savedCount),
                        totalSubmitted: parsedQuestions.length,
                        message: `${saveResult.savedCount} unique questions saved with embeddings`
                    });
                } else {
                    console.warn('[ReinforcementDomainService] MCPService save returned no unique questions (all duplicates?)');
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
                        success: true,
                        savedCount: 0,
                        duplicateCount: parsedQuestions.length,
                        totalSubmitted: parsedQuestions.length,
                        allDuplicates: true,
                        existingQuestions,
                        message: 'All questions were duplicates — client should regenerate with different content'
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