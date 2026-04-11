import { Result } from '../../shared/Result.js';
import { NotFoundError, ForbiddenError } from '../../shared/errors/index.js';

export class ProgressDomainService {
    constructor({ progressRepository, taskRepository, submissionRepository, courseRepository, userRepository, subjectRepository, collaboratorRepository }) {
        this.progressRepo = progressRepository;
        this.taskRepo = taskRepository || null;
        this.submissionRepo = submissionRepository || null;
        this.courseRepo = courseRepository || null;
        this.userRepo = userRepository || null;
        this.subjectRepo = subjectRepository || null;
        this.collaboratorRepo = collaboratorRepository || null;
        this._notificationService = null;
        this._courseRefreshJobs = new Map();
    }

    setNotificationService(notificationService) {
        this._notificationService = notificationService;
    }

    async getByUserAndCourse(userId, courseId) {
        const [storedProgressResult, gradedTasksResult, storedSubjectProgressResult] = await Promise.allSettled([
            this.progressRepo.findByUserAndCourse(userId, courseId),
            this._buildGradedTasksWithSubject(userId, courseId),
            this.progressRepo.findSubjectProgressByUserAndCourse(userId, courseId),
        ]);

        if (storedProgressResult.status === 'rejected') {
            console.error(`[ProgressService] Error loading stored progress for user ${userId} in course ${courseId}:`, storedProgressResult.reason?.message || storedProgressResult.reason);
        }
        if (gradedTasksResult.status === 'rejected') {
            console.error(`[ProgressService] Error loading graded tasks for user ${userId} in course ${courseId}:`, gradedTasksResult.reason?.message || gradedTasksResult.reason);
        }
        if (storedSubjectProgressResult.status === 'rejected') {
            console.error(`[ProgressService] Error loading subject progress for user ${userId} in course ${courseId}:`, storedSubjectProgressResult.reason?.message || storedSubjectProgressResult.reason);
        }

        let progress = storedProgressResult.status === 'fulfilled' ? storedProgressResult.value : null;
        let subjectProgress = storedSubjectProgressResult.status === 'fulfilled' ? storedSubjectProgressResult.value : [];
        const gradedTasks = gradedTasksResult.status === 'fulfilled' ? gradedTasksResult.value : [];

        if (!progress && this.taskRepo && this.submissionRepo) {
            try {
                progress = await this._recalculateAndUpsertUserCourseProgress(userId, courseId);
                const refreshedSubjectProgress = await this.progressRepo.findSubjectProgressByUserAndCourse(userId, courseId);
                subjectProgress = Array.isArray(refreshedSubjectProgress) ? refreshedSubjectProgress : [];
            } catch (error) {
                console.error(`[ProgressService] Error recalculating progress for user ${userId} in course ${courseId}:`, error?.message || error);
            }
        } else {
            progress = progress || this._buildEmptyCourseProgress(userId, courseId);
            if (progress && this.taskRepo && this.submissionRepo) {
                this._scheduleUserCourseRefresh(userId, courseId);
            }
        }

        progress = progress || this._buildEmptyCourseProgress(userId, courseId);
        return Result.ok({...progress, gradedTasks, subjectProgress });
    }

    async getSubjectProgress(userId, courseId) {
        let subjectProgress = await this.progressRepo.findSubjectProgressByUserAndCourse(userId, courseId);

        if ((!subjectProgress?.length) && this.taskRepo && this.submissionRepo && this.subjectRepo) {
            await this._recalculateAndUpsertUserCourseProgress(userId, courseId);
            subjectProgress = await this.progressRepo.findSubjectProgressByUserAndCourse(userId, courseId);
        } else if (subjectProgress?.length && this.taskRepo && this.submissionRepo && this.subjectRepo) {
            this._scheduleUserCourseRefresh(userId, courseId);
        }

        return Result.ok(subjectProgress || []);
    }

    async getByUserAndSubject(userId, subjectId) {
        let progress = await this.progressRepo.findByUserAndSubject(userId, subjectId);
        if (!progress && this.taskRepo && this.submissionRepo && this.subjectRepo) {
            const courseId = await this._resolveCourseFromSubjectId(subjectId);
            if (courseId) {
                await this._recalculateAndUpsertUserSubjectProgress(userId, courseId, subjectId);
                progress = await this.progressRepo.findByUserAndSubject(userId, subjectId);
            }
        }
        if (!progress) return Result.ok(this._buildEmptySubjectProgress(userId, subjectId));
        return Result.ok(progress);
    }

    async refreshForUserCourse(userId, courseId) {
        const refreshed = await this._recalculateAndUpsertUserCourseProgress(userId, courseId);
        return Result.ok(refreshed);
    }

    /**
     * Admin: devuelve el progreso por materia de TODOS los estudiantes
     * en los cursos gestionados por `requesterUserId`.
     * Admins globales (rol 3) pasan null para ver todo.
     */
    async getAllSubjectProgressForAdmin(requesterUserId = null) {
        const creatorId = requesterUserId ? Number(requesterUserId) : null;
        const items = await this.progressRepo.findAllSubjectProgressForAdmin(creatorId);
        return Result.ok(items);
    }

    async getByUser(userId, options = {}) {
        const progress = await this.progressRepo.findByUser(userId, options);
        return Result.ok(progress);
    }

    async getByCourse(courseId) {
        const progress = await this.progressRepo.findByCourse(courseId);
        return Result.ok(progress);
    }

    async getLeaderboard(courseId, limit = 10) {
        const board = await this.progressRepo.getLeaderboard(courseId, limit);
        return Result.ok(board);
    }

    async upsert(data) {
        if (data?.userId && data?.courseId && this.courseRepo) {
            const course = await this.courseRepo.findById(data.courseId);
            if (!course) {
                const resolved = await this._resolveCourseFromSubjectId(data.courseId);
                if (resolved) data.courseId = resolved;
                else return Result.fail(new NotFoundError('Curso', data.courseId));
            }
        }
        if (data?.userId && data?.courseId) {
            const blocked = await this._isCreatorOrCollaborator(data.userId, data.courseId);
            if (blocked) return Result.ok({ userId: data.userId, courseId: data.courseId, completedTasks: 0, totalTasks: 0, averageGrade: 0, progressPercentage: 0, status: 'Excluido' });
        }

        let progress = null;

        if (this.taskRepo && this.submissionRepo && data?.userId && data?.courseId) {
            progress = await this._recalculateAndUpsertUserCourseProgress(data.userId, data.courseId, null, data.subjectId);
        } else {
            progress = await this.progressRepo.upsert(data);
        }

        if (this._isProgressWon(progress) && !progress.certificateIssuedAt) {
            progress = await this.progressRepo.updateCertificate(data.userId, data.courseId, {
                certificateIssuedAt: new Date().toISOString(),
            });
        }

        return Result.ok(progress);
    }

