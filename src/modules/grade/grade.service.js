import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

const VALID_GRADE_TYPES = ['comportamiento', 'participacion', 'examenes'];

export class GradeDomainService {
    constructor({ gradeRepository, subjectRepository, courseRepository, collaboratorRepository, progressService, taskRepository, submissionRepository, progressRepository }) {
        this.gradeRepo = gradeRepository;
        this.subjectRepo = subjectRepository;
        this.courseRepo = courseRepository;
        this.taskRepo = taskRepository || null;
        this.submissionRepo = submissionRepository || null;
        this.progressRepo = progressRepository || null;
        this.collaboratorRepo = collaboratorRepository;
        this.progressService = progressService || null;
    }

    async _canGradeSubject(userId, subjectId) {
        const subject = await this.subjectRepo.findById(subjectId);
        if (!subject) return false;

        const course = await this.courseRepo.findById(subject.course_id);
        if (!course) return false;

        // Course creator
        if (Number(course.creator_user_id) === Number(userId)) return true;

        // Subject creator
        if (subject.created_by && Number(subject.created_by) === Number(userId)) return true;

        // Subject-level collaborator
        if (this.subjectRepo.isSubjectCollaborator) {
            const isSubjectCollab = await this.subjectRepo.isSubjectCollaborator(userId, subjectId);
            if (isSubjectCollab) return true;
        }

        // Course-level collaborator
        if (this.collaboratorRepo) {
            const isCollab = await this.collaboratorRepo.isCollaborator(userId, subject.course_id);
            if (isCollab) return true;
        }

        return false;
    }

    async setGrade(gradedBy, { studentId, courseId, subjectId, gradeType, grade }) {
        if (!VALID_GRADE_TYPES.includes(gradeType)) {
            return Result.fail(new Error(`Tipo de nota inválido: ${gradeType}. Válidos: ${VALID_GRADE_TYPES.join(', ')}`));
        }
        if (grade < 0 || grade > 10) {
            return Result.fail(new Error('La nota debe estar entre 0 y 10'));
        }

        const canGrade = await this._canGradeSubject(gradedBy, subjectId);
        if (!canGrade) {
            return Result.fail(new ForbiddenError('No tienes permiso para calificar en esta materia'));
        }

        const result = await this.gradeRepo.upsert({
            studentId: Number(studentId),
            courseId: Number(courseId),
            subjectId: Number(subjectId),
            gradeType,
            grade: Number(grade),
            gradedBy: Number(gradedBy),
        });

        // Trigger progress recalculation
        if (this.progressService) {
            try {
                await this.progressService.refreshForUserCourse(Number(studentId), Number(courseId));
            } catch (_) { /* non-critical */ }
        }

        return Result.ok(result);
    }

    async bulkSetGrades(gradedBy, { courseId, subjectId, gradeType, entries }) {
        if (!VALID_GRADE_TYPES.includes(gradeType)) {
            return Result.fail(new Error(`Tipo de nota inválido: ${gradeType}`));
        }

        const canGrade = await this._canGradeSubject(gradedBy, subjectId);
        if (!canGrade) {
            return Result.fail(new ForbiddenError('No tienes permiso para calificar en esta materia'));
        }

        const results = [];
        const studentIds = new Set();

        for (const entry of entries) {
            const grade = Number(entry.grade);
            if (grade < 0 || grade > 10) continue;

            const result = await this.gradeRepo.upsert({
                studentId: Number(entry.studentId),
                courseId: Number(courseId),
                subjectId: Number(subjectId),
                gradeType,
                grade,
                gradedBy: Number(gradedBy),
            });
            results.push(result);
            studentIds.add(Number(entry.studentId));
        }

        // Trigger progress recalculation for all affected students
        if (this.progressService) {
            const refreshPromises = [...studentIds].map(sid =>
                this.progressService.refreshForUserCourse(sid, Number(courseId)).catch(() => {})
            );
            await Promise.allSettled(refreshPromises);
        }

        return Result.ok(results);
    }

    async setGradeForAll(gradedBy, { courseId, subjectId, gradeType, grade, studentIds }) {
        if (!VALID_GRADE_TYPES.includes(gradeType)) {
            return Result.fail(new Error(`Tipo de nota inválido: ${gradeType}`));
        }
        if (grade < 0 || grade > 10) {
            return Result.fail(new Error('La nota debe estar entre 0 y 10'));
        }

        const canGrade = await this._canGradeSubject(gradedBy, subjectId);
        if (!canGrade) {
            return Result.fail(new ForbiddenError('No tienes permiso para calificar en esta materia'));
        }

        const entries = studentIds.map(sid => ({
            studentId: Number(sid),
            grade: Number(grade),
        }));

        return this.bulkSetGrades(gradedBy, { courseId, subjectId, gradeType, entries });
    }

