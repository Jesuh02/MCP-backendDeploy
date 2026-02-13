/**
 * WhatsAppMessage — Mensaje entrante o saliente del canal WhatsApp.
 *
 * Se almacena en la tabla chat_messages reutilizando los campos existentes
 * con origin = 'whatsapp'.
 */
export class WhatsAppMessage {
    constructor({
        id = null,
        sessionId = null,
        usuarioId = null,
        username = null,
        message = '',
        isFromUser = false,
        messageType = 'text',
        waMessageId = null,
        origin = 'whatsapp',
        status = 'sent',
        submissionId = null,
        timestamp = null,
        createdAt = null,
    } = {}) {
        Object.assign(this, {
            id,
            sessionId,
            usuarioId,
            username,
            message,
            isFromUser,
            messageType,
            waMessageId,
            origin,
            status,
            submissionId,
            timestamp,
            createdAt,
        });
    }

    /** @returns {boolean} */
    isInbound() {
        return this.isFromUser === true;
    }

    /** @returns {boolean} */
    isOutbound() {
        return this.isFromUser === false;
    }

    /**
     * Mapea una fila de chat_messages a WhatsAppMessage.
     * @param {object} row
     * @returns {WhatsAppMessage}
     */
    static fromSupabaseRow(row) {
            return new WhatsAppMessage({
                        id: row.id,
                        sessionId: row.session_id,
                        usuarioId: row.usuario_id,
                        username: row.username,
                        message: row.message,
                        isFromUser: row.is_from_user ? ? false,
                        messageType: row.message_type ? ? 'text',
                        waMessageId: row.wa_message_id,
                        origin: row.origin ? ? 'whatsapp',
            status: row.status ?? 'sent',
            submissionId: row.submission_id,
            timestamp: row.timestamp,
            createdAt: row.created_at,
        });
    }

    /**
     * Convierte a formato de fila para inserción en chat_messages.
     * @returns {object}
     */
    toDatabaseRow() {
        return {
            session_id: this.sessionId,
            usuario_id: this.usuarioId,
            username: this.username,
            message: this.message,
            is_from_user: this.isFromUser,
            message_type: this.messageType,
            wa_message_id: this.waMessageId,
            origin: this.origin,
            status: this.status,
            submission_id: this.submissionId,
            timestamp: this.timestamp || Date.now(),
        };
    }
}

export default WhatsAppMessage;
