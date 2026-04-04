export class SupabaseCollaboratorRepository {
    constructor(client) { this.client = client; }

    async findByCourse(courseId) {
        const { data, error } = await this.client
            .from('collaborators')
            .select('*, usuarios(id, username, email, avatar)')
            .eq('course_id', courseId)
            .order('created_at', { ascending: true });
        if (error) throw new Error(error.message);
        return (data || []).map(this._mapToDomain);
    }

    async findByUser(userId) {
        const { data, error } = await this.client
            .from('collaborators')
            .select('*, courses(id, title)')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findUserIdsByCourse(courseId) {
        const { data, error } = await this.client
            .from('collaborators')
            .select('user_id')
            .eq('course_id', courseId);
        if (error) return [];
        return (data || []).map(r => r.user_id);
    }

    async isCollaborator(userId, courseId) {
        const { count, error } = await this.client
            .from('collaborators')
            .select('id', { count: 'exact', head: true })
            .eq('course_id', courseId)
            .eq('user_id', userId);
        return !error && count > 0;
    }

    async add(courseId, userId) {
        const { data, error } = await this.client
            .from('collaborators')
            .upsert({ course_id: courseId, user_id: userId }, { onConflict: 'course_id,user_id' })
            .select('*, usuarios(id, username, email, avatar)')
            .single();
        if (error) throw new Error(error.message);
        return this._mapToDomain(data);
    }

    async remove(courseId, userId) {
        const { error } = await this.client
            .from('collaborators')
            .delete()
            .eq('course_id', courseId)
            .eq('user_id', userId);
        if (error) throw new Error(error.message);
        return true;
    }

    async setByCourse(courseId, userIds) {
        await this.client.from('collaborators').delete().eq('course_id', courseId);
        if (!userIds || userIds.length === 0) return [];
        const rows = userIds.map(uid => ({ course_id: courseId, user_id: uid }));
        const { data, error } = await this.client
            .from('collaborators')
            .insert(rows)
            .select('*, usuarios(id, username, email, avatar)');
        if (error) throw new Error(error.message);
        return (data || []).map(this._mapToDomain);
    }

    _mapToDomain(row) {
        if (!row) return null;
        return {
            id: row.id,
            courseId: row.course_id,
            userId: row.user_id,
            createdAt: row.created_at,
            user: row.usuarios ? {
                id: row.usuarios.id,
                username: row.usuarios.username,
                email: row.usuarios.email,
                avatar: row.usuarios.avatar,
            } : null,
        };
    }
}
export default SupabaseCollaboratorRepository;
