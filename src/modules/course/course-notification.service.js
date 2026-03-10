/**
 * CourseNotificationService — Servicio especializado para notificaciones relacionadas con cursos.
 *
 * Principios SOLID:
 *  - Single Responsibility: solo maneja notificaciones de cursos
 *  - Dependency Inversion: depende de puertos abstractos (repositorios y servicios)
 *  - Separation of Concerns: lógica de notificación separada del servicio de dominio de cursos
 *
 * Arquitectura Hexagonal:
 *  - Depende de puertos de salida: subscriptionRepository, notificationService, userService
 *  - Puede ser utilizado por múltiples adaptadores (API HTTP, eventos, etc.)
 *
 * Rate Limiting:
 *  - Usa EmailQueueService para respetar límite de Resend (2 requests/seg)
 *  - Backoff exponencial automático ante errores 429
 *  - Fire-and-forget: no bloquea la creación del curso
 */

import { Result } from '../../shared/Result.js';
import { generateNewCourseEmailHTML } from '../../templates/emailTemplates.js';

export class CourseNotificationService {
    constructor({ subscriptionRepository, notificationService, userService, emailQueueService }) {
        this.subscriptionRepo = subscriptionRepository;
        this.notificationService = notificationService;
        this.userService = userService;
        this.emailQueue = emailQueueService;
    }

    /**
     * Notifica a todos los suscriptores de un creador sobre un nuevo curso.
     * Envía notificaciones push en la app y emails a la bandeja.
     *
     * @param {Object} course - Datos del curso recién creado
     * @param {number} creatorUserId - ID del usuario creador
     * @returns {Promise<Result>} Resultado de la operación
     */
    async notifySubscribersAboutNewCourse(course, creatorUserId) {
        try {
            // Validar entrada
            if (!course || !creatorUserId) {
                return Result.fail(new Error('El curso y el ID del creador son requeridos'));
            }

            // Obtener información del creador
            const creatorResult = await this._getCreatorInfo(creatorUserId);
            if (creatorResult.isFail()) {
                console.warn('[CourseNotificationService] No se pudo obtener info del creador:', creatorUserId);
                return Result.ok({ notifiedCount: 0, skipped: 0 });
            }

            const creator = creatorResult.getValue();

            // Obtener suscriptores del creador
            const subscribers = await this._getSubscribers(creatorUserId);
            if (!subscribers || subscribers.length === 0) {
                console.log(`[CourseNotificationService] No hay suscriptores para el creador ${creatorUserId}`);
                return Result.ok({ notifiedCount: 0, skipped: 0 });
            }

            let enqueuedCount = 0;
            let skippedCount = 0;

            // Encolar notificaciones para cada suscriptor
            for (const subscription of subscribers) {
                const subscriberId = subscription.subscriber_id || subscription.subscriberId;

                if (Number(subscriberId) === Number(creatorUserId)) {
                    skippedCount++;
                    continue;
                }

                try {
                    const subscriberResult = await this.userService.getById(subscriberId);
                    if (subscriberResult.isFail()) {
                        console.warn(`[CourseNotificationService] No se pudo obtener datos del suscriptor ${subscriberId}`);
                        skippedCount++;
                        continue;
                    }

                    const subscriber = subscriberResult.getValue();
                    const subscriberEmail = subscriber.email || subscriber.email_address;

                    if (!subscriberEmail) {
                        console.warn(`[CourseNotificationService] Suscriptor ${subscriberId} sin email`);
                        skippedCount++;
                        continue;
                    }

                    // Encolar el email para procesamiento asincrónico
                    this._enqueueNotification(subscriberId, subscriber, course, creator);
                    enqueuedCount++;
                } catch (error) {
                    console.warn(
                        `[CourseNotificationService] Error al preparar notificación para suscriptor ${subscriberId}:`,
                        error.message
                    );
                    skippedCount++;
                }
            }

            console.log(
                `[CourseNotificationService] 📧 Notificaciones encoladas: ${enqueuedCount}/${subscribers.length} (${skippedCount} skipped)`
            );
            return Result.ok({ notifiedCount: enqueuedCount, skipped: skippedCount });
        } catch (error) {
            console.error('[CourseNotificationService] Error en notifySubscribersAboutNewCourse:', error);
            return Result.fail(error);
        }
    }

    /**
     * Obtiene la información del creador.
     * @private
     */
    async _getCreatorInfo(creatorUserId) {
        return await this.userService.getById(creatorUserId);
    }

    /**
     * Obtiene los suscriptores de un creador.
     * @private
     */
    async _getSubscribers(creatorUserId) {
        return await this.subscriptionRepo.findByCreator(creatorUserId);
    }

    /**
     * Encola una notificación para un suscriptor.
     * @private
     */
    _enqueueNotification(subscriberId, subscriber, course, creator) {
        const creatorUsername = creator.username || 'Creador';
        const courseTitle = course.title || 'Nuevo Curso';
        const subscriberName = subscriber.name || subscriber.username || 'Estudiante';
        const subscriberEmail = subscriber.email || subscriber.email_address;

        // Función que se ejecutará en la cola
        const emailSender = async () => {
            // Generar contenido del email
            const htmlContent = generateNewCourseEmailHTML(
                subscriberName,
                creatorUsername,
                courseTitle,
                this._getThumbnailUrl(course)
            );

            // Enviar email a través de notificationService
            const emailResult = await this.notificationService.sendEmail(subscriberId, {
                subject: `📚 ${creatorUsername} ha publicado un nuevo curso: ${courseTitle}`,
                html: htmlContent,
                text: `${creatorUsername} ha publicado un nuevo curso: ${courseTitle}`
            });

            if (emailResult.isFail()) {
                throw new Error(`Falló enviar email a ${subscriberEmail}: ${emailResult.getError().message}`);
            }

            // Después del email, enviar notificación push (sin encolar)
            // Sin awaitar para no bloquear la cola
            this._sendPushNotification(subscriberId, course, creator).catch(err => {
                console.warn(`[CourseNotificationService] Error enviando push a ${subscriberId}:`, err.message);
            });
        };

        // Encolar en la cola de emails
        if (this.emailQueue) {
            this.emailQueue.enqueue(emailSender, {
                subscriberId,
                subscriberEmail,
                courseId: course.id,
                courseTitle
            });
        } else {
            console.warn('[CourseNotificationService] emailQueueService no disponible, enviando email directamente');
            emailSender().catch(err => {
                console.error('[CourseNotificationService] Error enviando email directo:', err.message);
            });
        }
    }

    /**
     * Envía notificación push al suscriptor.
     * @private
     */
    async _sendPushNotification(subscriberId, course, creator) {
        const creatorUsername = creator.username || 'Creador';
        const courseTitle = course.title || 'Nuevo Curso';

        return await this.notificationService.send(subscriberId, {
            title: '📚 Nuevo Curso',
            message: `${creatorUsername} publicó: ${courseTitle}`,
            type: 'new_course',
            relatedId: course.id,
            senderUsername: creatorUsername,
            senderAvatarUrl: creator.avatar_url || creator.avatarUrl || null,
            thumbnailUrl: this._getThumbnailUrl(course),
            metadata: { courseId: course.id, courseTitle },
            creatorUserId: creator.id
        });
    }

    /**
     * Extrae la URL de la miniatura del curso.
     * @private
     */
    _getThumbnailUrl(course) {
        return course.thumbnail_url || course.thumbnail_uri || course.thumbnailUri || null;
    }
}

export default CourseNotificationService;
