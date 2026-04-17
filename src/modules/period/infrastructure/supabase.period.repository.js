export class SupabasePeriodRepository {
    constructor(client) {
        this.client = client;
    }

    static TABLE = 'grade_periods';

    _table() { return SupabasePeriodRepository.TABLE; }

    _map(row) {
        if (!row) return null;
        return {
            id: row.id,
            courseId: row.course_id,
            subjectId: row.subject_id,
            periodNumber: row.period_number,
            name: row.name,
            snapshot: row.snapshot,
            closedAt: row.closed_at,
            startsAt: row.starts_at || null,
            endsAt: row.ends_at || null,
            createdBy: row.created_by,
        };
    }

    async create({ courseId, subjectId, periodNumber, name, snapshot, createdBy, startsAt, endsAt }) {
        const row = {
            course_id: courseId,
            subject_id: subjectId,
            period_number: periodNumber,
            name,
            snapshot,
            created_by: createdBy,
        };
        if (startsAt) row.starts_at = startsAt;
        if (endsAt) row.ends_at = endsAt;
        const { data, error } = await this.client
            .from(this._table())
            .insert(row)
            .select()
            .single();
        if (error) throw error;
        return this._map(data);
    }

    async findBySubject(subjectId) {
        const { data, error } = await this.client
            .from(this._table())
            .select('*')
            .eq('subject_id', subjectId)
            .order('period_number', { ascending: true });
        if (error) throw error;
        return (data || []).map(r => this._map(r));
    }

    async findByCourse(courseId) {
        const { data, error } = await this.client
            .from(this._table())
            .select('*')
            .eq('course_id', courseId)
            .order('period_number', { ascending: true });
        if (error) throw error;
        return (data || []).map(r => this._map(r));
    }

    async findById(id) {
        const { data, error } = await this.client
            .from(this._table())
            .select('*')
            .eq('id', id)
            .single();
        if (error) throw error;
        return this._map(data);
    }

    async getMaxPeriodNumber(courseId, subjectId) {
        const { data, error } = await this.client
            .from(this._table())
            .select('period_number')
            .eq('course_id', courseId)
            .eq('subject_id', subjectId)
            .order('period_number', { ascending: false })
            .limit(1);
        if (error) throw error;
        return data?.length ? data[0].period_number : 0;
    }

    async updateSnapshot(id, snapshot) {
        const { data, error } = await this.client
            .from(this._table())
            .update({ snapshot })
            .eq('id', id)
            .select()
            .single();
        if (error) throw error;
        return this._map(data);
    }

    /** Finds the active (not-yet-closed) period for a subject: snapshot IS NULL */
    async findActiveBySubject(subjectId) {
        const { data, error } = await this.client
            .from(this._table())
            .select('*')
            .eq('subject_id', subjectId)
            .is('snapshot', null)
            .order('period_number', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) throw error;
        return data ? this._map(data) : null;
    }

    /** Closes an active period by filling its snapshot, ends_at and closed_at */
    async closeById(id, { snapshot, endsAt, name }) {
        const updates = {
            snapshot,
            closed_at: new Date().toISOString(),
        };
        if (endsAt) updates.ends_at = endsAt;
        if (name) updates.name = name;
        const { data, error } = await this.client
            .from(this._table())
            .update(updates)
            .eq('id', id)
            .select()
            .single();
        if (error) throw error;
        return this._map(data);
    }

    async delete(id) {
        const { error } = await this.client
            .from(this._table())
            .delete()
            .eq('id', id);
        if (error) throw error;
    }
}
