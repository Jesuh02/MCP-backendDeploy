/**
 * ReinforcementDomainService — Manages reinforcement question sessions/history.
 */
import { Result } from '../../shared/Result.js';

export class ReinforcementDomainService {
    constructor({ reinforcementRepository }) {
        this.reinforcementRepo = reinforcementRepository;
    }

    async saveSession(data) {
        const session = await this.reinforcementRepo.upsertHistory(
            data.userId, data.courseId, data.questions
        );
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