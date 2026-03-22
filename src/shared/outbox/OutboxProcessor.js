/**
 * OutboxProcessor — Proceso periódico que lee eventos de la tabla outbox_events,
 * los publica al EventBus in-process y los marca como procesados.
 *
 * Garantiza entrega at-least-once: si el proceso se cae, los eventos
 * permanecen como 'pending' y se reintentan en el siguiente ciclo.
 *
 * Uso:
 *   const processor = new OutboxProcessor({ outboxRepo, eventBus });
 *   processor.start();          // arranca el polling
 *   processor.stop();           // detiene gracefully
 */
import { logger } from '../logging/Logger.js';
import { DomainEvent } from '../events/EventBus.js';

export class OutboxProcessor {
    /**
     * @param {{ outboxRepo: import('./SupabaseOutboxRepository.js').SupabaseOutboxRepository, eventBus: import('../events/EventBus.js').EventBusImpl }} deps
     * @param {{ intervalMs?: number, batchSize?: number }} opts
     */
    constructor({ outboxRepo, eventBus }, { intervalMs = 5000, batchSize = 50 } = {}) {
        this.outboxRepo = outboxRepo;
        this.eventBus = eventBus;
        this.intervalMs = intervalMs;
        this.batchSize = batchSize;
        this._timer = null;
        this._running = false;
    }

    /** Inicia el polling periódico. */
    start() {
        if (this._timer) return;
        logger.info(`[OutboxProcessor] Started (interval=${this.intervalMs}ms, batch=${this.batchSize})`);
        this._timer = setInterval(() => this._tick(), this.intervalMs);
        // Ejecutar inmediatamente la primera vez
        this._tick();
    }

    /** Detiene el polling. */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            logger.info('[OutboxProcessor] Stopped');
        }
    }

    /** Ciclo de procesamiento: lee pendientes y los publica. */
    async _tick() {
            if (this._running) return; // evitar overlap
            this._running = true;
            try {
                const events = await this.outboxRepo.fetchPending(this.batchSize);
                if (events.length === 0) {
                    this._running = false;
                    return;
                }

                logger.debug(`[OutboxProcessor] Processing ${events.length} outbox event(s)`);

                for (const row of events) {
                try {
                    const domainEvent = new DomainEvent(row.event_type, row.payload);
                    domainEvent.id = `outbox-${row.id}`;
                    domainEvent.occurredAt = row.created_at;

                    await this.eventBus.publish(domainEvent);
                    await this.outboxRepo.markProcessed(row.id);
                } catch (err) {
                    logger.error(`[OutboxProcessor] Failed event id=${row.id}: ${err.message}`);
                    await this.outboxRepo.markFailed(row.id, err.message);
                }
            }
        } catch (err) {
            logger.error(`[OutboxProcessor] Tick error: ${err.message}`);
        } finally {
            this._running = false;
        }
    }
}
