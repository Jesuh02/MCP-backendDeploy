/**
 * ChatMessageController — Controlador HTTP para mensajes de chat.
 *
 * Responsabilidad: validar entrada HTTP, delegar en el servicio de dominio
 * y devolver respuestas estandarizadas.
 */
import { BaseController } from '../../shared/BaseController.js';
import { parsePagination } from '../../shared/pagination.js';

export class ChatMessageController extends BaseController {
    constructor({ chatMessageService }) {
        super();
        this.chatMessageService = chatMessageService;
    }

    getById = async(req, res, next) => {
        this.store(req, res, next, () =>
            this.chatMessageService.getById(parseInt(req.params.id))
        );
    };

    getBySession = async(req, res, next) => {
        const pg = parsePagination(req.query);
        this.store(req, res, next, () =>
            this.chatMessageService.getBySession(req.params.sessionId, pg)
        );
    };

    getByUser = async(req, res, next) => {
        const userId = req.params.userId ?
            parseInt(req.params.userId) :
            req.user.userId;
        const pg = parsePagination(req.query);
        this.store(req, res, next, () =>
            this.chatMessageService.getByUser(userId, pg)
        );
    };

    create = async(req, res, next) => {
        const body = req.body;
        // Normalize snake_case (Vue/web) and camelCase (Android) keys
        const data = {
            ...body,
            message: body.message,
            isFromUser: body.isFromUser ?? body.is_from_user ?? false,
            timestamp: (typeof body.timestamp === 'number' ? body.timestamp : null) ?? Date.now(),
            sessionId: body.sessionId ?? body.session_id ?? null,
            hasCalification: body.hasCalification ?? body.has_calification ?? false,
            calificationValue: body.calificationValue ?? body.calification_value ?? null,
            calificationAdded: body.calificationAdded ?? body.calification_added ?? false,
            usuarioId: body.usuarioId ?? body.usuario_id ?? req.user?.userId ?? null,
            username: body.username ?? req.user?.username ?? null,
            origin: body.origin ?? null,
        };
        this.handleResult(res, next, (async() => {
            const result = await this.chatMessageService.create(data);
            if (result.isFail()) return result;
            res.status(201);
            return result;
        })());
    };

    upsert = async(req, res, next) => {
        const body = req.body;
        // Normalize snake_case (Vue/web) and camelCase (Android) keys
        const data = {
            ...body,
            message: body.message,
            isFromUser: body.isFromUser ?? body.is_from_user ?? false,
            timestamp: (typeof body.timestamp === 'number' ? body.timestamp : null) ?? Date.now(),
            sessionId: body.sessionId ?? body.session_id ?? null,
            hasCalification: body.hasCalification ?? body.has_calification ?? false,
            calificationValue: body.calificationValue ?? body.calification_value ?? null,
            calificationAdded: body.calificationAdded ?? body.calification_added ?? false,
            usuarioId: body.usuarioId ?? body.usuario_id ?? req.user?.userId ?? null,
            username: body.username ?? req.user?.username ?? null,
            origin: body.origin ?? null,
        };
        this.store(req, res, next, () =>
            this.chatMessageService.upsert(data)
        );
    };
    delete = async(req, res, next) => {
        this.store(req, res, next, () =>
            this.chatMessageService.delete(parseInt(req.params.id))
        );
    };

    deleteBySession = async(req, res, next) => {
        this.store(req, res, next, () =>
            this.chatMessageService.deleteBySession(req.params.sessionId)
        );
    };
}

export default ChatMessageController;

