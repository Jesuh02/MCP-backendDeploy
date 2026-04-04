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

    async findBySession(sessionId, { offset = 0, limit = 500 } = {}) {
        const { data, error } = await this.client
            .from('chat_messages')
            .select('*')
            .eq('session_id', sessionId)
            .order('timestamp', { ascending: true })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return (data || []).map(row => this._mapToDomain(row));
    }

    async findByUser(usuarioId, { offset = 0, limit = 200 } = {}) {
        const { data, error } = await this.client
            .from('chat_messages')
            .select('*')
            .eq('usuario_id', usuarioId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) throw new Error(error.message);
        return (data || []).map(row => this._mapToDomain(row));
    }

    async findByUserAndOrigin(usuarioId, origin, { offset = 0, limit = 500 } = {}) {
        const { data, error } = await this.client
            .from('chat_messages')
            .select('*')
            .eq('usuario_id', usuarioId)
            .eq('origin', origin)
            .order('timestamp', { ascending: true })
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
            calification_value: messageData.calificationValue != null ? Number(messageData.calificationValue) : null,
            calification_added: messageData.calificationAdded ?? false,
            usuario_id: messageData.usuarioId ?? null,
            username: messageData.username ?? null,
            origin: messageData.origin ?? null,
            submission_id: messageData.submissionId ?? null,
            excel_url: messageData.excelUrl ?? null,
            attached_file_url: messageData.attachedFileUrl ?? null,
            attached_file_name: messageData.attachedFileName ?? null,
            attached_file_type: messageData.attachedFileType ?? null,
            sender_avatar: messageData.senderAvatar ?? null,
        };

        // Optional columns — only include if set
        if (messageData.waMessageId != null) payload.wa_message_id = messageData.waMessageId;
        if (messageData.isTyping) payload.is_typing = true;
        if (messageData.isError) payload.is_error = true;
        if (messageData.isGraphResponse) payload.is_graph_response = true;
        if (messageData.messageType && messageData.messageType !== 'text') payload.message_type = messageData.messageType;
        if (messageData.status && messageData.status !== 'sent') payload.status = messageData.status;

        const { data, error } = await this.client
            .from('chat_messages')
            .insert(payload)
            .select()
            .single();
        if (error) throw new Error(`chat_messages insert failed: ${error.message} (code=${error.code})`);
        return this._mapToDomain(data);
    }

    async upsert(messageData) {
        // Build payload with only the core columns that always exist.
        // Optional columns (is_typing, is_error, is_graph_response, message_type, status)
        // are added only when their values are non-default to avoid failures on tenants
        // whose schema may not include them yet.
        const payload = {
            message: messageData.message,
            is_from_user: messageData.isFromUser ?? false,
            timestamp: messageData.timestamp ?? Date.now(),
            session_id: messageData.sessionId,
            has_calification: messageData.hasCalification ?? false,
            calification_value: messageData.calificationValue != null ? Number(messageData.calificationValue) : null,
            calification_added: messageData.calificationAdded ?? false,
            usuario_id: messageData.usuarioId ?? null,
            username: messageData.username ?? null,
            origin: messageData.origin ?? null,
            submission_id: messageData.submissionId ?? null,
            excel_url: messageData.excelUrl ?? null,
            attached_file_url: messageData.attachedFileUrl ?? null,
            attached_file_name: messageData.attachedFileName ?? null,
            attached_file_type: messageData.attachedFileType ?? null,
            sender_avatar: messageData.senderAvatar ?? null,
        };

        // Optional columns — only include if the caller set them so that tenants
        // missing these columns are not affected.
        if (messageData.waMessageId != null) payload.wa_message_id = messageData.waMessageId;
        if (messageData.isTyping) payload.is_typing = true;
        if (messageData.isError) payload.is_error = true;
        if (messageData.isGraphResponse) payload.is_graph_response = true;
        if (messageData.messageType && messageData.messageType !== 'text') payload.message_type = messageData.messageType;
        if (messageData.status && messageData.status !== 'sent') payload.status = messageData.status;

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
                if (error) throw new Error(`chat_messages update failed: ${error.message} (code=${error.code})`);
                return this._mapToDomain(data);
            }
        }

        // No existing row found (or no id provided) — insert without id.
        const { data, error } = await this.client
            .from('chat_messages')
            .insert(payload)
            .select()
            .single();

        if (!error) return this._mapToDomain(data);

        // Code 23505 = duplicate primary key. This happens when the identity sequence is
        // behind the table's actual max id (e.g. after a bulk data import / migration ran
        // with OVERRIDING SYSTEM VALUE). Attempt to repair the sequence and retry once.
        if (error.code === '23505' && error.message.includes('chat_messages_pkey')) {
            console.warn('[ChatRepo] pkey conflict on insert — attempting sequence repair…');
            await this._repairIdentitySequence();

            const { data: retryData, error: retryError } = await this.client
                .from('chat_messages')
                .insert(payload)
                .select()
                .single();
            if (!retryError) return this._mapToDomain(retryData);
            throw new Error(`chat_messages insert failed: ${retryError.message} (code=${retryError.code})`);
        }

        throw new Error(`chat_messages insert failed: ${error.message} (code=${error.code})`);
    }

    /**
     * Resets the identity sequence for chat_messages.id to max(id)+1 so that
     * auto-generated values no longer collide with existing rows.
     * Uses the execute_sql RPC that is already deployed in the tenant database.
     */
    async _repairIdentitySequence() {
        try {
            const sql = `
                SELECT setval(
                    pg_get_serial_sequence('public.chat_messages', 'id'),
                    COALESCE((SELECT MAX(id) FROM public.chat_messages), 0) + 1,
                    false
                )`.trim();
            const { error } = await this.client.rpc('execute_sql', { query: sql });
            if (error) {
                // pg_get_serial_sequence may return NULL for GENERATED ALWAYS AS IDENTITY
                // on some PostgreSQL versions. Fall back to looking up the sequence directly.
                const fallbackSql = `
                    SELECT setval(
                        (
                            SELECT pg_catalog.quote_ident(ns.nspname) || '.' || pg_catalog.quote_ident(seq.relname)
                            FROM pg_class seq
                            JOIN pg_depend d     ON d.objid = seq.oid
                            JOIN pg_class tbl   ON tbl.oid = d.refobjid
                            JOIN pg_namespace ns ON ns.oid = seq.relnamespace
                            JOIN pg_attribute attr
                                ON attr.attrelid = d.refobjid AND attr.attnum = d.refobjsubid
                            WHERE tbl.relname = 'chat_messages'
                              AND attr.attname = 'id'
                              AND seq.relkind  = 'S'
                        ),
                        COALESCE((SELECT MAX(id) FROM public.chat_messages), 0) + 1,
                        false
                    )`.trim();
                await this.client.rpc('execute_sql', { query: fallbackSql });
            }
            console.warn('[ChatRepo] chat_messages identity sequence repaired successfully.');
        } catch (e) {
            console.warn('[ChatRepo] Sequence auto-repair failed (will be retried next insert):', e.message);
        }
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
            origin: row.origin,
            waMessageId: row.wa_message_id,
            messageType: row.message_type,
            status: row.status,
            submissionId: row.submission_id,
            excelUrl: row.excel_url,
            attachedFileUrl: row.attached_file_url,
            attachedFileName: row.attached_file_name,
            attachedFileType: row.attached_file_type,
            senderAvatar: row.sender_avatar,
            createdAt: row.created_at,
        };
    }
}

export default SupabaseChatMessageRepository;