    async getEnrolledCount(courseId) {
        // Contar desde pre_enrollments (status='approved') — misma fuente que getGuests()
        // para que el número sea consistente con la vista de edición del curso.
        const count = await this.progressRepo.countApprovedGuestsByCourse(courseId);
        return Result.ok({ count });
    }

    async isEnrolled(userId, courseId) {
        const enrolled = await this.progressRepo.isEnrolled(userId, courseId);
        if (enrolled) return Result.ok({ isEnrolled: true });

        // Also treat an approved pre_enrollment (guest invitation) as enrolled
        // so that invited users appear as inscribed in ExploreFragment / ExploreView
        try {
            const approvedCourseIds = await this.progressRepo.findApprovedEnrollmentCourseIds(userId);
            const isGuest = approvedCourseIds.includes(Number(courseId));
            if (isGuest) return Result.ok({ isEnrolled: true });
        } catch { /* ignore */ }

        return Result.ok({ isEnrolled: false });
    }

    async getEnrolledCourseIds(userId) {
        const ids = await this.progressRepo.findEnrolledCourseIds(userId);

        // Also include courses the user was invited to (approved pre_enrollment = guest access)
        try {
            const guestIds = await this.progressRepo.findApprovedEnrollmentCourseIds(userId);
            const merged = [...new Set([...ids, ...guestIds])];
            return Result.ok(merged);
        } catch { /* ignore, return what we have */ }

        return Result.ok(ids);
    }

    async getTopStudentsByCreator(creatorUserId, limit = 5) {
        const safeLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 5;
        const creatorId = Number(creatorUserId);
        if (!Number.isInteger(creatorId) || creatorId <= 0) {
            console.warn('[ProgressService] getTopStudentsByCreator: creatorUserId invÃ¡lido', creatorUserId);
            return Result.ok([]);
        }

        // â”€â”€ 1. Obtener IDs de cursos del creador (via CourseRepository) â”€â”€
        let courseIds = [];
        if (this.courseRepo && typeof this.courseRepo.findCourseIdsByCreatorUserId === 'function') {
            courseIds = await this.courseRepo.findCourseIdsByCreatorUserId(creatorId);
        } else if (this.courseRepo && typeof this.courseRepo.findByCreatorUserId === 'function') {
            const courses = await this.courseRepo.findByCreatorUserId(creatorId);
            courseIds = (courses || []).map(c => c.id);
        } else {
            console.error('[ProgressService] courseRepo no disponible; no se puede resolver top students por creador');
            return Result.ok([]);
        }

        if (courseIds.length === 0) {
            console.info(`[ProgressService] Creador ${creatorId} no tiene cursos registrados`);
            return Result.ok([]);
        }

        console.info(`[ProgressService] Creador ${creatorId} â†’ ${courseIds.length} cursos: [${courseIds.join(', ')}]`);

        // â”€â”€ 2. Obtener progreso 'Ganado' en esos cursos (via ProgressRepository) â”€â”€
        const wonProgress = await this.progressRepo.findWonProgressByCourseIds(courseIds);

        if (!wonProgress || wonProgress.length === 0) {
            console.info(`[ProgressService] Sin progreso 'Ganado' en cursos del creador ${creatorId}`);
            return Result.ok([]);
        }

        // â”€â”€ 3. Agregar mÃ©tricas por estudiante (excluir al propio creador) â”€â”€
        const aggregated = new Map();
        for (const row of wonProgress) {
            if (!Number.isInteger(row.userId) || row.userId <= 0) continue;
            if (row.userId === creatorId) continue; // No incluir al creador como su propio estudiante destacado

            const existing = aggregated.get(row.userId) || {
                user_id: row.userId,
                approved_courses: 0,
                total_grade: 0,
                graded_courses: 0,
                average_grade: 0,
                username: null,
                avatar: null,
            };

            existing.approved_courses += 1;
            if (Number.isFinite(row.grade)) {
                existing.total_grade += Number(row.grade) || 0;
                existing.graded_courses += 1;
            }
            aggregated.set(row.userId, existing);
        }

        // Calcular promedio
        for (const student of aggregated.values()) {
            if (student.graded_courses > 0) {
                student.average_grade = Number((student.total_grade / student.graded_courses).toFixed(2));
            }
        }

        // Ranking: mayor promedio â†’ mÃ¡s cursos aprobados â†’ menor ID
        const ranked = [...aggregated.values()]
            .filter(s => s.approved_courses > 0)
            .sort((a, b) => {
                if (b.average_grade !== a.average_grade) return b.average_grade - a.average_grade;
                if (b.approved_courses !== a.approved_courses) return b.approved_courses - a.approved_courses;
                return a.user_id - b.user_id;
            })
            .slice(0, safeLimit);

        // â”€â”€ 4. Enriquecer con perfil de usuario (via UserRepository) â”€â”€
        const studentIds = ranked.map(s => s.user_id);
        if (studentIds.length > 0 && this.userRepo && typeof this.userRepo.findByIds === 'function') {
            const usersData = await this.userRepo.findByIds(studentIds);
            const usersById = new Map((usersData || []).map(u => [Number(u.id), u]));

            for (const student of ranked) {
                const user = usersById.get(student.user_id);
                if (!user) continue;
                if (user.username) student.username = user.username;
                if (user.avatar) student.avatar = user.avatar;
            }
        }

        const result = ranked.map(s => ({
            user_id: s.user_id,
            username: s.username || `Usuario ${s.user_id}`,
            avatar: s.avatar || null,
            approved_courses: s.approved_courses,
            average_grade: s.average_grade,
        }));

        console.info(`[ProgressService] Top students para creador ${creatorId}: ${result.length} encontrados`);
        return Result.ok(result);
    }

    async getTopStudentsGlobal(limit = 5, creatorUserId = null) {
        return this.getTopStudentsByCreator(creatorUserId, limit);
    }

