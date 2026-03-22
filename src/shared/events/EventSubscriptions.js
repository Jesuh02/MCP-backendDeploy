/**
 * EventSubscriptions — Registra los handlers de eventos de dominio.
 *
 * Se ejecuta al crear el container para conectar los eventos de dominio
 * con los servicios que reaccionan a ellos, eliminando dependencias circulares.
 *
 * Antes:  courseService.setNotificationService(notificationService) ← setter injection smell
 * Ahora:  eventBus.subscribe('CourseCreated', handler) ← desacoplado
 */
import { eventBus } from './EventBus.js';

/**
 * @param {object} deps — Servicios del container necesarios para handlers.
 */
export function registerEventSubscriptions(deps) {
    const {
        notificationService,
        courseNotificationService,
        progressService,
        userService,
    } = deps;

    // ── CourseCreated → Notificar suscriptores ──
    eventBus.subscribe('CourseCreated', async(event) => {
        const { course, creatorUserId } = event.payload;
        if (courseNotificationService) {
            await courseNotificationService.notifySubscribersAboutNewCourse(course, creatorUserId).catch(err =>
                console.warn('[EventSubscription:CourseCreated] Notification failed:', err.message)
            );
        }
    });

    // ── StudentEnrolled → Notificar al creador ──
    eventBus.subscribe('StudentEnrolled', async(event) => {
        const { userId, courseId } = event.payload;
        if (notificationService) {
            await notificationService.send(null, {
                title: 'Nuevo estudiante inscrito',
                message: `Un estudiante se inscribió al curso #${courseId}`,
                type: 'enrollment_approved',
                relatedId: courseId,
                metadata: { courseId, studentUserId: userId },
            }).catch(err =>
                console.warn('[EventSubscription:StudentEnrolled] Notification failed:', err.message)
            );
        }
    });

    // ── TaskGraded → Notificar al estudiante ──
    eventBus.subscribe('TaskGraded', async(event) => {
        const { submission, grade, feedback, gradedBy } = event.payload;
        if (notificationService && submission ? .userId) {
            await notificationService.send(submission.userId, {
                title: 'Tarea calificada',
                message: `Tu tarea fue calificada con ${grade}`,
                type: 'task_graded',
                relatedId: submission.taskId,
                metadata: { grade, feedback, gradedBy, courseId: submission.courseId },
            }).catch(err =>
                console.warn('[EventSubscription:TaskGraded] Notification failed:', err.message)
            );
        }
    });

    // ── PaymentConfirmed → Otorgar acceso ──
    eventBus.subscribe('PaymentConfirmed', async(event) => {
        const { userId, courseId } = event.payload;
        if (progressService && typeof progressService.grantAccess === 'function') {
            await progressService.grantAccess(userId, courseId).catch(err =>
                console.warn('[EventSubscription:PaymentConfirmed] Grant access failed:', err.message)
            );
        }
    });

    // ── VideoUploaded → Notificar suscriptores del curso ──
    eventBus.subscribe('VideoUploaded', async(event) => {
        const { video, courseId, uploadedBy } = event.payload;
        if (notificationService) {
            await notificationService.send(null, {
                title: 'Nuevo video subido',
                message: `Se subió un nuevo video al curso #${courseId}`,
                type: 'new_video',
                relatedId: courseId,
                metadata: { videoId: video ? .id, courseId, uploadedBy },
            }).catch(err =>
                console.warn('[EventSubscription:VideoUploaded] Notification failed:', err.message)
            );
        }
    });

    console.log('✅ EventBus: Domain event subscriptions registered');
}

export default registerEventSubscriptions;