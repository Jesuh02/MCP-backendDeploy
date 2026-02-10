/**
 * SupabaseRolRepository — Read ops for roles, usuarios_roles, recursos, rol_recursos.
 */
export class SupabaseRolRepository {
    constructor(client) { this.client = client; }

    // ── Roles ────────────────────────────────────────────
    async findRolById(id) {
        const { data, error } = await this.client.from('roles').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findAllRoles() {
        const { data, error } = await this.client.from('roles').select('*').order('id', { ascending: true });
        if (error) return [];
        return data || [];
    }

    async findRolByNombre(nombre) {
        const { data, error } = await this.client.from('roles').select('*').ilike('nombre', nombre).single();
        if (error || !data) return null;
        return data;
    }

    // ── Usuarios_Roles ───────────────────────────────────
    async findUserRoleIds(userId) {
        const { data, error } = await this.client.from('usuarios_roles').select('rol_id').eq('usuario_id', userId);
        if (error || !data) return [];
        return data.map(r => r.rol_id);
    }

    async userHasRole(userId, roleId) {
        const { count, error } = await this.client.from('usuarios_roles').select('id', { count: 'exact', head: true }).eq('usuario_id', userId).eq('rol_id', roleId);
        return !error && count > 0;
    }

    async isUserDocente(userId) {
        const { data, error } = await this.client.from('usuarios_roles').select('rol_id, roles(id, nombre, nivel)').eq('usuario_id', userId);
        if (error || !data) return false;
        return data.some(r => r.roles && (r.roles.nombre?.toLowerCase() === 'docente' || r.roles.nivel >= 2));
    }

    async promoteToDocente(userId) {
        // Find docente role
        const docente = await this.findRolByNombre('docente');
        if (!docente) throw new Error('Rol docente no encontrado');
        // Check if already has the role
        const hasRole = await this.userHasRole(userId, docente.id);
        if (hasRole) return { message: 'Usuario ya es docente', roleId: docente.id };
        // Assign role
        const { error } = await this.client.from('usuarios_roles').insert({ usuario_id: userId, rol_id: docente.id });
        if (error) throw new Error(`Error promoviendo a docente: ${error.message}`);
        return { message: 'Usuario promovido a docente', roleId: docente.id };
    }

    // ── Recursos ─────────────────────────────────────────
    async findAllRecursos() {
        const { data, error } = await this.client.from('recursos').select('*').order('id', { ascending: true });
        if (error) return [];
        return data || [];
    }
    async findRecursosByRol(rolId) {
        const { data, error } = await this.client.from('rol_recursos').select('recurso_id, recursos(*)').eq('rol_id', rolId);
        if (error || !data) return [];
        return data.map(rr => rr.recursos).filter(Boolean);
    }

    // ── Rol-Recursos ─────────────────────────────────────
    async findAllRolRecursos() {
        const { data, error } = await this.client.from('rol_recursos').select('*, roles(*), recursos(*)').order('id', { ascending: true });
        if (error) return [];
        return data || [];
    }

    async findRolRecursosByRol(rolId) {
        const { data, error } = await this.client.from('rol_recursos').select('*, recursos(*)').eq('rol_id', rolId);
        if (error) return [];
        return data || [];
    }
}
export default SupabaseRolRepository;