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

export class ReinforcementDomainService {
    constructor({ reinforcementRepository }) {
        this.reinforcementRepo = reinforcementRepository;
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
                        message: `${saveResult.savedCount} unique questions saved with embeddings`
                    });
                } else {
                    console.warn('[ReinforcementDomainService] MCPService save returned no unique questions (all duplicates?)');
                    return Result.ok({
                        success: true,
                        savedCount: 0,
                        message: 'All questions were duplicates or save failed'
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