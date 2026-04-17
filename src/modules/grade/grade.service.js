import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

const BASE_GRADE_TYPES = ['comportamiento', 'participacion', 'examenes'];

function isValidGradeType(type) {
    if (BASE_GRADE_TYPES.includes(type)) return true;
    const match = type.match(/^(comportamiento|participacion|examenes)_(\d+)$/);
    return match !== null && Number(match[2]) >= 2;
}

export class GradeDomainService {
    constructor({ gradeRepository, subjectRepository, courseRepository, collaboratorRepository, progressService, taskRepository, submissionRepository, progressRepository, userRepository, periodRepository }) {
        this.gradeRepo = gradeRepository;
        this.subjectRepo = subjectRepository;
        this.courseRepo = courseRepository;
        this.taskRepo = taskRepository || null;
        this.submissionRepo = submissionRepository || null;
        this.progressRepo = progressRepository || null;
        this.collaboratorRepo = collaboratorRepository;
        this.progressService = progressService || null;
        this.userRepo = userRepository || null;
        this.periodRepo = periodRepository || null;
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
        if (!isValidGradeType(gradeType)) {
            return Result.fail(new Error(`Tipo de nota inválido: ${gradeType}. Válidos: ${BASE_GRADE_TYPES.join(', ')} (con sufijo _N para slots adicionales)`));
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
        if (!isValidGradeType(gradeType)) {
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
        if (!isValidGradeType(gradeType)) {
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

        // 1. Get all invited/enrolled students from BOTH sources
        const studentMap = new Map();

        // 1a. From pre_enrollments (invited students)
        if (this.progressRepo && typeof this.progressRepo.findApprovedPreEnrollments === 'function') {
            const enrollments = await this.progressRepo.findApprovedPreEnrollments(courseId);
            for (const e of (enrollments || [])) {
                const uid = Number(e.userId);
                if (uid > 0) studentMap.set(uid, { userId: uid, username: e.username || null, avatar: e.avatar || null });
            }
        }

        // 1b. From progreso_curso (students with direct enrollment / progress)
        if (this.progressRepo && typeof this.progressRepo.findByCourse === 'function') {
            const progressRows = await this.progressRepo.findByCourse(courseId);
            for (const p of (progressRows || [])) {
                const uid = Number(p.userId);
                if (uid > 0 && !studentMap.has(uid)) {
                    studentMap.set(uid, { userId: uid, username: null, avatar: null });
                }
            }
        }

        // 1c. Enrich with username/avatar/fullName/cedula from usuarios+personas table
        const allStudentIds = [...studentMap.keys()];
        if (allStudentIds.length > 0 && this.userRepo && typeof this.userRepo.findByIds === 'function') {
            const users = await this.userRepo.findByIds(allStudentIds);
            for (const u of (users || [])) {
                const uid = Number(u.id);
                const entry = studentMap.get(uid);
                if (entry) {
                    entry.username = entry.username || u.username || null;
                    entry.avatar = entry.avatar || u.avatar || null;
                    // Resolve fullName and cedula from persona
                    const persona = u.persona || u.personas || null;
                    if (persona) {
                        const nombres = (persona.nombres || '').trim();
                        const apellidos = (persona.apellidos || '').trim();
                        entry.fullName = [nombres, apellidos].filter(Boolean).join(' ') || null;
                        entry.cedula = persona.identificacion?.toString() || null;
                    } else {
                        entry.fullName = entry.fullName || null;
                        entry.cedula = entry.cedula || null;
                    }
                }
            }
        }

        const students = [...studentMap.values()];

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

        // 2b. Exclude tasks that were already captured in a closed period's snapshot.
        //     Only tasks created after the last period was closed belong to the current period.
        if (tasks.length > 0 && this.periodRepo && typeof this.periodRepo.findBySubject === 'function') {
            try {
                const periods = await this.periodRepo.findBySubject(subjectId);
                if (periods && periods.length > 0) {
                    const archivedTaskIds = new Set();
                    for (const period of periods) {
                        const snapshotTasks = period.snapshot?.tasks ?? [];
                        for (const t of snapshotTasks) {
                            if (t && t.id != null) archivedTaskIds.add(Number(t.id));
                        }
                    }
                    if (archivedTaskIds.size > 0) {
                        tasks = tasks.filter(t => !archivedTaskIds.has(Number(t.id)));
                    }
                }
            } catch (_) { /* If period lookup fails, continue without filtering */ }
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

        // Fill in grade=0 for enrolled students who haven't submitted each task.
        // This ensures exports show 0 instead of blank/null for non-submitters.
        if (students.length > 0 && tasks.length > 0) {
            const submittedPairs = new Set(taskGrades.map(tg => `${tg.studentId}:${tg.taskId}`));
            for (const student of students) {
                for (const task of tasks) {
                    if (!submittedPairs.has(`${student.userId}:${task.id}`)) {
                        taskGrades.push({
                            taskId: task.id,
                            studentId: student.userId,
                            grade: 0,
                            feedback: null,
                            submissionId: null,
                            submittedAt: null,
                            gradedAt: null,
                        });
                    }
                }
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
