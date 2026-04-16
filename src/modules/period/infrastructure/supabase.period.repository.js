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
            createdBy: row.created_by,
        };
    }

    async create({ courseId, subjectId, periodNumber, name, snapshot, createdBy }) {
        const { data, error } = await this.client
            .from(this._table())
            .insert({
                course_id: courseId,
                subject_id: subjectId,
                period_number: periodNumber,
                name,
                snapshot,
                created_by: createdBy,
            })
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

    async delete(id) {
        const { error } = await this.client
            .from(this._table())
            .delete()
            .eq('id', id);
        if (error) throw error;
    }
}
