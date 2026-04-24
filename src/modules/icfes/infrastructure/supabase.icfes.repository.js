/**
 * SupabaseIcfesRepository — acceso a datos ICFES.
 *
 * Filosofía:
 * - Sólo queries. Sin reglas de negocio.
 * - Joins anidados en una sola llamada para minimizar round-trips
 *   (requisito del flujo del pipeline: "start" debe responder < 300ms).
 */
export class SupabaseIcfesRepository {
    constructor(client) {
        this.client = client;
    }

    // ─── Áreas ────────────────────────────────────────────────────────────
    async listAreas() {
        const { data, error } = await this.client
            .from('icfes_areas')
            .select('id, code, name')
            .order('id', { ascending: true });
        if (error) throw new Error(error.message);
        return data || [];
    }

    async findAreaByCode(code) {
        const { data, error } = await this.client
            .from('icfes_areas')
            .select('id, code, name')
            .eq('code', code)
            .maybeSingle();
        if (error) throw new Error(error.message);
        return data || null;
    }

    // ─── Selección adaptativa ─────────────────────────────────────────────
    /**
     * Devuelve hasta `limit` ids de preguntas que el estudiante NUNCA ha visto,
     * priorizando subtemas con mayor falencia_score. Si no hay falencia_score
     * (estudiante nuevo), devuelve por dificultad ascendente.
     */
    async pickCandidateQuestions(studentId, areaId, limit = 60) {
        // 1) subtemas del área
        const subs = await this._subtopicIdsByArea(areaId);
        if (!subs.length) return [];

        // 2) preguntas ya vistas (cross-session)
        const seenIds = await this._seenQuestionIds(studentId);

        // 3) pool de candidatos activos
        let q = this.client
            .from('icfes_questions')
            .select('id, subtopic_id, difficulty')
            .eq('is_active', true)
            .in('subtopic_id', subs);
        if (seenIds.length) {
            q = q.not('id', 'in', `(${seenIds.join(',')})`);
        }
        const { data: pool, error } = await q.limit(Math.max(limit * 4, 80));
        if (error) throw new Error(error.message);
        if (!pool?.length) return [];

        // 4) join con skill_metrics para priorizar falencias
        const falencia = await this._falenciaBySubtopic(studentId, subs);
        const ranked = pool
            .map(r => ({
                ...r,
                falencia: falencia.get(r.subtopic_id) ?? 0,
            }))
            .sort((a, b) => (b.falencia - a.falencia) || (a.difficulty - b.difficulty));

        return ranked.slice(0, limit);
    }

    async _subtopicIdsByArea(areaId) {
        const { data, error } = await this.client
            .from('icfes_subtopics')
            .select('id, icfes_topics!inner(area_id)')
            .eq('icfes_topics.area_id', areaId);
        if (error) throw new Error(error.message);
        return (data || []).map(r => r.id);
    }

    async _seenQuestionIds(studentId) {
        const { data, error } = await this.client
            .from('icfes_attempts')
            .select('question_id')
            .eq('student_id', studentId);
        if (error) return [];
        const s = new Set((data || []).map(r => r.question_id));
        return [...s];
    }

    async _falenciaBySubtopic(studentId, subtopicIds) {
        if (!subtopicIds.length) return new Map();
        const { data, error } = await this.client
            .from('icfes_skill_metrics')
            .select('subtopic_id, falencia_score')
            .eq('student_id', studentId)
            .in('subtopic_id', subtopicIds);
        const m = new Map();
        if (!error && data) for (const r of data) m.set(r.subtopic_id, Number(r.falencia_score) || 0);
        return m;
    }

    // ─── Hidratar las preguntas elegidas ──────────────────────────────────
    async getQuestionsFull(questionIds) {
        if (!questionIds.length) return [];
        const { data, error } = await this.client
            .from('icfes_questions')
            .select(`
                id, stem, difficulty, explanation, subtopic_id, source_year,
                icfes_subtopics:subtopic_id ( id, name, icfes_topics:topic_id ( id, name, area_id ) ),
                icfes_question_options ( id, label, content, is_correct ),
                icfes_question_images ( id, option_id, position, url, alt, order_index )
            `)
            .in('id', questionIds);
        if (error) throw new Error(error.message);
        return data || [];
    }

    // ─── Sesiones ────────────────────────────────────────────────────────
    async createSession({ studentId, areaId, expiresAt }) {
        const { data, error } = await this.client
            .from('icfes_exam_sessions')
            .insert({ student_id: studentId, area_id: areaId, expires_at: expiresAt })
            .select('*')
            .single();
        if (error) throw new Error(error.message);
        return data;
    }

    async bindSessionQuestions(sessionId, orderedQuestionIds) {
        if (!orderedQuestionIds.length) return;
        const rows = orderedQuestionIds.map((qid, i) => ({
            session_id: sessionId, question_id: qid, order_index: i + 1,
        }));
        const { error } = await this.client.from('icfes_session_questions').insert(rows);
        if (error) throw new Error(error.message);
    }

    async findSessionForStudent(sessionId, studentId) {
        const { data, error } = await this.client
            .from('icfes_exam_sessions')
            .select('id, student_id, area_id, status, expires_at')
            .eq('id', sessionId)
            .eq('student_id', studentId)
            .maybeSingle();
        if (error) throw new Error(error.message);
        return data || null;
    }

    async completeSession(sessionId, score) {
        const { error } = await this.client
            .from('icfes_exam_sessions')
            .update({ status: 'completed', finished_at: new Date().toISOString(), score })
            .eq('id', sessionId);
        if (error) throw new Error(error.message);
    }

    async recordAttempts(rows) {
        if (!rows.length) return;
        const { error } = await this.client.from('icfes_attempts').insert(rows);
        if (error) throw new Error(error.message);
    }

    async listSessionsByStudent(studentId, limit = 20) {
        const { data, error } = await this.client
            .from('icfes_exam_sessions')
            .select('id, area_id, status, score, started_at, finished_at, icfes_areas:area_id ( code, name )')
            .eq('student_id', studentId)
            .eq('status', 'completed')
            .order('finished_at', { ascending: false })
            .limit(limit);
        if (error) throw new Error(error.message);
        return data || [];
    }
}

export default SupabaseIcfesRepository;
