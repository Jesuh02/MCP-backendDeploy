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
 */

import { Result } from '../../shared/Result.js';
import { generateNewCourseEmailHTML } from '../../templates/emailTemplates.js';

export class CourseNotificationService {
    constructor({ subscriptionRepository, notificationService, userService }) {
        this.subscriptionRepo = subscriptionRepository;
        this.notificationService = notificationService;
        this.userService = userService;
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

                let notifiedCount = 0;
                let skippedCount = 0;

                // Notificar a cada suscriptor
                for (const subscription of subscribers) {
                    const subscriberId = subscription.subscriber_id || subscription.subscriberId;

                    try {
                        await this._notifySubscriber(subscriberId, course, creator);
                        notifiedCount++;
                    } catch (error) {
                    console.warn(
                        `[CourseNotificationService] Error notificando a suscriptor ${subscriberId}:`,
                        error.message
                    );
                    skippedCount++;
                }
            }

            console.log(
                `[CourseNotificationService] Notificaciones enviadas: ${notifiedCount}/${subscribers.length}`
            );
            return Result.ok({ notifiedCount, skipped: skippedCount });
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
     * Notifica a un suscriptor específico sobre el nuevo curso.
     * @private
     */
    async _notifySubscriber(subscriberId, course, creator) {
        // Obtener datos del suscriptor
        const subscriberResult = await this.userService.getById(subscriberId);
        if (subscriberResult.isFail()) {
            throw new Error(`No se pudo obtener datos del suscriptor ${subscriberId}`);
        }

        const subscriber = subscriberResult.getValue();
        const subscriberEmail = subscriber.email || subscriber.email_address;
        const subscriberName = subscriber.name || subscriber.username || 'Estudiante';

        if (!subscriberEmail) {
            console.warn(`[CourseNotificationService] Suscriptor ${subscriberId} sin email`);
            throw new Error(`No email for subscriber ${subscriberId}`);
        }

        const creatorUsername = creator.username || 'Creador';
        const courseTitle = course.title || 'Nuevo Curso';

        // Generar contenido del email
        const htmlContent = generateNewCourseEmailHTML(
            subscriberName,
            creatorUsername,
            courseTitle,
            this._getThumbnailUrl(course)
        );

        // Enviar email (desde coursev@yisuscompany.com)
        const emailResult = await this.notificationService.sendEmail(subscriberId, {
            subject: `📚 ${creatorUsername} ha publicado un nuevo curso: ${courseTitle}`,
            html: htmlContent,
            text: `${creatorUsername} ha publicado un nuevo curso: ${courseTitle}`
        });

        if (emailResult.isFail()) {
            throw new Error(`Falló al enviar email a ${subscriberEmail}`);
        }

        // Enviar notificación push (en la app)
        await this.notificationService.send(subscriberId, {
            title: '📚 Nuevo Curso',
            message: `${creatorUsername} publicó: ${courseTitle}`,
            type: 'new_course',
            relatedId: course.id,
            senderUsername: creatorUsername,
            senderAvatarUrl: creator.avatar_url || creator.avatarUrl || null,
            thumbnailUrl: this._getThumbnailUrl(course),
            metadata: { courseId: course.id, courseTitle }
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
