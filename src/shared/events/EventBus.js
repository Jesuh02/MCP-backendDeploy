/**
 * EventBus — Implementación simple de bus de eventos de dominio (in-process).
 *
 * Permite desacoplar servicios que actualmente usan setter injection
 * para resolver dependencias circulares (ej: CourseService → NotificationService → CourseService).
 *
 * Los servicios emiten eventos de dominio y los listeners reaccionan sin acoplamiento directo.
 *
 * Uso:
 *   eventBus.publish(new CourseCreatedEvent(course));
 *   eventBus.subscribe('CourseCreated', handler);
 */
import { logger } from '../logging/Logger.js';

class EventBusImpl {
    constructor() {
        /** @type {Map<string, Array<Function>>} */
        this._listeners = new Map();
    }

    /**
     * Suscribe un handler a un tipo de evento.
     * @param {string} eventType — Nombre del evento (ej: 'CourseCreated').
     * @param {Function} handler — Función async (eventData) => void.
     */
    subscribe(eventType, handler) {
            if (!this._listeners.has(eventType)) {
                this._listeners.set(eventType, []);
            }
            this._listeners.get(eventType).push(handler);
            logger.debug(`[EventBus] Subscribed to '${eventType}'`);
        }
        /**
         * Publica un evento. Ejecuta todos los handlers suscritos de forma fire-and-forget.
         * Los errores en handlers individuales NO propagan al emisor.
         *
         * @param {DomainEvent} event — Instancia de evento de dominio.
         */
    async publish(event) {
            const eventType = event.type || event.constructor?.name || 'UnknownEvent';
            const handlers = this._listeners.get(eventType) || [];

            if (handlers.length === 0) {
                logger.debug(`[EventBus] No listeners for '${eventType}'`);
                return;
            }
            logger.debug(`[EventBus] Publishing '${eventType}' to ${handlers.length} listener(s)`);

            for (const handler of handlers) {
                try {
                    await handler(event);
                } catch (err) {
                    logger.error(`[EventBus] Handler error for '${eventType}': ${err.message}`);
                }
            }
        }
        /**
         * Elimina todas las suscripciones (útil para tests).
         */
    clear() {
        this._listeners.clear();
    }
}

// Singleton
export const eventBus = new EventBusImpl();

/**
 * Clase base para eventos de dominio.
 */
export class DomainEvent {
    /**
     * @param {string} type — Tipo del evento.
     * @param {object} payload — Datos del evento.
     */
    constructor(type, payload = {}) {
        this.type = type;
        this.payload = payload;
        this.occurredAt = new Date().toISOString();
        this.id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
}

// ── Eventos de Dominio concretos ──────────────────────────────

export class CourseCreatedEvent extends DomainEvent {
    constructor(course, creatorUserId) {
        super('CourseCreated', { course, creatorUserId });
    }
}

export class CourseUpdatedEvent extends DomainEvent {
    constructor(course, updatedBy) {
        super('CourseUpdated', { course, updatedBy });
    }
}

export class StudentEnrolledEvent extends DomainEvent {
    constructor({ userId, courseId }) {
        super('StudentEnrolled', { userId, courseId });
    }
}

export class TaskSubmittedEvent extends DomainEvent {
    constructor({ submission, taskId, courseId, userId }) {
        super('TaskSubmitted', { submission, taskId, courseId, userId });
    }
}

export class TaskGradedEvent extends DomainEvent {
    constructor({ submission, grade, feedback, gradedBy }) {
        super('TaskGraded', { submission, grade, feedback, gradedBy });
    }
}

export class PaymentConfirmedEvent extends DomainEvent {
    constructor({ transaction, userId, courseId }) {
        super('PaymentConfirmed', { transaction, userId, courseId });
    }
}

export class CollaboratorAddedEvent extends DomainEvent {
    constructor({ collaborator, courseId, addedBy }) {
        super('CollaboratorAdded', { collaborator, courseId, addedBy });
    }
}

export class VideoUploadedEvent extends DomainEvent {
    constructor({ video, courseId, uploadedBy }) {
        super('VideoUploaded', { video, courseId, uploadedBy });
    }
}

export default { eventBus, DomainEvent, CourseCreatedEvent, CourseUpdatedEvent, StudentEnrolledEvent, TaskSubmittedEvent, TaskGradedEvent, PaymentConfirmedEvent, CollaboratorAddedEvent, VideoUploadedEvent };