    /**
     * Devuelve el progreso de todos los estudiantes en los cursos donde
     * `userId` es creador O colaborador. Si se pasa `courseId`, filtra a ese curso.
     */
    async getStudentProgressForTeacher(userId, courseId = null) {
        // 1. Reunir IDs de cursos accesibles
        let courseIds = [];

        if (this.courseRepo && typeof this.courseRepo.findCourseIdsByCreatorUserId === 'function') {
            const ownIds = await this.courseRepo.findCourseIdsByCreatorUserId(userId);
            courseIds.push(...(ownIds || []).map(Number));
        }

        if (this.collaboratorRepo && typeof this.collaboratorRepo.findByUser === 'function') {
            const collabs = await this.collaboratorRepo.findByUser(userId);
            for (const c of (collabs || [])) {
                const cid = Number(c.courseId || c.course_id);
                if (cid && !courseIds.includes(cid)) courseIds.push(cid);
            }
        }

        if (courseIds.length === 0) return Result.ok([]);

        // 2. Filtrar por courseId específico si se pide
        if (courseId) {
            const numCourseId = Number(courseId);
            if (!courseIds.includes(numCourseId)) {
                return Result.fail(new ForbiddenError('No tienes acceso a ese curso'));
            }
            courseIds = [numCourseId];
        }

        // 3. Obtener progreso por curso y enriquecer con datos de usuario y curso
        const results = [];
        for (const cid of courseIds) {
            const progress = await this.progressRepo.findByCourse(cid);
            if (!progress?.length) continue;

            let courseName = `Curso ${cid}`;
            if (this.courseRepo) {
                try {
                    const course = await this.courseRepo.findById(cid);
                    if (course?.title) courseName = course.title;
                } catch (_) {}
            }

            if (this.userRepo && typeof this.userRepo.findByIds === 'function') {
                const userIds = [...new Set(progress.map(p => p.userId).filter(Boolean))];
                if (userIds.length > 0) {
                    try {
                        const users = await this.userRepo.findByIds(userIds);
                        const usersById = new Map((users || []).map(u => [Number(u.id), u]));
                        for (const p of progress) {
                            const user = usersById.get(Number(p.userId));
                            if (user) { p.username = user.username || null; p.avatar = user.avatar || null; }
                        }
                    } catch (_) {}
                }
            }

            results.push({
                courseId: cid,
                courseName,
                students: progress.map(p => ({
                    userId: p.userId,
                    username: p.username || `Usuario ${p.userId}`,
                    avatar: p.avatar || null,
                    completedTasks: p.completedTasks ?? 0,
                    totalTasks: p.totalTasks ?? 0,
                    averageGrade: p.averageGrade ?? 0,
                    progressPercentage: p.progressPercentage ?? 0,
                    status: p.status ?? 'Perdido',
                })),
            });
        }

        return Result.ok(results);
    }

    async getCreatorEnrollmentAnalytics(creatorUserId, options = {}) {
        const analytics = await this.progressRepo.getCreatorEnrollmentAnalytics(creatorUserId, options);
        return Result.ok(analytics);
    }

    async issueCertificate(userId, courseId) {
        try {
            const updated = await this.progressRepo.updateCertificate(userId, courseId, {
                certificateIssuedAt: new Date().toISOString(),
            });
            return Result.ok(updated);
        } catch (error) {
            const message = String(error?.message || error || '');
            if (message.includes('no tiene progreso registrado')) {
                return Result.fail(new NotFoundError('Progreso', `${userId}-${courseId}`));
            }
            if (message.includes('no ha ganado el curso') || message.includes('estado actual')) {
                return Result.fail(new ForbiddenError('Solo se pueden emitir certificados para progreso con estado Ganado'));
            }
            // Any other DB / constraint error â€” wrap instead of rethrowing to avoid 500
            return Result.fail(new ForbiddenError(`No se pudo emitir el certificado: ${message}`));
        }
    }

    async getMyCertificates(userId) {
        const certificates = await this.progressRepo.findCertificatesByUser(userId);
        if (!certificates?.length || !this.courseRepo) return Result.ok(certificates);

        // Only certificates with status 'Ganado' and not creator/collaborator
        const wonCerts = certificates.filter(cert => this._isProgressWon(cert));
        const blockedChecks = await Promise.all(
            wonCerts.map(cert => this._isCreatorOrCollaborator(userId, cert.courseId))
        );
        const filtered = wonCerts.filter((_, i) => !blockedChecks[i]);
        return Result.ok(filtered);
    }

    async getCreatorCertificates(creatorUserId) {
        const rows = await this.progressRepo.findWonProgressByCreatorCourses(creatorUserId);
        const filtered = (rows || []).filter(r => this._isProgressWon(r));
        return Result.ok(filtered);
    }

    async bulkIssueCertificatesForCreator(creatorUserId) {
        const rows = await this.progressRepo.findWonProgressByCreatorCourses(creatorUserId);
        const won = rows.filter(r => this._isProgressWon(r));
        // Include: certs not yet issued AND already-issued certs missing a stored URL (repair)
        // Uses certificateStoredUrl (raw DB value) so computed URLs don't mask missing storage_path
        const pending = won.filter(r => !r.certificateIssuedAt || !r.certificateStoredUrl);
        if (pending.length === 0) return Result.ok({ issued: 0 });
        const pairs = pending.map(r => ({
            userId: r.userId,
            courseId: r.courseId,
            certificateUrl: r.certificateStoredUrl || null,
            certificateIssuedAt: r.certificateIssuedAt || null,
        }));
        const issued = await this.progressRepo.bulkIssueCertificates(pairs);
        return Result.ok({ issued: issued.length });
    }

    async getAllWonCertificates() {
        const rows = await this.progressRepo.findAllWonProgress();
        const filtered = (rows || []).filter(r => this._isProgressWon(r));
        return Result.ok(filtered);
    }

    /**
     * Admin: repara registros con estado incorrecto en progreso_curso
     * (promedio >= 6 pero estado='Perdido', o viceversa) y emite certificados
     * para los que cambian a 'Ganado'.
     */
    async repairProgressStatuses() {
        if (typeof this.progressRepo.repairWrongProgressStatuses !== 'function') {
            return Result.fail(new Error('repairWrongProgressStatuses no disponible en el repositorio'));
        }

        // 1. Corregir estados incorrectos en la BD
        const repaired = await this.progressRepo.repairWrongProgressStatuses();

        // 2. Emitir certificados para los que ahora son 'Ganado' y aún no tienen certificado
        const nowWon = repaired.filter(r => r.newStatus === 'Ganado');
        let certificatesIssued = 0;
        for (const r of nowWon) {
            try {
                await this.progressRepo.updateCertificate(r.userId, r.courseId, {
                    certificateIssuedAt: new Date().toISOString(),
                });
                certificatesIssued++;
            } catch (certErr) {
                console.error(`[ProgressService] repairProgressStatuses: cert failed user=${r.userId} course=${r.courseId}:`, certErr?.message);
            }
        }

        return Result.ok({
            repaired: repaired.length,
            certificatesIssued,
            details: repaired,
        });
    }

    async bulkIssueCertificatesGlobal() {
        const rows = await this.progressRepo.findAllWonProgress();
        const won = rows.filter(r => this._isProgressWon(r));
        // Include: certs not yet issued AND already-issued certs missing a stored URL (repair)
        // Uses certificateStoredUrl (raw DB value) so computed URLs don't mask missing storage_path
        const pending = won.filter(r => !r.certificateIssuedAt || !r.certificateStoredUrl);
        if (pending.length === 0) return Result.ok({ issued: 0 });
        const pairs = pending.map(r => ({
            userId: r.userId,
            courseId: r.courseId,
            certificateUrl: r.certificateStoredUrl || null,
            certificateIssuedAt: r.certificateIssuedAt || null,
        }));
        const issued = await this.progressRepo.bulkIssueCertificates(pairs);
        return Result.ok({ issued: issued.length });
    }

