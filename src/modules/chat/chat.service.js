/**
 * ChatMessageDomainService — Casos de uso para mensajes de chat.
 *
 * Responsabilidades:
 *   - CRUD de mensajes de chat
 *   - Consulta por sesión y por usuario
 *
 * No contiene lógica de infraestructura; delega en el repositorio inyectado.
 */
import { Result } from '../../shared/Result.js';
import { NotFoundError } from '../../shared/errors/index.js';

export class ChatMessageDomainService {
    constructor({ chatMessageRepository }) {
        this.chatMessageRepo = chatMessageRepository;
    }

    async getById(id) {
        const message = await this.chatMessageRepo.findById(id);
        if (!message) return Result.fail(new NotFoundError('ChatMessage', id));
        return Result.ok(message);
    }

    async getBySession(sessionId, pagination) {
        const messages = await this.chatMessageRepo.findBySession(sessionId, pagination);
        return Result.ok(messages);
    }

    async getByUser(usuarioId, pagination) {
        const messages = await this.chatMessageRepo.findByUser(usuarioId, pagination);
        return Result.ok(messages);
    }

    async getByUserAndOrigin(usuarioId, origin, pagination) {
        const messages = await this.chatMessageRepo.findByUserAndOrigin(usuarioId, origin, pagination);
        return Result.ok(messages);
    }

    async create(data) {
        const created = await this.chatMessageRepo.create(data);
        return Result.ok(created);
    }

    async upsert(data) {
        const upserted = await this.chatMessageRepo.upsert(data);
        return Result.ok(upserted);
    }

    async delete(id) {
        const existing = await this.chatMessageRepo.findById(id);
        if (!existing) return Result.fail(new NotFoundError('ChatMessage', id));
        await this.chatMessageRepo.delete(id);
        return Result.ok({ message: 'Mensaje eliminado' });
    }

    async deleteBySession(sessionId) {
        await this.chatMessageRepo.deleteBySession(sessionId);
        return Result.ok({ message: 'Sesión de chat eliminada' });
    }
}

export default ChatMessageDomainService;

