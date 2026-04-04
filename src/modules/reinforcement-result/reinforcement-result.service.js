import { Result } from '../../shared/Result.js';

export class ReinforcementResultService {
    constructor({ reinforcementResultRepository }) {
        this.repo = reinforcementResultRepository;
    }

    async saveResult(data) {
        const { totalQuestions, correctAnswers } = data;
        const grade = totalQuestions > 0
            ? parseFloat(((correctAnswers / totalQuestions) * 10).toFixed(2))
            : 0;

        const result = await this.repo.save({
            ...data,
            incorrectAnswers: totalQuestions - correctAnswers,
            grade,
        });
        return Result.ok(result);
    }

    async getByUser(userId, pagination) {
        const results = await this.repo.findByUser(userId, pagination);
        return Result.ok(results);
    }

    async getByCourse(courseId, pagination) {
        const results = await this.repo.findByCourse(courseId, pagination);
        return Result.ok(results);
    }

    async getByUserAndCourse(userId, courseId) {
        const results = await this.repo.findByUserAndCourse(userId, courseId);
        return Result.ok(results);
    }

    async getAll(pagination) {
        const results = await this.repo.findAllWithUsers(pagination);
        return Result.ok(results);
    }
}

export default ReinforcementResultService;
