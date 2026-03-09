/**
 * PersonaDomainService — CRUD for personas.
 */
import { Result } from '../../../shared/Result.js';
import { NotFoundError } from '../../../shared/errors/index.js';

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

    async create(data) {
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

