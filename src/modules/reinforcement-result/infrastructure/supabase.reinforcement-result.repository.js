export class SupabaseReinforcementResultRepository {
    constructor(client) {
        this.client = client;
    }

    async save({ userId, courseId, topicId, taskId, totalQuestions, correctAnswers, incorrectAnswers, grade, difficulty, durationSeconds }) {
        const { data, error } = await this.client
            .from('reinforcement_results')
            .insert({
                user_id: userId,
                course_id: courseId,
                topic_id: topicId || null,
                task_id: taskId || null,
                total_questions: totalQuestions,
                correct_answers: correctAnswers,
                incorrect_answers: incorrectAnswers,
                grade,
                difficulty: difficulty || 'HARD',
                duration_seconds: durationSeconds || 0,
            })
            .select()
            .single();
        if (error) throw new Error(`Error saving reinforcement result: ${error.message}`);
        return data;
    }

    async findByUser(userId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client
            .from('reinforcement_results')
            .select('*, courses!course_id(title, thumbnail_uri), usuarios!user_id(username, avatar)')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(`Error fetching results: ${error.message}`);
        return data || [];
    }

    async findByCourse(courseId, { offset = 0, limit = 100 } = {}) {
        const { data, error } = await this.client
            .from('reinforcement_results')
            .select('*, usuarios(id, username, avatar)')
            .eq('course_id', courseId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(`Error fetching course results: ${error.message}`);
        return data || [];
    }

    async findByUserAndCourse(userId, courseId) {
        const { data, error } = await this.client
            .from('reinforcement_results')
            .select('*')
            .eq('user_id', userId)
            .eq('course_id', courseId)
            .order('created_at', { ascending: false });
        if (error) throw new Error(`Error fetching user-course results: ${error.message}`);
        return data || [];
    }

    async findAllWithUsers({ offset = 0, limit = 100 } = {}) {
        const { data, error } = await this.client
            .from('reinforcement_results')
            .select('*, usuarios(id, username, avatar), courses(id, title)')
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(`Error fetching all results: ${error.message}`);
        return data || [];
    }
}

export default SupabaseReinforcementResultRepository;
