/**
 * RolDomainService — Read operations for roles, recursos, rol_recursos.
 */
import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class RolDomainService {
    constructor({ rolRepository }) {
        this.rolRepo = rolRepository;
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
}
export default RolDomainService;