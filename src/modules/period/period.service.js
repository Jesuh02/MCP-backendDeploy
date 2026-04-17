import { Result } from '../../shared/Result.js';

export class PeriodDomainService {
    constructor({ periodRepository, gradeService, gradeRepository }) {
        this.periodRepo = periodRepository;
        this.gradeService = gradeService;
        this.gradeRepo = gradeRepository;
    }

    /** Cierra el periodo actual: toma un snapshot del grade sheet y limpia las notas manuales. */
    async closePeriod(userId, { courseId, subjectId, name, startsAt, endsAt }) {
        try {
            const cid = parseInt(courseId);
            const sid = parseInt(subjectId);

            // 1. Obtener la grade sheet actual
            const sheetResult = await this.gradeService.getGradeSheet(userId, sid);
            if (sheetResult.isFail()) return sheetResult;
            const sheet = sheetResult.getValue();

            let period;

            // 2. Si existe un periodo activo (snapshot = null), cerrarlo actualizándolo
            let activePeriod = await this.periodRepo.findActiveBySubject(sid);

            // Defensive fallback: if the SQL IS NULL query missed the active period (can happen
            // when snapshot was stored as JSONB null instead of SQL NULL in older rows),
            // scan all periods and pick the one without a snapshot.
            if (!activePeriod) {
                const allPeriods = await this.periodRepo.findBySubject(sid);
                const unclosed = (allPeriods || [])
                    .filter(p => p.snapshot == null)
                    .sort((a, b) => b.periodNumber - a.periodNumber);
                activePeriod = unclosed[0] || null;
            }

            if (activePeriod) {
                period = await this.periodRepo.closeById(activePeriod.id, {
                    snapshot: sheet,
                    endsAt: endsAt || new Date().toISOString(),
                    name: name || undefined, // solo renombrar si se provee explícitamente
                });
            } else {
                // Flujo legado: no se llamó startPeriod antes, crear directamente
                const maxNum = await this.periodRepo.getMaxPeriodNumber(cid, sid);
                const periodNumber = maxNum + 1;
                const periodName = name || `Periodo ${periodNumber}`;

                period = await this.periodRepo.create({
                    courseId: cid,
                    subjectId: sid,
                    periodNumber,
                    name: periodName,
                    snapshot: sheet,
                    createdBy: userId,
                    startsAt: startsAt || null,
                    endsAt: endsAt || new Date().toISOString(),
                });
            }

            // 3. Limpiar notas manuales del subject para empezar de cero
            await this.gradeRepo.deleteBySubject(sid);

            return Result.ok(period);
        } catch (err) {
            return Result.fail(err);
        }
    }

    /** Inicia un nuevo periodo con fecha de inicio (endsAt se establece al cerrarlo). */
    async startPeriod(userId, { courseId, subjectId, name, startsAt, endsAt }) {
        try {
            const cid = parseInt(courseId);
            const sid = parseInt(subjectId);

            const start = new Date(startsAt || new Date());
            if (isNaN(start.getTime())) {
                return Result.fail(new Error('Fecha de inicio inválida'));
            }

            const end = endsAt ? new Date(endsAt) : null;
            if (end && isNaN(end.getTime())) {
                return Result.fail(new Error('Fecha de fin inválida'));
            }
            if (end && end <= start) {
                return Result.fail(new Error('La fecha de fin debe ser posterior a la fecha de inicio'));
            }

            // Siguiente número de periodo
            const maxNum = await this.periodRepo.getMaxPeriodNumber(cid, sid);
            const periodNumber = maxNum + 1;
            const periodName = name || `Periodo ${periodNumber}`;

            // Crear periodo activo (sin snapshot aún, se llenará al cerrarlo)
            const period = await this.periodRepo.create({
                courseId: cid,
                subjectId: sid,
                periodNumber,
                name: periodName,
                snapshot: null,
                createdBy: userId,
                startsAt: start.toISOString(),
                endsAt: end ? end.toISOString() : null,
            });

            return Result.ok(period);
        } catch (err) {
            return Result.fail(err);
        }
    }

    /** Lista todos los periodos de una materia. */
    async listBySubject(subjectId) {
        try {
            const periods = await this.periodRepo.findBySubject(parseInt(subjectId));
            return Result.ok(periods);
        } catch (err) {
            return Result.fail(err);
        }
    }

    /** Lista todos los periodos de un curso. */
    async listByCourse(courseId) {
        try {
            const periods = await this.periodRepo.findByCourse(parseInt(courseId));
            return Result.ok(periods);
        } catch (err) {
            return Result.fail(err);
        }
    }

    /** Obtiene un periodo con su snapshot. */
    async getById(periodId) {
        try {
            const period = await this.periodRepo.findById(parseInt(periodId));
            if (!period) return Result.fail({ status: 404, message: 'Periodo no encontrado' });
            return Result.ok(period);
        } catch (err) {
            return Result.fail(err);
        }
    }

    /** Modifica las notas dentro del snapshot de un periodo. */
    async updatePeriodGrades(periodId, { manualGrades, taskGrades }) {
        try {
            const pid = parseInt(periodId);
            const period = await this.periodRepo.findById(pid);
            if (!period) return Result.fail({ status: 404, message: 'Periodo no encontrado' });

            const snapshot = { ...period.snapshot };
            if (manualGrades !== undefined) snapshot.manualGrades = manualGrades;
            if (taskGrades !== undefined) snapshot.taskGrades = taskGrades;

            const updated = await this.periodRepo.updateSnapshot(pid, snapshot);
            return Result.ok(updated);
        } catch (err) {
            return Result.fail(err);
        }
    }

    /** Elimina un periodo. */
    async deletePeriod(periodId) {
        try {
            await this.periodRepo.delete(parseInt(periodId));
            return Result.ok({ deleted: true });
        } catch (err) {
            return Result.fail(err);
        }
    }
}
