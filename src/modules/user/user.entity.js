/**
 * User — Entidad de dominio para Usuario.
 *
 * Modelo puro sin dependencias de infraestructura.
 * Combina datos de las tablas: usuarios, personas, roles.
 */
export class User {
    constructor({
        id = null,
        username,
        email,
        password = null,
        avatar = null,
        personaId = null,
        persona = null,
        roles = [],
        isActive = true,
        emailVerified = false,
        createdAt = null,
        updatedAt = null,
    } = {}) {
        this.id = id;
        this.username = username;
        this.email = email;
        this.password = password;
        this.avatar = avatar;
        this.personaId = personaId;
        this.persona = persona; // { id, nombre, apellido, identificacion, telefono }
        this.roles = roles; // [{ id, nombre }]
        this.isActive = isActive;
        this.emailVerified = emailVerified;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    /** @returns {boolean} Tiene rol admin (roleId = 3) */
    isAdmin() {
        return this.roles.some((r) => (r.id || r) === 3);
    }

    /** @returns {boolean} Tiene rol docente/creador (roleId = 2) */
    isDocente() {
        return this.roles.some((r) => (r.id || r) === 2);
    }

    /** @returns {boolean} */
    hasRole(roleId) {
        return this.roles.some((r) => (r.id || r) === roleId);
    }

    /**
     * Retorna representación segura (sin password).
     * @returns {object}
     */
    toSafeJSON() {
        const { password, ...safe } = this;
        return safe;
    }

    /**
     * Crea una instancia User desde un row de Supabase.
     * @param {object} row — fila de la tabla usuarios + joins.
     * @returns {User}
     */
    static fromSupabaseRow(row) {
        return new User({
            id: row.id,
            username: row.username,
            email: row.email,
            password: row.password || null,
            avatar: row.avatar || null,
            personaId: row.persona_id || null,
            persona: row.persona || null,
            roles: row.roles || [],
            isActive: row.is_active !== false,
            emailVerified: row.email_verified || false,
            createdAt: row.created_at || null,
            updatedAt: row.updated_at || null,
        });
    }
}

export default User;

