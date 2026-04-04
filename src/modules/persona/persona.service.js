/**
 * PersonaDomainService — CRUD for personas.
 */
import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class PersonaDomainService {
    constructor({ personaRepository }) {
        this.personaRepo = personaRepository;
    }

    async getById(id) {
        const persona = await this.personaRepo.findById(id);
        if (!persona) return Result.fail(new NotFoundError('Persona', id));
        return Result.ok(persona);
    }

    async getByIdentificacion(identificacion) {
        const persona = await this.personaRepo.findByIdentificacion(identificacion);
        if (!persona) return Result.fail(new NotFoundError('Persona (identificacion)', identificacion));
        return Result.ok(persona);
    }

    async list(pagination = {}) {
        const personas = await this.personaRepo.findAll(pagination);
        return Result.ok(personas);
    }

    async search(query, limit = 20) {
        const q = String(query || '').trim();
        // If query contains letters, search by name; otherwise search by identificacion
        const hasLetters = /[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ]/.test(q);
        const personas = hasLetters
            ? await this.personaRepo.searchByName(q, limit)
            : await this.personaRepo.searchByIdentificacion(q, limit);
        return Result.ok(personas);
    }

    async searchByName(query, limit = 20) {
        const personas = await this.personaRepo.searchByName(query, limit);
        return Result.ok(personas);
    }

    async getByUserIds(userIds) {
        const results = await this.personaRepo.findByUserIds(userIds);
        return Result.ok(results);
    }

    async create(data) {
        const identificacion = data.identificacion ?? data.cedula;
        if (identificacion) {
            const existing = await this.personaRepo.findByIdentificacion(identificacion);
            if (existing) {
                const updated = await this.personaRepo.update(existing.id, data);
                return Result.ok(updated);
            }
        }
        const created = await this.personaRepo.create(data);
        return Result.ok(created);
    }

    async update(id, data) {
        const persona = await this.personaRepo.findById(id);
        if (!persona) return Result.fail(new NotFoundError('Persona', id));
        const updated = await this.personaRepo.update(id, data);
        return Result.ok(updated);
    }

    async delete(id) {
        const persona = await this.personaRepo.findById(id);
        if (!persona) return Result.fail(new NotFoundError('Persona', id));
        await this.personaRepo.delete(id);
        return Result.ok({ message: 'Persona eliminada' });
    }
}
export default PersonaDomainService;

