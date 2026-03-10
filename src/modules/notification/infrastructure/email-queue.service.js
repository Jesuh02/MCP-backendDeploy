/**
 * EmailQueueService — Gestor de cola de emails con control de rate limiting.
 *
 * Resuelve: 429 Too Many Requests (Resend límite: 2 requests/segundo)
 *
 * Estrategia:
 *  - Procesa emails secuencialmente con delays dinámicos
 *  - Exponential backoff ante errores de rate limit
 *  - Fire-and-forget: no bloquea la creación de cursos
 *  - Reintentos automáticos con jitter
 */

export class EmailQueueService {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.baseDelay = 600; // 600ms = 1.67 emails/segundo (bajo el límite de 2)
    }

    /**
     * Añade un email a la cola para procesamiento.
     * @param {Function} emailSender - Función async que envía el email
     * @param {Object} metadata - Información para logging
     */
    enqueue(emailSender, metadata = {}) {
        this.queue.push({
            sender: emailSender,
            metadata,
            retries: 0,
            maxRetries: 3
        });

        console.log(`[EmailQueueService] Email enqueued. Queue size: ${this.queue.length}`);
        // Iniciar procesamiento si no está activo
        if (!this.isProcessing) {
            this._processQueue();
        }
    }

    /**
     * Procesa la cola de emails con control de rate limiting.
     * @private
     */
    async _processQueue() {
            if (this.isProcessing) return;
            this.isProcessing = true;

            while (this.queue.length > 0) {
                const job = this.queue.shift();

                try {
                    await job.sender();
                    console.log(`[EmailQueueService] ✅ Email sent. Remaining: ${this.queue.length}`);
                } catch (error) {
                    const isRateLimit = error.name === 'rate_limit_exceeded' || error.statusCode === 429;

                if (isRateLimit && job.retries < job.maxRetries) {
                    // Reintentar con backoff exponencial + jitter
                    job.retries++;
                    const backoffDelay = this.baseDelay * Math.pow(2, job.retries) + Math.random() * 1000;
                    console.warn(
                        `[EmailQueueService] ⚠️ Rate limit. Retry ${job.retries}/${job.maxRetries} after ${Math.round(backoffDelay)}ms`
                    );

                    // Volver a encolar al principio para reintentar
                    this.queue.unshift(job);
                    await this._delay(backoffDelay);
                    continue;
                }

                console.error(
                    `[EmailQueueService] ❌ Failed to send email${job.retries >= job.maxRetries ? ' (max retries reached)' : ''}:`,
                    error.message
                );
            }

            // Esperar baseDelay entre emails para respetar rate limit
            if (this.queue.length > 0) {
                await this._delay(this.baseDelay);
            }
        }

        this.isProcessing = false;
        console.log('[EmailQueueService] ✅ Queue processing completed');
    }

    /**
     * Delay util - espera N milisegundos.
     * @private
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Obtiene la cantidad de emails en la cola.
     */
    getQueueSize() {
        return this.queue.length;
    }

    /**
     * Obtiene el estado del servicio.
     */
    getStatus() {
        return {
            isProcessing: this.isProcessing,
            queueSize: this.queue.length,
            baseDelay: this.baseDelay
        };
    }
}

export default EmailQueueService;
