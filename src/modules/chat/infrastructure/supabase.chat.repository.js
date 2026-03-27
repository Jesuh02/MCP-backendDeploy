/**
 * SupabaseChatMessageRepository — Adaptador de persistencia para chat_messages.
 *
 * Implementa el puerto de repositorio usado por ChatMessageDomainService.
 * Toda la lógica de acceso a datos queda encapsulada aquí.
 */
export class SupabaseChatMessageRepository {
    constructor(client) {
        this.client = client;
    }

    async findById(id) {
        const { data, error } = await this.client
            .from('chat_messages')
            .select('*')
            .eq('id', id)
            .single();
        if (error || !data) return null;
        return this._mapToDomain(data);
    }

    async findBySession(sessionId, { offset = 0, limit = 100 } = {}) {
        const { data, error } = await this.client
            .from('chat_messages')
            .select('*')
            .eq('session_id', sessionId)
            .order('timestamp', { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return (data || []).map(row => this._mapToDomain(row));
    }

    async findByUser(usuarioId, { offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client
            .from('chat_messages')
            .select('*')
            .eq('usuario_id', usuarioId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return (data || []).map(row => this._mapToDomain(row));
    }

    async create(messageData) {
        const payload = {
            message: messageData.message,
            is_from_user: messageData.isFromUser ?? false,
            timestamp: messageData.timestamp ?? Date.now(),
            session_id: messageData.sessionId,
            has_calification: messageData.hasCalification ?? false,
            calification_value: messageData.calificationValue ?? null,
            calification_added: messageData.calificationAdded ?? false,
            usuario_id: messageData.usuarioId ?? null,
            username: messageData.username ?? null,
            is_typing: messageData.isTyping ?? false,
            is_error: messageData.isError ?? false,
            is_graph_response: messageData.isGraphResponse ?? false,
            origin: messageData.origin ?? null,
        };

        const { data, error } = await this.client
            .from('chat_messages')
            .insert(payload)
            .select()
            .single();
        if (error) throw new Error(error.message);
        return this._mapToDomain(data);
    }

    async upsert(messageData) {
        const payload = {
            message: messageData.message,
            is_from_user: messageData.isFromUser ?? false,
            timestamp: messageData.timestamp ?? Date.now(),
            session_id: messageData.sessionId,
            has_calification: messageData.hasCalification ?? false,
            calification_value: messageData.calificationValue ?? null,
            calification_added: messageData.calificationAdded ?? false,
            usuario_id: messageData.usuarioId ?? null,
            username: messageData.username ?? null,
            is_typing: messageData.isTyping ?? false,
            is_error: messageData.isError ?? false,
            is_graph_response: messageData.isGraphResponse ?? false,
            origin: messageData.origin ?? null,
        };
        // If a remote id is provided, update the existing row; otherwise insert a new one.
        if (messageData.id && typeof messageData.id === 'number') {
            // Try to update by id first (only valid remote/Supabase ids)
            const { data: existing } = await this.client
                .from('chat_messages')
                .select('id')
                .eq('id', messageData.id)
                .maybeSingle();

            if (existing) {
                const { data, error } = await this.client
                    .from('chat_messages')
                    .update(payload)
                    .eq('id', messageData.id)
                    .select()
                    .single();
                if (error) throw new Error(error.message);
                return this._mapToDomain(data);
            }
        }

        // No existing row found (or no id provided) — insert without id
        const { data, error } = await this.client
            .from('chat_messages')
            .insert(payload)
            .select()
            .single();
        if (error) throw new Error(error.message);
        return this._mapToDomain(data);
    }

    async delete(id) {
        const { error } = await this.client
            .from('chat_messages')
            .delete()
            .eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    }

    async deleteBySession(sessionId) {
        const { error } = await this.client
            .from('chat_messages')
            .delete()
            .eq('session_id', sessionId);
        if (error) throw new Error(error.message);
        return true;
    }

    _mapToDomain(row) {
        if (!row) return null;
        return {
            id: row.id,
            message: row.message,
            isFromUser: row.is_from_user,
            timestamp: row.timestamp,
            sessionId: row.session_id,
            hasCalification: row.has_calification,
            calificationValue: row.calification_value,
            calificationAdded: row.calification_added,
            usuarioId: row.usuario_id,
            username: row.username,
            isTyping: row.is_typing,
            isError: row.is_error,
            isGraphResponse: row.is_graph_response,
            createdAt: row.created_at,
        };
    }
}

export default SupabaseChatMessageRepository;

