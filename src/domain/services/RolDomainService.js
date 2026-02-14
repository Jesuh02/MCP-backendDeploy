/**
 * RolDomainService — Read operations for roles, recursos, rol_recursos.
 */
import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class RolDomainService {
    constructor({ rolRepository, courseRepository }) {
        this.rolRepo = rolRepository;
        this.courseRepo = courseRepository || null;
    }

    // ── Roles ────────────────────────────────────────────
    async getRolById(id) {
        const rol = await this.rolRepo.findRolById(id);
        if (!rol) return Result.fail(new NotFoundError('Rol', id));
        return Result.ok(rol);
    }

    async listRoles() {
        const roles = await this.rolRepo.findAllRoles();
        return Result.ok(roles);
    }

    // ── User-Role checks ─────────────────────────────────
    async getUserRoleIds(userId) {
        const roleIds = await this.rolRepo.findUserRoleIds(userId);
        return Result.ok(roleIds);
    }

    async userHasRole(userId, roleId) {
        const has = await this.rolRepo.userHasRole(userId, roleId);
        return Result.ok({ hasRole: has });
    }

    async isUserDocente(userId) {
        const isDocente = await this.rolRepo.isUserDocente(userId);
        return Result.ok({ isDocente });
    }

    async promoteToDocente(userId) {
        const result = await this.rolRepo.promoteToDocente(userId);
        return Result.ok(result);
    }

    // ── Recursos ─────────────────────────────────────────
    async listRecursos() {
        const recursos = await this.rolRepo.findAllRecursos();
        return Result.ok(recursos);
    }

    async getRecursosByRol(rolId) {
        const recursos = await this.rolRepo.findRecursosByRol(rolId);
        return Result.ok(recursos);
    }

    // ── Rol-Recursos ─────────────────────────────────────
    async listRolRecursos() {
        const rr = await this.rolRepo.findAllRolRecursos();
        return Result.ok(rr);
    }

    async getRolRecursosByRol(rolId) {
        const rr = await this.rolRepo.findRolRecursosByRol(rolId);
        return Result.ok(rr);
    }

    /**
     * Ensure a specific user has the Creator (Docente) role.
     * If they already have it, this is a no-op.
     */
    async ensureCreatorRole(userId) {
        try {
            const result = await this.rolRepo.promoteToDocente(userId);
            return Result.ok(result);
        } catch (err) {
            return Result.fail(err);
        }
    }

    /**
     * Scan all courses and promote their creators to Docente role.
     * Useful for batch-fixing role assignments.
     */
    async syncAllCreatorRoles() {
        if (!this.courseRepo) {
            return Result.fail(new Error('Course repository not available'));
        }
        try {
            const courses = await this.courseRepo.findAll({ limit: 10000 });
            const courseList = Array.isArray(courses) ? courses : [];

            const creatorIds = new Set();
            for (const course of courseList) {
                const cid = course.creator_user_id || course.creatorUserId;
                if (cid && cid > 0) creatorIds.add(cid);
            }

            let promoted = 0;
            for (const userId of creatorIds) {
                try {
                    await this.rolRepo.promoteToDocente(userId);
                    promoted++;
                } catch (err) {
                    console.warn(`[RolService] Could not promote user ${userId}:`, err.message);
                }
            }

            return Result.ok({ promoted, total: creatorIds.size });
        } catch (err) {
            return Result.fail(err);
        }
    }
}
export default RolDomainService;