    async getGradesBySubject(requesterId, subjectId) {
        const canGrade = await this._canGradeSubject(requesterId, subjectId);
        if (!canGrade) {
            return Result.fail(new ForbiddenError('No tienes permiso para ver notas de esta materia'));
        }

        const grades = await this.gradeRepo.findBySubject(subjectId);
        return Result.ok(grades);
    }

    async getGradesBySubjectAndType(requesterId, subjectId, gradeType) {
        const canGrade = await this._canGradeSubject(requesterId, subjectId);
        if (!canGrade) {
            return Result.fail(new ForbiddenError('No tienes permiso para ver notas de esta materia'));
        }

        const grades = await this.gradeRepo.findBySubjectAndType(subjectId, gradeType);
        return Result.ok(grades);
    }

    async getStudentGrades(studentId, subjectId) {
        const grades = await this.gradeRepo.findByStudentAndSubject(studentId, subjectId);
        return Result.ok(grades);
    }

    async getStudentCourseGrades(studentId, courseId) {
        const grades = await this.gradeRepo.findByStudentAndCourse(studentId, courseId);
        return Result.ok(grades);
    }

    async getGradeAverages(studentId, subjectId) {
        const averages = await this.gradeRepo.getAveragesByStudentAndSubject(studentId, subjectId);
        return Result.ok(averages);
    }

    /**
     * Grade Sheet: returns an Excel-like structure with all students, their manual grades,
     * and all task submission grades for a given subject.
     * @param {number} requesterId
     * @param {number} subjectId
     * @returns {Promise<Result>} { students, tasks, manualGrades, taskGrades }
     */
    async getGradeSheet(requesterId, subjectId) {
        const canGrade = await this._canGradeSubject(requesterId, subjectId);
        if (!canGrade) {
            return Result.fail(new ForbiddenError('No tienes permiso para ver la planilla de esta materia'));
        }

        const subject = await this.subjectRepo.findById(subjectId);
        if (!subject) return Result.fail(new NotFoundError('Materia no encontrada'));

        const courseId = subject.course_id;

        // 1. Get all invited/enrolled students
        let students = [];
        if (this.progressRepo && typeof this.progressRepo.findApprovedPreEnrollments === 'function') {
            const enrollments = await this.progressRepo.findApprovedPreEnrollments(courseId);
            students = (enrollments || []).map(e => ({
                userId: e.userId,
                username: e.username || null,
                avatar: e.avatar || null,
                fullName: e.fullName || null,
                cedula: e.cedula || null,
            }));
        }

        // 2. Get all tasks for this subject
        let tasks = [];
        if (this.taskRepo && typeof this.taskRepo.findBySubject === 'function') {
            tasks = await this.taskRepo.findBySubject(subjectId);
            tasks = (tasks || []).map(t => ({
                id: t.id,
                title: t.title || t.name || '(Sin título)',
                topicId: t.topic_id || t.topicId,
            }));
        }

        // 3. Get all manual grades for this subject
        const manualGrades = await this.gradeRepo.findBySubject(subjectId);

        // 4. Get all task submission grades
        const taskGrades = [];
        if (this.submissionRepo && tasks.length > 0) {
            const taskIds = tasks.map(t => t.id);
            for (const taskId of taskIds) {
                try {
                    const subs = await this.submissionRepo.findByTask(taskId, { offset: 0, limit: 10000 });
                    for (const sub of (subs || [])) {
                        taskGrades.push({
                            taskId: sub.task_id || sub.taskId,
                            studentId: sub.student_id || sub.studentId,
                            grade: sub.grade ?? null,
                            feedback: sub.feedback || null,
                            submissionId: sub.id,
                            submittedAt: sub.created_at || sub.createdAt || null,
                            gradedAt: sub.graded_at || sub.gradedAt || null,
                        });
                    }
                } catch { /* skip */ }
            }
        }

        return Result.ok({
            subjectId: Number(subjectId),
            courseId: Number(courseId),
            students,
            tasks,
            manualGrades,
            taskGrades,
        });
    }
}

export default GradeDomainService;
