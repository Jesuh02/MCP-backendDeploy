/**
 * ChatMessage — Mensaje de chat (usuario o bot).
 */
export class ChatMessage {
    constructor({
        id = null,
        message = '',
        isFromUser = false,
        timestamp = null,
        sessionId = null,
        hasCalification = false,
        calificationValue = null,
        calificationAdded = false,
        usuarioId = null,
        username = null,
        isTyping = false,
        isError = false,
        isGraphResponse = false,
        origin = null,
        waMessageId = null,
        messageType = 'text',
        status = 'sent',
        submissionId = null,
        excelUrl = null,
        attachedFileUrl = null,
        attachedFileName = null,
        attachedFileType = null,
        senderAvatar = null,
        createdAt = null,
    } = {}) {
        Object.assign(this, {
            id,
            message,
            isFromUser,
            timestamp,
            sessionId,
            hasCalification,
            calificationValue,
            calificationAdded,
            usuarioId,
            username,
            isTyping,
            isError,
            isGraphResponse,
            origin,
            waMessageId,
            messageType,
            status,
            submissionId,
            excelUrl,
            attachedFileUrl,
            attachedFileName,
            attachedFileType,
            senderAvatar,
            createdAt,
        });
    }

    static fromSupabaseRow(row) {
        return new ChatMessage({
            id: row.id,
            message: row.message,
            isFromUser: row.is_from_user ?? false,
            timestamp: row.timestamp,
            sessionId: row.session_id,
            hasCalification: row.has_calification ?? false,
            calificationValue: row.calification_value,
            calificationAdded: row.calification_added ?? false,
            usuarioId: row.usuario_id,
            username: row.username,
            isTyping: row.is_typing ?? false,
            isError: row.is_error ?? false,
            isGraphResponse: row.is_graph_response ?? false,
            origin: row.origin,
            waMessageId: row.wa_message_id,
            messageType: row.message_type ?? 'text',
            status: row.status ?? 'sent',
            submissionId: row.submission_id,
            excelUrl: row.excel_url,
            attachedFileUrl: row.attached_file_url,
            attachedFileName: row.attached_file_name,
            attachedFileType: row.attached_file_type,
            senderAvatar: row.sender_avatar,
            createdAt: row.created_at,
        });
    }
}

export default ChatMessage;

