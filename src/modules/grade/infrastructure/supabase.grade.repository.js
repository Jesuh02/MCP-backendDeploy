const BASE_GRADE_TYPES = ['comportamiento', 'participacion', 'examenes'];

function isValidGradeType(type) {
    if (BASE_GRADE_TYPES.includes(type)) return true;
    const match = type.match(/^(comportamiento|participacion|examenes)_(\d+)$/);
    return match !== null && Number(match[2]) >= 2;
}

export class SupabaseGradeRepository {
    constructor(client) {
        this.client = client;
    }

    static TABLE = 'manual_grades';

    _table() { return SupabaseGradeRepository.TABLE; }

    _mapToDomain(row) {
        if (!row) return null;
        return {
            id: row.id,
            studentId: row.student_id,
            courseId: row.course_id,
            subjectId: row.subject_id,
            gradeType: row.grade_type,
            grade: row.grade,
            gradedBy: row.graded_by,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    async upsert({ studentId, courseId, subjectId, gradeType, grade, gradedBy }) {
        if (!isValidGradeType(gradeType)) {
            throw new Error(`Invalid grade type: ${gradeType}`);
        }
        if (grade < 0 || grade > 10) {
            throw new Error('Grade must be between 0 and 10');
        }

        const payload = {
            student_id: studentId,
            course_id: courseId,
            subject_id: subjectId,
            grade_type: gradeType,
            grade,
            graded_by: gradedBy,
            updated_at: new Date().toISOString(),
        };

        // Check if already exists
        const { data: existing } = await this.client
            .from(this._table())
            .select('id')
            .eq('student_id', studentId)
            .eq('course_id', courseId)
            .eq('subject_id', subjectId)
            .eq('grade_type', gradeType)
            .maybeSingle();

        let data, error;
        if (existing?.id) {
            ({ data, error } = await this.client
                .from(this._table())
                .update(payload)
                .eq('id', existing.id)
                .select()
                .single());
        } else {
            ({ data, error } = await this.client
                .from(this._table())
                .insert(payload)
                .select()
                .single());
        }
        if (error) throw new Error(error.message);
        return this._mapToDomain(data);
    }

    async bulkUpsert(entries) {
        const results = [];
        for (const entry of entries) {
            const result = await this.upsert(entry);
            results.push(result);
        }
        return results;
    }

    async findByStudentAndSubject(studentId, subjectId) {
        const { data, error } = await this.client
            .from(this._table())
            .select('*')
            .eq('student_id', studentId)
            .eq('subject_id', subjectId)
            .order('grade_type');
        if (error) throw new Error(error.message);
        return (data || []).map(r => this._mapToDomain(r));
    }

    async findByStudentAndCourse(studentId, courseId) {
        const { data, error } = await this.client
            .from(this._table())
            .select('*')
            .eq('student_id', studentId)
            .eq('course_id', courseId)
            .order('grade_type');
        if (error) throw new Error(error.message);
        return (data || []).map(r => this._mapToDomain(r));
    }

    async findBySubject(subjectId) {
        const { data, error } = await this.client
            .from(this._table())
            .select('*')
            .eq('subject_id', subjectId)
            .order('student_id');
        if (error) throw new Error(error.message);
        return (data || []).map(r => this._mapToDomain(r));
    }

    async findByCourseAndType(courseId, gradeType) {
        let query = this.client
            .from(this._table())
            .select('*')
            .eq('course_id', courseId);
        if (gradeType) query = query.eq('grade_type', gradeType);
        const { data, error } = await query.order('student_id');
        if (error) throw new Error(error.message);
        return (data || []).map(r => this._mapToDomain(r));
    }

    async findBySubjectAndType(subjectId, gradeType) {
        let query = this.client
            .from(this._table())
            .select('*')
            .eq('subject_id', subjectId);
        if (gradeType) query = query.eq('grade_type', gradeType);
        const { data, error } = await query.order('student_id');
        if (error) throw new Error(error.message);
        return (data || []).map(r => this._mapToDomain(r));
    }

    async deleteGrade(id) {
        const { error } = await this.client
            .from(this._table())
            .delete()
            .eq('id', id);
        if (error) throw new Error(error.message);
    }

    async deleteBySubject(subjectId) {
        const { error } = await this.client
            .from(this._table())
            .delete()
            .eq('subject_id', subjectId);
        if (error) throw new Error(error.message);
    }

    async getAveragesByStudentAndSubject(studentId, subjectId) {
        const grades = await this.findByStudentAndSubject(studentId, subjectId);
        return this._computeAveragesByType(grades);
    }

    async getAveragesByStudentAndCourse(studentId, courseId) {
        const grades = await this.findByStudentAndCourse(studentId, courseId);
        // Group by subject, then compute
        const bySubject = new Map();
        for (const g of grades) {
            if (!bySubject.has(g.subjectId)) bySubject.set(g.subjectId, []);
            bySubject.get(g.subjectId).push(g);
        }
        const result = {};
        for (const [subjId, subjGrades] of bySubject) {
            result[subjId] = this._computeAveragesByType(subjGrades);
        }
        return result;
    }

    _computeAveragesByType(grades) {
        const byType = {};
        for (const g of grades) {
            byType[g.gradeType] = g.grade;
        }
        return {
            comportamiento: byType.comportamiento ?? 0,
            participacion: byType.participacion ?? 0,
            examenes: byType.examenes ?? 0,
        };
    }
}

export default SupabaseGradeRepository;
