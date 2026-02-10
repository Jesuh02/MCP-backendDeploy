/**
 * SupabaseReinforcementRepository — Manages question_sessions, questions_history, question_options.
 */
export class SupabaseReinforcementRepository {
    constructor(client) {
        this.client = client;
    }

    async saveSession(sessionData) {
        const payload = {
            user_id: sessionData.userId,
            course_id: sessionData.courseId,
            topic_id: sessionData.topicId || null,
            task_id: sessionData.taskId || null,
            total_questions: sessionData.totalQuestions || 0,
            correct_answers: sessionData.correctAnswers || 0,
            score: sessionData.score || 0,
        };
        const { data, error } = await this.client.from('question_sessions').insert(payload).select().single();
        if (error) throw new Error(`Error saving session: ${error.message}`);
        return data;
    }

    async saveQuestions(sessionId, questions) {
        if (!questions || questions.length === 0) return [];
        const payloads = questions.map((q, idx) => ({
            session_id: sessionId,
            question_text: q.questionText || q.question || '',
            correct_answer: q.correctAnswer || '',
            user_answer: q.userAnswer || '',
            is_correct: q.isCorrect || false,
            difficulty: q.difficulty || 'medium',
            order_index: idx,
        }));
        const { data, error } = await this.client.from('questions_history').insert(payloads).select();
        if (error) throw new Error(`Error saving questions: ${error.message}`);
        return data || [];
    }
    async saveOptions(questionId, options) {
        if (!options || options.length === 0) return [];
        const payloads = options.map((o, idx) => ({
            question_id: questionId,
            option_text: o.text || o.optionText || o,
            is_correct: o.isCorrect || false,
            order_index: idx,
        }));
        const { data, error } = await this.client.from('question_options').insert(payloads).select();
        if (error) throw new Error(`Error saving options: ${error.message}`);
        return data || [];
    }
    async upsertHistory(userId, courseId, questionsJson) {
        // Save a complete session with questions and options
        const questions = typeof questionsJson === 'string' ? JSON.parse(questionsJson) : questionsJson;

        const session = await this.saveSession({
            userId,
            courseId,
            totalQuestions: questions.length,
            correctAnswers: questions.filter(q => q.isCorrect).length,
            score: questions.length > 0 ? Math.round((questions.filter(q => q.isCorrect).length / questions.length) * 100) : 0,
        });
        for (const q of questions) {
            const savedQ = await this.saveQuestions(session.id, [q]);
            if (savedQ[0] && q.options) {
                await this.saveOptions(savedQ[0].id, q.options);
            }
        }
        return session;
    }

    async findByUserAndCourse(userId, courseId, { offset = 0, limit = 20 } = {}) {
        const { data, error } = await this.client
            .from('question_sessions')
            .select('*, questions_history(*, question_options(*))')
            .eq('user_id', userId)
            .eq('course_id', courseId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            console.error('SupabaseReinforcementRepository.findByUserAndCourse error:', error);
            return [];
        }
        return data || [];
    }

    async findByUser(userId, { offset = 0, limit = 20 } = {}) {
        const { data, error } = await this.client
            .from('question_sessions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            console.error('SupabaseReinforcementRepository.findByUser error:', error);
            return [];
        }
        return data || [];
    }
}
export default SupabaseReinforcementRepository;