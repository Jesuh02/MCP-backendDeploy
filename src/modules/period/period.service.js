import { Result } from '../../../shared/Result.js';

export class PeriodDomainService {
    constructor({ periodRepository, gradeService, gradeRepository }) {
        this.periodRepo = periodRepository;
        this.gradeService = gradeService;
        this.gradeRepo = gradeRepository;
    }

    /** Cierra el periodo actual: toma un snapshot del grade sheet y limpia las notas manuales. */
    async closePeriod(userId, { courseId, subjectId, name }) {
        try {
            const cid = parseInt(courseId);
            const sid = parseInt(subjectId);

            // 1. Obtener la grade sheet actual
            const sheetResult = await this.gradeService.getGradeSheet(userId, sid);
            if (sheetResult.isFail()) return sheetResult;
            const sheet = sheetResult.getValue();

            // 2. Siguiente número de periodo
            const maxNum = await this.periodRepo.getMaxPeriodNumber(cid, sid);
            const periodNumber = maxNum + 1;
            const periodName = name || `Periodo ${periodNumber}`;

            // 3. Guardar snapshot
            const period = await this.periodRepo.create({
                courseId: cid,
                subjectId: sid,
                periodNumber,
                name: periodName,
                snapshot: sheet,
                createdBy: userId,
            });

            // 4. Limpiar notas manuales del subject para empezar de cero
            await this.gradeRepo.deleteBySubject(sid);

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
