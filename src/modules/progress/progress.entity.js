/**
 * StudentProgress — Progreso de estudiante en un curso.
 */
export class StudentProgress {
    constructor({ id = null, userId, courseId, completedTasks = 0, totalTasks = 0, averageGrade = 0, progressPercentage = 0, enrolledAt = null, lastActivityAt = null, createdAt = null, updatedAt = null } = {}) {
        Object.assign(this, { id, userId, courseId, completedTasks, totalTasks, averageGrade, progressPercentage, enrolledAt, lastActivityAt, createdAt, updatedAt });
    }
    static fromSupabaseRow(row) {
        return new StudentProgress({
            id: row.id,
            userId: row.user_id || row.userId,
            courseId: row.course_id || row.courseId,
            completedTasks: row.completed_tasks || 0,
            totalTasks: row.total_tasks || 0,
            averageGrade: row.average_grade || row.avg_grade || 0,
            progressPercentage: row.progress_percentage || row.progreso || 0,
            enrolledAt: row.enrolled_at || null,
            lastActivityAt: row.last_activity_at || null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    }
}
export default StudentProgress;