    async updateCertificateUrl(userId, courseId, url) {
        // url puede ser una URL completa o un path relativo de Storage.
        // El repositorio almacena storage_path; la URL pÃºblica se construye en el cliente.
        const updated = await this.progressRepo.updateCertificate(userId, courseId, {
            certificateUrl: url,
        });
        return Result.ok(updated);
    }

    async getAllByCourse(courseId) {
        const progress = await this.progressRepo.findByCourse(courseId);
        // Enrich with usernames and avatars from user repository
        if (progress?.length && this.userRepo && typeof this.userRepo.findByIds === 'function') {
            const userIds = [...new Set(progress.map(p => p.userId).filter(id => id))];
            if (userIds.length > 0) {
                try {
                    const users = await this.userRepo.findByIds(userIds);
                    const usersById = new Map((users || []).map(u => [Number(u.id), u]));
                    for (const p of progress) {
                        const user = usersById.get(Number(p.userId));
                        if (user) {
                            p.username = user.username || null;
                            p.avatar = user.avatar || null;
                        }
                    }
                } catch (err) {
                    console.warn('[ProgressService] Error enriching getAllByCourse with usernames:', err.message);
                }
            }
        }
        return Result.ok(progress);
    }

    /**
     * Recalculate progress for all enrolled students in a course.
     * Fetches total tasks, completed submissions, and average grades,
     * then upserts each student's progress record.
     */
    async recalculateForCourse(courseId) {
        if (!this.taskRepo || !this.submissionRepo) {
            return Result.fail(new Error('Task/Submission repositories not available'));
        }

        const totalTasks = await this.taskRepo.countByCourse(courseId);

        const candidateUserIds = await this._resolveCandidateUserIdsForCourse(courseId);
        if (!candidateUserIds || candidateUserIds.length === 0) {
            return Result.ok({ recalculated: 0, totalTasks });
        }

        // Parallelize in batches of 5 to avoid overwhelming the DB
        const BATCH_SIZE = 5;
        let recalculated = 0;
        for (let i = 0; i < candidateUserIds.length; i += BATCH_SIZE) {
            const batch = candidateUserIds.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(userId => this._recalculateAndUpsertUserCourseProgress(userId, courseId, totalTasks))
            );
            for (const r of results) {
                if (r.status === 'fulfilled') recalculated++;
                else console.error(`[ProgressService] Error recalculating:`, r.reason?.message);
            }
        }

