/**
 * SupabaseOutboxRepository — Persiste eventos de dominio en la tabla outbox_events.
 *
 * El patrón Outbox garantiza que el evento se grabe en la misma transacción
 * que el cambio de estado (ej: pago APPROVED + evento PaymentConfirmed).
 * Un proceso periódico (OutboxProcessor) lee los eventos pendientes y los
 * publica al EventBus, marcándolos como procesados.
 */
export class SupabaseOutboxRepository {
    constructor(client) {
            this.client = client;
        }
        /**
         * Inserta un evento en la outbox.
         * @param {{ eventType: string, payload: object }} event
         */
    async insert({ eventType, payload }) {
        const { error } = await this.client
            .from('outbox_events')
            .insert({ event_type: eventType, payload });
        if (error) throw new Error(`Outbox insert failed: ${error.message}`);
    }

    /**
     * Obtiene los eventos pendientes más antiguos.
     * @param {number} limit — Máximo de eventos a procesar por lote.
     */
    async fetchPending(limit = 50) {
        const { data, error } = await this.client
            .from('outbox_events')
            .select('*')
            .eq('status', 'pending')
            .lt('attempts', 5)
            .order('created_at', { ascending: true })
            .limit(limit);
        if (error) throw new Error(`Outbox fetch failed: ${error.message}`);
        return data || [];
    }

    /**
     * Marca un evento como procesado exitosamente.
     */
    async markProcessed(id) {
        const { error } = await this.client
            .from('outbox_events')
            .update({ status: 'processed', processed_at: new Date().toISOString() })
            .eq('id', id);
        if (error) throw new Error(`Outbox markProcessed failed: ${error.message}`);
    }

    /**
     * Marca un evento como fallido e incrementa el contador de intentos.
     */
    async markFailed(id, errorMsg) {
        const { data: current } = await this.client
            .from('outbox_events')
            .select('attempts')
            .eq('id', id)
            .single();

        const attempts = (current?.attempts || 0) + 1;
        const status = attempts >= 5 ? 'failed' : 'pending';

        const { error } = await this.client
            .from('outbox_events')
            .update({ status, attempts, error: errorMsg })
            .eq('id', id);
        if (error) throw new Error(`Outbox markFailed failed: ${error.message}`);
    }
}