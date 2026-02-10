/**
 * Submission — Entrega de tarea de un estudiante.
 */
export class Submission {
    constructor({ id = null, taskId, userId, username = null, fileUri = null, fileName = null, textContent = null, grade = null, feedback = null, status = 'pending', submittedAt = null, gradedAt = null, createdAt = null, updatedAt = null } = {}) {
        Object.assign(this, { id, taskId, userId, username, fileUri, fileName, textContent, grade, feedback, status, submittedAt, gradedAt, createdAt, updatedAt });
    }
    static fromSupabaseRow(row) {
        return new Submission({
            id: row.id,
            taskId: row.task_id || row.taskId,
            userId: row.user_id || row.userId,
            username: row.username || null,
            fileUri: row.file_uri || row.fileUri || null,
            fileName: row.file_name || row.fileName || null,
            textContent: row.text_content || row.textContent || null,
            grade: row.grade ? ? null,
            feedback: row.feedback || null,
            status: row.status || 'pending',
            submittedAt: row.submitted_at || row.submittedAt || null,
            gradedAt: row.graded_at || row.gradedAt || null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        });
    }
}
export default Submission;