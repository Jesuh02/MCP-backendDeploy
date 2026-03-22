/**
 * CircuitBreaker — Patrón Circuit Breaker para adaptadores externos.
 *
 * Protege contra servicios externos lentos o caídos (OpenAI, FCM, Wompi, etc.).
 * Si un adaptador falla N veces consecutivas, el circuito se "abre" y rechaza
 * llamadas inmediatamente durante un período de timeout, evitando que las
 * peticiones del servidor cuelguen.
 *
 * Estados:
 *   CLOSED  → Todo funciona, las llamadas pasan al servicio real.
 *   OPEN    → Servicio caído, se rechaza inmediatamente con fallback.
 *   HALF_OPEN → Tras timeout, permite UNA llamada de prueba para ver si se recuperó.
 *
 * Uso:
 *   const cb = new CircuitBreaker(openai.complete.bind(openai), { threshold: 3, timeout: 30000 });
 *   const result = await cb.execute(prompt);
 */
import { logger } from '../logging/Logger.js';

const STATE = {
    CLOSED: 'CLOSED',
    OPEN: 'OPEN',
    HALF_OPEN: 'HALF_OPEN',
};

export class CircuitBreaker {
    /**
     * @param {Function} fn — Función async a proteger.
     * @param {object} [options]
     * @param {number} [options.threshold=5] — Fallos consecutivos para abrir el circuito.
     * @param {number} [options.timeout=30000] — Tiempo en ms que permanece abierto antes de probar.
     * @param {string} [options.name='CircuitBreaker'] — Nombre para logging.
     * @param {Function} [options.fallback] — Función fallback cuando el circuito está abierto.
     */
    constructor(fn, { threshold = 5, timeout = 30000, name = 'CircuitBreaker', fallback } = {}) {
        this._fn = fn;
        this._threshold = threshold;
        this._timeout = timeout;
        this._name = name;
        this._fallback = fallback || null;
        this._state = STATE.CLOSED;
        this._failureCount = 0;
        this._lastFailureTime = 0;
        this._successCount = 0;
    }

    get state() {
        return this._state;
    }

    /**
     * Ejecuta la función protegida por el circuit breaker.
     * @param {...any} args — Argumentos para la función.
     * @returns {Promise<any>}
     */
    async execute(...args) {
        if (this._state === STATE.OPEN) {
            // Check if timeout has elapsed → transition to HALF_OPEN
            if (Date.now() - this._lastFailureTime >= this._timeout) {
                this._state = STATE.HALF_OPEN;
                logger.debug(`[${this._name}] Circuit → HALF_OPEN (testing recovery)`);
            } else {
                logger.warn(`[${this._name}] Circuit OPEN — rejecting call`);
                if (this._fallback) return this._fallback(...args);
                throw new CircuitBreakerOpenError(this._name, this._timeout - (Date.now() - this._lastFailureTime));
            }
        }

        try {
            const result = await this._fn(...args);
            this._onSuccess();
            return result;
        } catch (err) {
            this._onFailure();
            throw err;
        }
    }

    /** @private */
    _onSuccess() {
        if (this._state === STATE.HALF_OPEN) {
            logger.info(`[${this._name}] Circuit → CLOSED (service recovered)`);
        }
        this._failureCount = 0;
        this._successCount++;
        this._state = STATE.CLOSED;
    }

    /** @private */
    _onFailure() {
        this._failureCount++;
        this._lastFailureTime = Date.now();

        if (this._failureCount >= this._threshold) {
            this._state = STATE.OPEN;
            logger.error(`[${this._name}] Circuit → OPEN after ${this._failureCount} consecutive failures`);
        }
    }

    /**
     * Resetea el estado del circuit breaker.
     */
    reset() {
        this._state = STATE.CLOSED;
        this._failureCount = 0;
        this._lastFailureTime = 0;
    }

    /**
     * Información de estado para health checks.
     */
    getStatus() {
        return {
            name: this._name,
            state: this._state,
            failureCount: this._failureCount,
            threshold: this._threshold,
            timeout: this._timeout,
            lastFailureTime: this._lastFailureTime ? new Date(this._lastFailureTime).toISOString() : null,
        };
    }
}

/**
 * Error específico cuando el circuito está abierto.
 */
export class CircuitBreakerOpenError extends Error {
    constructor(name, retryAfterMs) {
        super(`Circuit breaker '${name}' is OPEN — service unavailable`);
        this.name = 'CircuitBreakerOpenError';
        this.statusCode = 503;
        this.retryAfterMs = retryAfterMs;
    }
}

/**
 * Factory: wrappea un objeto/adaptador completo con circuit breaker en todos sus métodos async.
 *
 * @param {object} adapter — Adaptador a proteger.
 * @param {object} [options] — Opciones del circuit breaker.
 * @returns {object} — Proxy con circuit breaker en cada método.
 */
export function withCircuitBreaker(adapter, options = {}) {
    const name = options.name || adapter?.constructor?.name || 'Adapter';
    const cb = new CircuitBreaker(async() => {}, { ...options, name });

    return new Proxy(adapter, {
        get(target, prop) {
            const val = target[prop];
            if (typeof val !== 'function') return val;

            // Skip private methods and non-async utility methods
            if (typeof prop === 'string' && prop.startsWith('_')) return val.bind(target);

            return async(...args) => {
                if (cb.state === 'OPEN') {
                    if (Date.now() - cb._lastFailureTime >= cb._timeout) {
                        cb._state = 'HALF_OPEN';
                    } else {
                        throw new CircuitBreakerOpenError(name, cb._timeout - (Date.now() - cb._lastFailureTime));
                    }
                }

                try {
                    const result = await val.apply(target, args);
                    cb._onSuccess();
                    return result;
                } catch (err) {
                    cb._onFailure();
                    throw err;
                }
            };
        }
    });
}

export default CircuitBreaker;