/**
 * IUserRepository — Puerto de salida para persistencia de usuarios.
 * @interface
 */
export class IUserRepository {
    async findById(id) { throw new Error('Not implemented'); }
    async findByUsername(username) { throw new Error('Not implemented'); }
    async findByEmail(email) { throw new Error('Not implemented'); }
    async create(userData) { throw new Error('Not implemented'); }
    async update(id, data) { throw new Error('Not implemented'); }
    async exists(username) { throw new Error('Not implemented'); }
    async findWithRoles(username) { throw new Error('Not implemented'); }
    async assignRole(userId, roleId) { throw new Error('Not implemented'); }
    async getUserRoles(userId) { throw new Error('Not implemented'); }
    async searchByUsername(query, limit) { throw new Error('Not implemented'); }
    async findByIds(ids) { throw new Error('Not implemented'); }
    async getUserFCMTokens(userId) { throw new Error('Not implemented'); }
    async registerFCMToken(userId, token, deviceType) { throw new Error('Not implemented'); }
    async removeInvalidFCMTokens(tokens) { throw new Error('Not implemented'); }
}
export default IUserRepository;