        return Result.ok({ recalculated, totalTasks });
    }

    async _resolveCandidateUserIdsForCourse(courseId) {
        const ids = new Set();

        const existingProgress = await this.progressRepo.findByCourse(courseId);
        for (const item of existingProgress || []) {
            const userId = Number(item?.userId);
            if (Number.isInteger(userId) && userId > 0) ids.add(userId);
        }

        if (typeof this.submissionRepo.getStudentIdsByCourse === 'function') {
            const fromSubmissions = await this.submissionRepo.getStudentIdsByCourse(courseId);
            for (const userId of fromSubmissions || []) {
                const parsed = Number(userId);
                if (Number.isInteger(parsed) && parsed > 0) ids.add(parsed);
            }
        }

        return [...ids];
    }

    async _buildGradedTasksWithSubject(userId, courseId) {
        if (!this.submissionRepo) return [];
        const graded = await this.submissionRepo.getGradedByUserAndCourse(userId, courseId);
        let subjectsById = new Map();
        if (this.subjectRepo && typeof this.subjectRepo.findByCourse === 'function') {
            try {
                const subjects = await this.subjectRepo.findByCourse(courseId, { activeOnly: false });
                subjectsById = new Map((subjects || []).map(s => [s.id, s]));
            } catch (error) {
                console.error(`[ProgressService] Error loading subjects for graded tasks in course ${courseId}:`, error?.message || error);
            }
        }
        return graded.map(sub => {
            const subjectId = sub.tasks?.topics?.materia_id || sub.tasks?.topics?.subject_id || null;
            const subject = subjectId ? subjectsById.get(subjectId) : null;
            return {
                taskId: sub.task_id,
                taskTitle: sub.tasks?.title || null,
                topicId: sub.tasks?.topic_id || null,
                topicName: sub.tasks?.topics?.name || null,
                subjectId,
                subjectName: subject?.name || null,
                grade: sub.grade,
            };
        });
    }

    _buildEmptyCourseProgress(userId, courseId, overrides = {}) {
        return {
            userId,
            courseId,
            completedTasks: 0,
            totalTasks: 0,
            progressPercentage: 0,
            averageGrade: 0,
            status: 'Perdido',
            ...overrides,
        };
    }

    _buildEmptySubjectProgress(userId, subjectId, overrides = {}) {
        return {
            userId,
            subjectId,
            completedTasks: 0,
            totalTasks: 0,
            progressPercentage: 0,
            averageGrade: 0,
            status: 'Perdido',
            ...overrides,
        };
    }

    _scheduleUserCourseRefresh(userId, courseId) {
        if (!this.taskRepo || !this.submissionRepo) return;

        const refreshKey = `${userId}:${courseId}`;
        if (this._courseRefreshJobs.has(refreshKey)) return;

        const refreshJob = (async() => {
            try {
                await this._recalculateAndUpsertUserCourseProgress(userId, courseId);
            } catch (err) {
                console.error(`[ProgressService] Error refreshing progress for user ${userId} in course ${courseId}:`, err?.message || err);
            } finally {
                this._courseRefreshJobs.delete(refreshKey);
            }
        })();

        this._courseRefreshJobs.set(refreshKey, refreshJob);
    }

    async _recalculateAndUpsertUserCourseProgress(userId, courseId, totalTasksFromCaller = null, subjectIdFallback = null) {
        // Skip recalculation for creators/collaborators â€” they are not students
        const blocked = await this._isCreatorOrCollaborator(userId, courseId);
        if (blocked) return { userId, courseId, completedTasks: 0, totalTasks: 0, averageGrade: 0, progressPercentage: 0, status: 'Excluido' };

        // Fetch totalTasks, submittedTaskIds and graded in parallel
        const [totalTasks, submittedTaskIds, graded] = await Promise.all([
            totalTasksFromCaller != null ? totalTasksFromCaller : this.taskRepo.countByCourse(courseId),
            this.submissionRepo.getTaskIdsByUserAndCourse(userId, courseId),
            this.submissionRepo.getGradedByUserAndCourse(userId, courseId),
        ]);
        const completedTasks = submittedTaskIds.length;

        const gradedSum = graded.reduce((sum, item) => sum + (Number(item.grade) || 0), 0);
        const averageGradeRaw = totalTasks > 0 ? (gradedSum / totalTasks) : 0;
        const averageGrade = Math.round(averageGradeRaw * 100) / 100;

        const progressPercentageRaw = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;
        const progressPercentage = Math.round(progressPercentageRaw * 100) / 100;

        const status = averageGrade >= 6 ? 'Ganado' : 'Perdido';

        const persisted = await this.progressRepo.upsert({
            userId,
            courseId,
            completedTasks,
            totalTasks,
            averageGrade,
            progressPercentage,
            subjectId: 0,
            status,
        });

        // Auto-issue certificate in `certificates` table when status reaches 'Ganado' (no DB trigger)
        if (this._isProgressWon(persisted) && !persisted?.certificateIssuedAt) {
            try {
                const withCert = await this.progressRepo.updateCertificate(userId, courseId, {
                    certificateIssuedAt: new Date().toISOString(),
                });
                await this._recalculateSubjectsForUserCourse(userId, courseId);
                return withCert || persisted;
            } catch (certErr) {
                console.error(`[ProgressService] Auto-cert failed for user=${userId} course=${courseId}:`, certErr?.message);
            }
        }

        await this._recalculateSubjectsForUserCourse(userId, courseId);

        return persisted || {
            userId,
            courseId,
            completedTasks,
            totalTasks,
            averageGrade,
            progressPercentage,
            status,
        };
    }

    async _recalculateSubjectsForUserCourse(userId, courseId) {
        if (!this.subjectRepo || !this.taskRepo || !this.submissionRepo) return;
        let subjects = [];
        try {
            subjects = await this.subjectRepo.findByCourse(courseId, { activeOnly: false });
        } catch (error) {
            console.error(`[ProgressService] Error loading subjects for course ${courseId} while recalculating progress:`, error?.message || error);
            return;
        }
        if (!subjects?.length) return;

        const results = await Promise.allSettled(
            subjects.map(subject => this._recalculateAndUpsertUserSubjectProgress(userId, courseId, subject.id))
        );
        for (const r of results) {
            if (r.status === 'rejected') {
                console.error(`[ProgressService] Error recalculating subject for user ${userId}:`, r.reason?.message);
            }
        }
    }

    async _recalculateAndUpsertUserSubjectProgress(userId, courseId, subjectId) {
        const totalTasks = await this.taskRepo.countBySubject(subjectId);
        if (totalTasks === 0) return null;

        const submittedTaskIds = await this.submissionRepo.getTaskIdsByUserAndSubject(userId, subjectId);
        const completedTasks = submittedTaskIds.length;

        const graded = await this.submissionRepo.getGradedByUserAndSubject(userId, subjectId);
        const gradedSum = graded.reduce((sum, item) => sum + (Number(item.grade) || 0), 0);
        const averageGradeRaw = totalTasks > 0 ? (gradedSum / totalTasks) : 0;
        const averageGrade = Math.round(averageGradeRaw * 100) / 100;

        const progressPercentageRaw = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;
        const progressPercentage = Math.round(progressPercentageRaw * 100) / 100;

        const status = averageGrade >= 6 ? 'Ganado' : 'Perdido';

        // Look up subject creator username for progreso_materia.created_by
        let createdBy = null;
        try {
            if (this.subjectRepo) {
                const subject = await this.subjectRepo.findById(subjectId);
                const creatorId = subject?.created_by ?? subject?.createdBy;
                if (creatorId && this.userRepo) {
                    const creator = await this.userRepo.findById(creatorId);
                    if (creator?.username) createdBy = creator.username;
                }
            }
        } catch (_) { /* non-critical */ }

        return this.progressRepo.upsert({
            userId,
            courseId,
            completedTasks,
            totalTasks,
            averageGrade,
            progressPercentage,
            subjectId,
            status,
            createdBy,
        });
    }

    async _resolveCourseFromSubjectId(subjectId) {
        if (!this.subjectRepo) return null;
        const subject = await this.subjectRepo.findById(subjectId);
        return subject?.course_id || null;
    }

    async _isCreatorOrCollaborator(userId, courseId) {
        if (!this.courseRepo) return false;
        const course = await this.courseRepo.findById(courseId);
        if (!course) return false;
        if (Number(course.creator_user_id) === Number(userId)) return true;
        if (!this.collaboratorRepo) return false;
        return this.collaboratorRepo.isCollaborator(Number(userId), courseId);
    }

    _isProgressWon(progress) {
        return String(progress?.status || '').trim().toLowerCase() === 'ganado';
    }

    _normalizeRoleIds(roles = []) {
        return [...new Set((roles || [])
            .map((role) => Number(role?.id??role))
            .filter((roleId) => Number.isInteger(roleId) && roleId > 0))];
    }

    async _getUserRoleIds(userId) {
        if (!userId || !this.userRepo || typeof this.userRepo.getUserRoles !== 'function') return [];
        try {
            const roles = await this.userRepo.getUserRoles(userId);
            return this._normalizeRoleIds(roles);
        } catch {
            return [];
        }
    }

    _isCourseAvailableForEnrollment(course) {
        const storedActive = course?.isActive??course?.is_active;
        const isActive = typeof storedActive === 'undefined' ?
            true :
            ['false', '0', 'no'].includes(String(storedActive).trim().toLowerCase()) ?
            false :
            Boolean(storedActive);
        if (!isActive) return false;
        if (!course?.deadline) return true;
        const deadline = new Date(course.deadline);
        return Number.isNaN(deadline.getTime()) || deadline > new Date();
    }

    // â”€â”€â”€ Enrollment request flow (Pre-enrollment / MatrÃ­cula) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Student requests enrollment in a course. Creates a pre_enrollment record
     * with status = 'pending'. Does NOT allow duplicate requests.
     */
    async requestEnrollment(userId, courseId, requestedRole = 'student') {
        if (!this.courseRepo) return Result.fail(new Error('CourseRepository not available'));

        const course = await this.courseRepo.findById(courseId);
        if (!course) return Result.fail(new NotFoundError('Curso', courseId));

        // Bloquear si el usuario tiene enrollment_status = 'inactivo' en progreso_curso
        const courseEnrollmentStatus = await this.progressRepo.findCourseEnrollmentStatus(userId, courseId);
        if (courseEnrollmentStatus !== null) {
            const normalized = String(courseEnrollmentStatus).trim().toLowerCase();
            if (normalized === 'inactivo') {
                return Result.fail(new ForbiddenError('Tu acceso a este curso fue desactivado por el administrador'));
            }
        }

        const roleIds = await this._getUserRoleIds(userId);
        if (roleIds.includes(3) || roleIds.includes(4)) {
            return Result.fail(new ForbiddenError('Los administradores no pueden matricularse en cursos'));
        }
        if (!roleIds.some((roleId) => roleId === 1 || roleId === 2)) {
            return Result.fail(new ForbiddenError('Solo los usuarios con rol 1 o rol 2 pueden solicitar matricula'));
        }

        // Only role 2 users can request enrollment as docente
        if (requestedRole === 'docente' && !roleIds.includes(2)) {
            return Result.fail(new ForbiddenError('Solo los usuarios con rol de docente pueden solicitar ingreso como docente'));
        }

        if (!this._isCourseAvailableForEnrollment(course)) {
            if (course.deadline && new Date(course.deadline) <= new Date() && typeof this.courseRepo.updateActiveState === 'function') {
                await this.courseRepo.updateActiveState(courseId, false).catch(() => {});
            }
            return Result.fail(new ForbiddenError('El curso esta inactivo o expirado y no acepta nuevas matriculaciones'));
        }

        // Prevent creators/collaborators from enrolling
        const blocked = await this._isCreatorOrCollaborator(userId, courseId);
        if (blocked) return Result.fail(new ForbiddenError('Creadores y colaboradores no pueden matricularse'));

        // Check existing pre-enrollment
        const existing = await this.progressRepo.findPreEnrollment(userId, courseId);
        if (existing) {
            const existingStatus = this._getEnrollmentStatusValue(existing);
            if (existingStatus === 'approved') {
                return Result.ok({...existing, message: 'Ya estÃ¡s matriculado' });
            }
            if (existingStatus === 'pending') {
                return Result.ok({...existing, message: 'Tu solicitud ya estÃ¡ pendiente de aprobaciÃ³n' });
            }
            // rejected â€” allow re-request
        }

        const pending = await this.progressRepo.upsertPreEnrollment(userId, courseId, 'pending', null, requestedRole);

        // Notify all role 3 (admin) users about the new enrollment request
        const roleLabel = requestedRole === 'docente' ? ' como docente' : '';
        this._notifyAdminsAboutEnrollmentRequest(userId, courseId, course.title, roleLabel).catch(err =>
            console.warn('[ProgressService] Error notifying admins about enrollment request:', err?.message)
        );

        return Result.ok({...pending, message: 'Solicitud de matrÃ­cula enviada' });
    }

    /**
     * Admin approves an enrollment request.
     */
    async approveEnrollment(userId, courseId) {
        const existing = await this.progressRepo.findPreEnrollment(userId, courseId);
        if (!existing) return Result.fail(new NotFoundError('Solicitud de matrÃ­cula', `${userId}/${courseId}`));

        const requestedRole = existing.requestedRole || existing.requested_role || 'student';

        const updated = await this.progressRepo.updateEnrollmentStatus(userId, courseId, 'approved');

        // If the user requested enrollment as docente, add them as a collaborator
        if (requestedRole === 'docente' && this.collaboratorRepo) {
            try {
                await this.collaboratorRepo.add(courseId, userId);
                console.log(`[ProgressService] Added userId=${userId} as collaborator (docente) to courseId=${courseId}`);
            } catch (collabErr) {
                console.warn(`[ProgressService] Could not add collaborator for docente enrollment userId=${userId}:`, collabErr?.message);
            }
        }

        // Crear registro en progreso_curso para que isEnrolled() retorne true
        // y el estudiante aparezca correctamente en el curso.
        try {
            await this.progressRepo.upsert({
                userId,
                courseId,
                completedTasks: 0,
                totalTasks: 0,
                averageGrade: 0,
                progressPercentage: 0,
                enrollment_status: 'activo',
            });
        } catch (progressErr) {
            console.warn(`[ProgressService] Could not create progreso_curso for approved enrollment userId=${userId}:`, progressErr?.message);
        }

        const isDocente = requestedRole === 'docente';
        const roleSuffix = isDocente ? ' como docente' : '';

        // Notify the student about enrollment approval
        if (this._notificationService) {
            try {
                let courseName = 'un curso';
                if (this.courseRepo) {
                    const course = await this.courseRepo.findById(courseId);
                    if (course?.title) courseName = course.title;
                }
                await this._notificationService.send(userId, {
                    title: 'Â¡MatrÃ­cula aprobada!',
                    message: `Tu solicitud de matrÃ­cula${roleSuffix} en "${courseName}" ha sido aprobada. Â¡Ya puedes comenzar!`,
                    type: 'enrollment_approved',
                    relatedId: courseId,
                    metadata: { courseId, courseName, requestedRole },
                });

                // Send confirmation email to the student
                try {
                    let studentName = 'Estudiante';
                    if (this.userRepo) {
                        const student = await this.userRepo.findById(userId);
                        if (student?.username) studentName = student.username;
                    }
                    const { generateEnrollmentApprovedEmailHTML } = await
                    import ('../../templates/emailTemplates.js');
                    const html = generateEnrollmentApprovedEmailHTML(studentName, courseName);
                    await this._notificationService.sendEmail(userId, {
                        subject: `âœ… Â¡Tu matrÃ­cula en "${courseName}" ha sido aprobada!`,
                        html,
                        text: `Â¡Felicitaciones ${studentName}! Tu solicitud de matrÃ­cula en el curso "${courseName}" ha sido aprobada. Ya puedes acceder al contenido del curso en CourseV.`,
                    });
                } catch (emailErr) {
                    console.warn('[ProgressService] Error sending enrollment approved email:', emailErr?.message);
                }
            } catch (err) {
                console.error('[ProgressService] Error sending enrollment notification:', err?.message);
            }
        }

        return Result.ok({...updated, message: 'MatrÃ­cula aprobada' });
    }

    /**
     * Admin rejects an enrollment request.
     */
    async rejectEnrollment(userId, courseId) {
        const existing = await this.progressRepo.findPreEnrollment(userId, courseId);
        if (!existing) return Result.fail(new NotFoundError('Solicitud de matrÃ­cula', `${userId}/${courseId}`));

        const updated = await this.progressRepo.updateEnrollmentStatus(userId, courseId, 'rejected');
        return Result.ok({...updated, message: 'MatrÃ­cula rechazada' });
    }

    /**
     * Admin: get all pending enrollment requests (optionally for a specific course).
     */
    async getPendingEnrollments(courseId = null) {
        const rows = await this.progressRepo.findPendingEnrollments(courseId);
        return Result.ok(rows || []);
    }

    /**
     * Admin: get all approved enrollments (users with active access) grouped by course.
     */
    async getApprovedEnrollments() {
        const rows = await this.progressRepo.findApprovedEnrollments();
        return Result.ok(rows || []);
    }

    /**
     * Admin: revoke a user's enrollment (remove course access).
     */
    async revokeEnrollment(userId, courseId, reason = null) {
        const existing = await this.progressRepo.findPreEnrollment(userId, courseId);
        if (!existing) return Result.fail(new NotFoundError('MatrÃ­cula', `${userId}/${courseId}`));

        // OCP / DIP â€" Usa revokeEnrollmentAccess (mÃ©todo especÃ­fico del repositorio) en lugar
        // de deleteEnrollment, que tiene dos bugs:
        //   1. El UPDATE a status='revoked' falla silenciosamente si la columna revoke_reason
        //      no existe en pre_enrollments o hay un CHECK constraint en status.
        //   2. No elimina progreso_curso, permitiendo acceso al curso por esa vÃ­a.
        await this.progressRepo.revokeEnrollmentAccess(userId, courseId);

        // Notify the student about revocation (push + email)
        if (this._notificationService) {
            try {
                let courseName = 'un curso';
                if (this.courseRepo) {
                    const course = await this.courseRepo.findById(courseId);
                    if (course?.title) courseName = course.title;
                }
                const displayReason = reason || 'No especificado';
                await this._notificationService.send(userId, {
                    title: 'Se te quitó el acceso',
                    message: `Tu acceso a "${courseName}" fue revocado. Motivo: ${displayReason}`,
                    type: 'enrollment_revoked',
                    relatedId: courseId,
                    metadata: { courseId, courseName, reason: displayReason },
                });

                // Enviar correo electrónico de revocación
                await this._notificationService.sendEmail(userId, {
                    subject: `Acceso revocado: ${courseName}`,
                    text: [
                        `Hola,`,
                        '',
                        `Tu acceso al curso "${courseName}" ha sido revocado.`,
                        `Motivo: ${displayReason}`,
                        '',
                        'Si crees que esto es un error, contacta al administrador del curso.',
                        '',
                        'Equipo CourseV.'
                    ].join('\n'),
                    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#1c1c1e;color:#fff;border-radius:12px"><h2 style="margin:0 0 16px">Acceso revocado</h2><p>Tu acceso al curso <strong>"${courseName}"</strong> ha sido revocado.</p><p><strong>Motivo:</strong> ${displayReason}</p><hr style="border:none;border-top:1px solid #333;margin:20px 0"><p style="font-size:13px;color:#8e8e93">Si crees que esto es un error, contacta al administrador del curso.</p><p style="font-size:13px;color:#8e8e93">Equipo CourseV.</p></div>`,
                });
            } catch (err) {
                console.error('[ProgressService] Error sending revoke notification/email:', err?.message);
            }
        }

        return Result.ok({ message: 'Acceso al curso revocado', reason });
    }

    async setCourseEnrollmentStatus(userId, courseId, status) {
        await this.progressRepo.setCourseEnrollmentStatus(userId, courseId, status);

        // Cuando se desactiva el acceso, también revocar el pre_enrollment para
        // que isEnrolledAndApproved no devuelva 'approved' desde pre_enrollments.
        const normalizedStatus = String(status || '').trim().toLowerCase();
        if (normalizedStatus === 'inactivo') {
            try {
                const existing = await this.progressRepo.findPreEnrollment(userId, courseId);
                if (existing) {
                    await this.progressRepo.updateEnrollmentStatus(userId, courseId, 'revoked');
                }
            } catch (err) {
                console.warn('[ProgressService] Error syncing pre_enrollment on inactivo:', err?.message);
            }
        } else if (normalizedStatus === 'activo') {
            // Al reactivar, restaurar el pre_enrollment a 'approved'
            try {
                const existing = await this.progressRepo.findPreEnrollment(userId, courseId);
                if (existing) {
                    await this.progressRepo.updateEnrollmentStatus(userId, courseId, 'approved');
                }
            } catch (err) {
                console.warn('[ProgressService] Error syncing pre_enrollment on activo:', err?.message);
            }
        }

        // Notificar al estudiante cuando se le desactiva el acceso
        if (normalizedStatus === 'inactivo' && this._notificationService) {
            try {
                let courseName = 'un curso';
                if (this.courseRepo) {
                    const course = await this.courseRepo.findById(courseId);
                    if (course?.title) courseName = course.title;
                }

                await this._notificationService.send(userId, {
                    title: 'Se te quitó el acceso',
                    message: `Tu acceso al curso "${courseName}" fue desactivado por el administrador.`,
                    type: 'enrollment_revoked',
                    relatedId: courseId,
                    metadata: { courseId, courseName, reason: 'Acceso desactivado por el administrador' },
                });

                await this._notificationService.sendEmail(userId, {
                    subject: `Acceso desactivado: ${courseName}`,
                    text: [
                        'Hola,',
                        '',
                        `Tu acceso al curso "${courseName}" ha sido desactivado por el administrador.`,
                        '',
                        'Si crees que esto es un error, contacta al administrador del curso.',
                        '',
                        'Equipo CourseV.'
                    ].join('\n'),
                    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#1c1c1e;color:#fff;border-radius:12px"><h2 style="margin:0 0 16px">Acceso desactivado</h2><p>Tu acceso al curso <strong>"${courseName}"</strong> ha sido desactivado por el administrador.</p><hr style="border:none;border-top:1px solid #333;margin:20px 0"><p style="font-size:13px;color:#8e8e93">Si crees que esto es un error, contacta al administrador del curso.</p><p style="font-size:13px;color:#8e8e93">Equipo CourseV.</p></div>`,
                });
            } catch (err) {
                console.error('[ProgressService] Error sending enrollment inactivo notification/email:', err?.message);
            }
        }

        return Result.ok({ message: 'Estado de matricula actualizado', userId, courseId, status });
    }

    async setSubjectEnrollmentStatus(userId, courseId, subjectId, status) {
        await this.progressRepo.setSubjectEnrollmentStatus(userId, courseId, subjectId, status);
        return Result.ok({ message: 'Estado de matricula de materia actualizado', userId, courseId, subjectId, status });
    }

    // â”€â”€â”€ Subject Access Blocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Admin: block a user from accessing a specific subject.
     */
    async blockSubjectAccess(userId, courseId, subjectId, reason, blockedBy = null) {
        if (!reason || !String(reason).trim()) {
            return Result.fail(new ForbiddenError('Debe proporcionar una razÃ³n para bloquear el acceso'));
        }
        const block = await this.progressRepo.blockSubjectAccess(userId, courseId, subjectId, reason.trim(), blockedBy);

        // Update enrollment_status in progreso_materia to 'inactivo'
        try {
            await this.progressRepo.setSubjectEnrollmentStatus(userId, courseId, subjectId, 'inactivo');
        } catch (err) {
            console.error('[ProgressService] Error setting subject enrollment_status to inactivo:', err?.message);
        }

        // Notify the student
        if (this._notificationService) {
            try {
                let subjectName = 'una materia';
                if (this.subjectRepo) {
                    const subject = await this.subjectRepo.findById(subjectId);
                    if (subject?.name) subjectName = subject.name;
                }
                await this._notificationService.send(userId, {
                    title: 'Se te quitÃ³ el permiso',
                    message: `Tu acceso a la materia "${subjectName}" fue revocado. Motivo: ${reason}`,
                    type: 'subject_access_blocked',
                    relatedId: subjectId,
                    metadata: { subjectId, subjectName, reason, courseId },
                });
            } catch (err) {
                console.error('[ProgressService] Error sending subject block notification:', err?.message);
            }
        }

        return Result.ok(block);
    }

    /**
     * Admin: unblock a user's access to a specific subject.
     */
    async unblockSubjectAccess(userId, subjectId, courseId = null, unblockedBy = null) {
        await this.progressRepo.unblockSubjectAccess(userId, subjectId, unblockedBy);

        // Restore enrollment_status in progreso_materia to 'activo'
        if (courseId) {
            try {
                await this.progressRepo.setSubjectEnrollmentStatus(userId, courseId, subjectId, 'activo');
            } catch (err) {
                console.error('[ProgressService] Error restoring subject enrollment_status to activo:', err?.message);
            }
        }

        return Result.ok({ message: 'Acceso a la materia restaurado' });
    }

    /**
     * Check if a user is blocked from a specific subject.
     */
    async checkSubjectAccessBlock(userId, subjectId) {
        const block = await this.progressRepo.findSubjectAccessBlock(userId, subjectId);
        return Result.ok({
            blocked: !!block,
            reason: block?.reason || null,
            blockedAt: block?.blocked_at || null,
        });
    }

    /**
     * Get all subject access blocks for a user in a course.
     */
    async getSubjectAccessBlocks(userId, courseId) {
        const blocks = await this.progressRepo.findSubjectAccessBlocksByUserAndCourse(userId, courseId);
        return Result.ok(blocks || []);
    }

    /**
     * Admin: get all active subject access blocks across all users.
     * Returns array of { userId, courseId, subjectId } for pre-populating UI state.
     */
    async getAllSubjectAccessBlocks() {
        const blocks = await this.progressRepo.findAllSubjectAccessBlocks();
        return Result.ok(blocks || []);
    }

    /**
     * Check if student has an approved enrollment in a course.
     * Checks both the pre_enrollment table AND direct progress records (for users
     * enrolled directly by an admin without going through the request flow).
     */
    async isEnrolledAndApproved(userId, courseId) {
        // Rol 3 (admin) o rol 4 (superadmin) tiene acceso a todos los cursos sin necesidad de matrícula
        const roleIds = await this._getUserRoleIds(userId);
        if (roleIds.includes(3) || roleIds.includes(4)) {
            return Result.ok({
                enrolled: true,
                status: 'admin',
                enrollmentStatus: 'admin',
            });
        }

        // Colaboradores y creadores tienen acceso directo sin matrícula
        const isCreatorOrCollab = await this._isCreatorOrCollaborator(userId, courseId);
        if (isCreatorOrCollab) {
            return Result.ok({
                enrolled: true,
                status: 'approved',
                enrollmentStatus: 'approved',
            });
        }

        // Siempre verificar enrollment_status en progreso_curso — tiene prioridad
        // sobre pre_enrollments porque un admin puede desactivar el acceso desde ahí.
        const courseEnrollmentStatus = await this.progressRepo.findCourseEnrollmentStatus(userId, courseId);
        if (courseEnrollmentStatus !== null) {
            const normalized = String(courseEnrollmentStatus).trim().toLowerCase();
            if (normalized === 'inactivo') {
                return Result.ok({
                    enrolled: false,
                    status: 'inactivo',
                    enrollmentStatus: 'inactivo',
                });
            }
        }

        const row = await this.progressRepo.findPreEnrollment(userId, courseId);
        if (!row) {
            // No pre_enrollment record – check enrollment_status directly in progreso_curso
            if (courseEnrollmentStatus !== null) {
                const normalized = String(courseEnrollmentStatus).trim().toLowerCase();
                const isActive = normalized === 'activo';
                return Result.ok({
                    enrolled: isActive,
                    status: isActive ? 'approved' : normalized,
                    enrollmentStatus: isActive ? 'approved' : normalized,
                });
            }
            return Result.ok({ enrolled: false, status: null, enrollmentStatus: null });
        }
        const status = this._getEnrollmentStatusValue(row);
        return Result.ok({
            enrolled: status === 'approved',
            status,
            enrollmentStatus: status,
        });
    }

    _getEnrollmentStatusValue(record) {
        const status = record?.enrollmentStatus??record?.enrollment_status??record?.status??null;
        return typeof status === 'string' ? status.trim().toLowerCase() : null;
    }

    async _notifyAdminsAboutEnrollmentRequest(studentUserId, courseId, courseTitle, roleLabel = '') {
        if (!this._notificationService || !this.userRepo) return;

        // Get all admin user IDs (role 3)
        let adminUserIds = [];
        if (typeof this.userRepo.findUserIdsByRoleId === 'function') {
            adminUserIds = await this.userRepo.findUserIdsByRoleId(3);
        }
        if (!adminUserIds || adminUserIds.length === 0) return;

        // Get student info
        let studentName = 'Un estudiante';
        let studentAvatar = null;
        try {
            const student = await this.userRepo.findById(studentUserId);
            if (student) {
                studentName = student.username || studentName;
                studentAvatar = student.avatar || null;
            }
        } catch { /* ignore */ }

        const courseName = courseTitle || 'un curso';

        // Send push/in-app notification to all admins
        await this._notificationService.sendBulk(adminUserIds, {
            title: 'Nueva solicitud de matrÃ­cula',
            message: `${studentName} ha solicitado matricularse${roleLabel} en "${courseName}".`,
            type: 'enrollment_request',
            relatedId: courseId,
            senderUsername: studentName,
            senderAvatarUrl: studentAvatar,
            metadata: { courseId, courseName, studentUserId },
            actorUserId: studentUserId,
        });

        // Send email to each admin
        try {
            const { generateEnrollmentRequestEmailHTML } = await
            import ('../../templates/emailTemplates.js');
            for (const adminId of adminUserIds) {
                if (Number(adminId) === Number(studentUserId)) continue;
                try {
                    let adminName = 'Administrador';
                    const admin = await this.userRepo.findById(adminId);
                    if (admin) adminName = admin.username || adminName;

                    const html = generateEnrollmentRequestEmailHTML(adminName, studentName, courseName, studentAvatar);
                    await this._notificationService.sendEmail(adminId, {
                        subject: `ðŸ“‹ Nueva solicitud de matrÃ­cula: ${studentName} â†’ "${courseName}"`,
                        html,
                        text: `${studentName} ha solicitado matricularse en el curso "${courseName}". Revisa la solicitud en el panel de administraciÃ³n.`,
                    });
                } catch (emailErr) {
                    console.warn(`[ProgressService] Error sending enrollment email to admin ${adminId}:`, emailErr?.message);
                }
            }
        } catch (err) {
            console.warn('[ProgressService] Error loading email template:', err?.message);
        }
    }
}
export default ProgressDomainService;
