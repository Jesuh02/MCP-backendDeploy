/**
 * WhatsAppSession — Sesión vinculada entre un usuario y su cuenta de WhatsApp.
 *
 * Representa la relación 1:1 entre un usuario de la plataforma
 * y su número de WhatsApp para recibir mensajes del asistente.
 */
export class WhatsAppSession {
    constructor({
        id = null,
        userId,
        phoneNumber,
        waId = null,
        isActive = true,
        linkedAt = null,
        lastMessageAt = null,
        conversationContext = [],
        createdAt = null,
        updatedAt = null,
        otpCode = null,
        otpExpiresAt = null,
    } = {}) {
        Object.assign(this, {
            id,
            userId,
            phoneNumber,
            waId,
            isActive,
            linkedAt,
            lastMessageAt,
            conversationContext,
            createdAt,
            updatedAt,
            otpCode,
            otpExpiresAt,
        });
    }

    /** @returns {boolean} Indica si la sesión está activa y verificada */
    isVerified() {
        return this.isActive === true && this.waId !== null;
    }

    /** Agrega un mensaje al contexto de conversación (mantiene últimos N) */
    addToContext(role, content, maxMessages = 10) {
        this.conversationContext.push({ role, content, timestamp: Date.now() });
        if (this.conversationContext.length > maxMessages) {
            this.conversationContext = this.conversationContext.slice(-maxMessages);
        }
        this.lastMessageAt = new Date().toISOString();
    }

    /** Verifica si el OTP proporcionado es válido */
    verifyOtp(code) {
            if (!this.otpCode || !this.otpExpiresAt) return false;
            if (new Date() > new Date(this.otpExpiresAt)) return false;
            return this.otpCode === code;
        }
        /**
         * Mapea una fila de Supabase a una instancia de WhatsAppSession.
         * @param {object} row — Fila de la tabla whatsapp_sessions.
         * @returns {WhatsAppSession}
         */
    static fromSupabaseRow(row) {
        return new WhatsAppSession({
            id: row.id,
            userId: row.user_id,
            phoneNumber: row.phone_number,
            waId: row.wa_id,
            isActive: row.is_active ?? true,
            linkedAt: row.linked_at,
            lastMessageAt: row.last_message_at,
            conversationContext: row.conversation_context ?? [],
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            otpCode: row.otp_code,
            otpExpiresAt: row.otp_expires_at,
        });
    }
}

export default WhatsAppSession;


