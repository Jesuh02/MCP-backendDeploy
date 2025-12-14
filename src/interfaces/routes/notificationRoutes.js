/**
 * notificationRoutes.js
 * Rutas de API para envío de notificaciones (Push y Email)
 * 
 * @description Define los endpoints REST para el sistema de notificaciones
 * Incluye: creación de cursos, calificaciones, videos, chat y genéricas
 */

import express from 'express';
import axios from 'axios';
import { SupabaseService } from '../../infrastructure/database/SupabaseService.js';
import { NotificationService } from '../../services/NotificationService.js';
import { 
    generateGradeEmailHTML, 
    generateGradeModifiedEmailHTML, 
    generateNewCourseEmailHTML,
    generateGenericEmailHTML 
} from '../../templates/emailTemplates.js';

const router = express.Router();

// Get service instances
const supabaseService = SupabaseService.getInstance();
const notificationService = NotificationService.getInstance();

/**
 * 📢 Notifica a los suscriptores cuando un creador publica un nuevo curso
 * POST /notify-course-creation
 * Body: { creatorUserId, creatorUsername, courseId, courseTitle, courseThumbnailUrl }
 */
router.post('/notify-course-creation', async (req, res) => {
    try {
        const { creatorUserId, creatorUsername, courseId, courseTitle, courseThumbnailUrl } = req.body;

        if (!creatorUserId || !courseId) {
            return res.status(400).json({ error: 'Missing required fields: creatorUserId, courseId' });
        }

        console.log(`📢 Course creation notification: User ${creatorUserId} created course "${courseTitle}"`);

        // 1. Fetch subscribers from Supabase
        const { data: subscriptions, error: subError } = await supabaseService.client
            .from('subscriptions')
            .select('subscriber_id')
            .eq('subscribed_to_id', creatorUserId);

        if (subError) {
            throw new Error(`Error fetching subscriptions: ${subError.message}`);
        }

        const subscribers = subscriptions || [];
        console.log(`Found ${subscribers.length} subscribers for user ${creatorUserId}`);

        if (subscribers.length === 0) {
            return res.json({ message: 'No subscribers to notify', notificationsSent: 0 });
        }

        // 2. Get subscriber details (username, email)
        const subscriberIds = subscribers.map(s => s.subscriber_id);
        const { data: users, error: usersError } = await supabaseService.client
            .from('usuarios')
            .select('id, username, email')
            .in('id', subscriberIds);

        if (usersError) {
            throw new Error(`Error fetching users: ${usersError.message}`);
        }

        // 3. Create notification records + send emails
        let successCount = 0;

        for (const user of (users || [])) {
            try {
                // Create in-app notification
                await supabaseService.client
                    .from('notifications')
                    .insert({
                        user_id: user.id,
                        type: 'new_course',
                        title: `${creatorUsername || 'Un creador'} subió un nuevo curso`,
                        message: `${courseTitle || 'Nuevo curso disponible'}`,
                        sender_username: creatorUsername,
                        thumbnail_url: courseThumbnailUrl,
                        related_id: courseId,
                        is_read: false
                    });

                // Send email with Resend
                if (user.email && process.env.RESEND_API_KEY) {
                    try {
                        const emailHTML = generateNewCourseEmailHTML({
                            subscriberName: user.username,
                            creatorName: creatorUsername,
                            courseTitle: courseTitle,
                            thumbnailUrl: courseThumbnailUrl
                        });

                        await axios.post('https://api.resend.com/emails', {
                            from: 'CourseV <CourseV@yisuscompany.com>',
                            to: user.email,
                            subject: `📚 ¡${creatorUsername} publicó un nuevo curso!`,
                            html: emailHTML
                        }, {
                            headers: {
                                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                                'Content-Type': 'application/json'
                            }
                        });
                        console.log(`✅ Email sent to ${user.email}`);
                    } catch (emailError) {
                        console.warn(`⚠️ Failed to send email to ${user.email}:`, emailError.message);
                    }
                }

                // Send push notification
                await notificationService.sendPushNotification(
                    user.id,
                    '📚 ¡Nuevo curso disponible!',
                    `${creatorUsername} publicó: ${courseTitle}`,
                    { type: 'new_course', courseId: courseId.toString() }
                );

                successCount++;
            } catch (error) {
                console.error(`Error notifying user ${user.id}:`, error.message);
            }
        }

        res.json({
            message: 'Notifications sent',
            notificationsSent: successCount,
            totalSubscribers: users?.length || 0
        });

    } catch (error) {
        console.error('Error in notify-course-creation:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 📊 Notifica al ESTUDIANTE cuando recibe una calificación en su tarea
 * POST /notify-grade
 * Body: { studentId, taskName, grade, feedback, gradedByUsername, oldGrade, oldFeedback, isModification }
 */
router.post('/notify-grade', async (req, res) => {
    const { studentId, taskName, grade, feedback, gradedByUsername, oldGrade, oldFeedback, isModification } = req.body;

    if (!studentId || !taskName || grade === undefined) {
        return res.status(400).json({ error: 'studentId, taskName y grade son requeridos' });
    }

    const isUpdate = isModification === true || (oldGrade !== undefined && oldGrade !== null);

    console.log(`📊 Notificando calificación al estudiante ${studentId}`);
    console.log(`   📝 Tarea: ${taskName}`);
    console.log(`   📈 Nota: ${grade}/10 ${isUpdate ? `(anterior: ${oldGrade}/10)` : '(nueva)'}`);

    try {
        // 1. Obtener información del estudiante
        const { data: student, error: studentError } = await supabaseService.client
            .from('usuarios')
            .select('id, email, username')
            .eq('id', studentId)
            .single();

        if (studentError || !student) {
            console.error(`❌ Estudiante ${studentId} no encontrado:`, studentError?.message);
            return res.status(404).json({ error: 'Estudiante no encontrado' });
        }

        console.log(`✅ Estudiante encontrado: ${student.username} (${student.email})`);

        // 2. Preparar contenido de la notificación
        const gradeFormatted = typeof grade === 'number' ? grade.toFixed(1) : grade;
        const gradeEmoji = grade >= 9 ? '🏆' : grade >= 7 ? '⭐' : grade >= 5 ? '✅' : '📚';

        let emailSubject, emailHTML, pushTitle, pushBody, notificationType;

        if (isUpdate) {
            // Calificación MODIFICADA
            const oldGradeFormatted = typeof oldGrade === 'number' ? oldGrade.toFixed(1) : oldGrade;
            const gradeImproved = parseFloat(grade) > parseFloat(oldGrade);
            const changeEmoji = gradeImproved ? '📈' : parseFloat(grade) < parseFloat(oldGrade) ? '📉' : '🔄';

            emailSubject = `${changeEmoji} Tu calificación en "${taskName}" ha sido actualizada`;
            emailHTML = generateGradeModifiedEmailHTML({
                studentName: student.username,
                taskTitle: taskName,
                previousGrade: oldGrade,
                newGrade: grade,
                previousFeedback: oldFeedback,
                newFeedback: feedback,
                gradedBy: gradedByUsername
            });
            pushTitle = `${changeEmoji} Calificación actualizada: ${oldGradeFormatted} → ${gradeFormatted}`;
            pushBody = `Tu nota en "${taskName}" cambió de ${oldGradeFormatted} a ${gradeFormatted}`;
            notificationType = 'grade_modified';
        } else {
            // Nueva calificación
            emailSubject = `${gradeEmoji} ¡Tu tarea "${taskName}" ha sido calificada!`;
            emailHTML = generateGradeEmailHTML({
                studentName: student.username,
                taskTitle: taskName,
                grade: grade,
                feedback: feedback,
                gradedBy: gradedByUsername
            });
            pushTitle = `${gradeEmoji} Tarea calificada: ${gradeFormatted}/10`;
            pushBody = `Tu tarea "${taskName}" ha sido evaluada${gradedByUsername ? ` por ${gradedByUsername}` : ''}`;
            notificationType = 'grade';
        }

        // 3. Enviar Email al estudiante
        if (student.email && process.env.RESEND_API_KEY) {
            try {
                await axios.post('https://api.resend.com/emails', {
                    from: 'CourseV <CourseV@yisuscompany.com>',
                    to: student.email,
                    subject: emailSubject,
                    html: emailHTML
                }, {
                    headers: {
                        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                        'Content-Type': 'application/json'
                    }
                });
                console.log(`📧 Email de calificación enviado a ${student.email}`);
            } catch (emailError) {
                console.warn(`⚠️ Error enviando email:`, emailError.response?.data || emailError.message);
            }
        }

        // 4. Enviar Push Notification al estudiante
        await notificationService.sendPushNotification(
            studentId,
            pushTitle,
            pushBody,
            {
                type: notificationType,
                taskName: taskName,
                grade: gradeFormatted.toString(),
                oldGrade: isUpdate ? String(oldGrade) : null,
                action: 'OPEN_GRADES'
            }
        );
        console.log(`📱 Push notification de calificación enviada al estudiante ${studentId}`);

        // 5. Guardar notificación en la base de datos
        try {
            await supabaseService.client
                .from('notifications')
                .insert({
                    user_id: studentId,
                    title: emailSubject,
                    message: isUpdate
                        ? `Tu calificación en "${taskName}" cambió de ${oldGrade} a ${gradeFormatted}/10`
                        : `Tu tarea "${taskName}" ha sido calificada con ${gradeFormatted}/10`,
                    type: notificationType,
                    read: false,
                    created_at: new Date().toISOString()
                });
            console.log(`💾 Notificación guardada en BD para estudiante ${studentId}`);
        } catch (dbError) {
            console.warn(`⚠️ No se pudo guardar notificación en BD:`, dbError.message);
        }

        res.json({
            success: true,
            message: isUpdate
                ? 'Notificación de calificación MODIFICADA enviada al estudiante'
                : 'Notificación de calificación enviada al estudiante',
            isModification: isUpdate,
            studentId: studentId,
            studentUsername: student.username,
            studentEmail: student.email,
            taskName: taskName,
            grade: gradeFormatted,
            oldGrade: isUpdate ? oldGrade : null
        });

    } catch (error) {
        console.error('❌ Error en /notify-grade:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 🎬 Notifica a los suscriptores cuando un creador sube un nuevo video
 * POST /notify-video-upload
 * Body: { creatorId, videoTitle, videoId }
 */
router.post('/notify-video-upload', async (req, res) => {
    const { creatorId, videoTitle, videoId } = req.body;

    if (!creatorId || !videoTitle || !videoId) {
        return res.status(400).json({ error: 'Faltan datos requeridos: creatorId, videoTitle, videoId' });
    }

    console.log(`📢 Procesando notificación de video para creador ${creatorId}`);

    try {
        // 1. Obtener información del creador
        const { data: creator, error: creatorError } = await supabaseService.client
            .from('usuarios')
            .select('username')
            .eq('id', creatorId)
            .single();

        if (creatorError || !creator) {
            throw new Error(`Error obteniendo creador: ${creatorError?.message}`);
        }

        // 2. Obtener suscriptores del creador
        const { data: subscriptions, error: subError } = await supabaseService.client
            .from('subscriptions')
            .select('subscriber_id')
            .eq('creator_id', creatorId);

        if (subError) {
            throw new Error(`Error obteniendo suscriptores: ${subError.message}`);
        }

        if (!subscriptions || subscriptions.length === 0) {
            console.log('ℹ️ El creador no tiene suscriptores.');
            return res.json({ message: 'Sin suscriptores para notificar', count: 0 });
        }

        const subscriberIds = subscriptions.map(s => s.subscriber_id);
        console.log(`👥 Encontrados ${subscriberIds.length} suscriptores.`);

        // 3. Preparar notificaciones para la base de datos
        const notificationsToInsert = subscriberIds.map(subId => ({
            user_id: subId,
            title: 'Nuevo video disponible',
            message: `${creator.username} ha subido: ${videoTitle}`,
            type: 'video_upload',
            related_id: videoId,
            is_read: false,
            created_at: new Date().toISOString()
        }));

        // 4. Guardar en Supabase
        const { error: insertError } = await supabaseService.client
            .from('notifications')
            .insert(notificationsToInsert);

        if (insertError) {
            console.error('⚠️ Error guardando notificaciones en DB:', insertError.message);
        } else {
            console.log('✅ Notificaciones guardadas en base de datos.');
        }

        // 5. Enviar Notificaciones Push y Email
        let pushCount = 0;
        let emailCount = 0;

        for (const subId of subscriberIds) {
            // Push Notification
            const pushResult = await notificationService.sendPushNotification(
                subId,
                '¡Nuevo Video!',
                `${creator.username} acaba de subir un nuevo video: ${videoTitle}`,
                {
                    type: 'video_upload',
                    videoId: videoId.toString(),
                    creatorId: creatorId.toString()
                }
            );
            if (pushResult.success > 0) pushCount++;

            // Email Notification
            const emailResult = await notificationService.sendEmailNotification(
                subId,
                '¡Nuevo Video Disponible! 🎥',
                `Hola,\n\n${creator.username} acaba de subir un nuevo video titulado: "${videoTitle}".\n\n¡Entra a la app para verlo ahora!`,
                { type: 'generic' }
            );
            if (emailResult) emailCount++;
        }

        res.json({
            success: true,
            message: `Notificaciones procesadas`,
            subscribers: subscriberIds.length,
            pushSent: pushCount,
            emailSent: emailCount
        });

    } catch (error) {
        console.error('❌ Error en /notify-video-upload:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 💬 Notifica por email al usuario cuando recibe una respuesta del chat IA
 * POST /notify-chat-response
 * Body: { userId, responsePreview }
 */
router.post('/notify-chat-response', async (req, res) => {
    const { userId, responsePreview } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId es requerido' });
    }

    console.log(`📧 Enviando notificación de chat para usuario ${userId}`);

    try {
        const { data: user, error: userError } = await supabaseService.client
            .from('usuarios')
            .select('email, username')
            .eq('id', userId)
            .single();

        if (userError || !user || !user.email) {
            console.warn(`⚠️ No se encontró email para userId ${userId}`);
            return res.status(404).json({ error: 'Usuario no encontrado o sin email' });
        }

        const emailSubject = 'Nueva respuesta disponible - CourseV';
        const emailBody = `Hola ${user.username || 'Usuario'},

Tu consulta ha sido procesada por nuestro asistente de inteligencia artificial y tu respuesta está disponible.

Por razones de seguridad, la respuesta completa solo está disponible dentro de la aplicación móvil.

Saludos cordiales,
Equipo CourseV`;

        await notificationService.sendEmailNotification(userId, emailSubject, emailBody, { type: 'generic' });

        console.log(`✅ Notificación de chat enviada a ${user.email}`);
        res.json({
            success: true,
            message: 'Notificación enviada',
            email: user.email,
            securityNote: 'Response preview not included for security'
        });

    } catch (error) {
        console.error('❌ Error en /notify-chat-response:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 📱 Envía notificación push vía Firebase Cloud Messaging
 * POST /send-push-notification
 * Body: { userId, title, body, data }
 */
router.post('/send-push-notification', async (req, res) => {
    const { userId, title, body, data } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId es requerido' });
    }

    console.log(`📱 Enviando notificación push para usuario ${userId}`);

    try {
        const result = await notificationService.sendPushNotification(
            userId,
            title || '🤖 Nueva respuesta del chat',
            body || 'Tu consulta ha sido procesada',
            {
                userId: userId.toString(),
                type: 'chat_response',
                timestamp: new Date().toISOString(),
                ...data
            }
        );

        res.json({
            success: result.success > 0,
            message: `Push notifications sent to ${result.success} device(s)`,
            results: result
        });

    } catch (error) {
        console.error('❌ Error en /send-push-notification:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * 🔔 Endpoint genérico para enviar notificaciones por push y email
 * POST /send-notification
 * Body: { userId, title, message, type, relatedId, senderUsername }
 */
router.post('/send-notification', async (req, res) => {
    const { userId, title, message, type, relatedId, senderUsername } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId es requerido' });
    }

    console.log(`🔔 Enviando notificación completa para usuario ${userId}`);
    console.log(`   Tipo: ${type}, Título: ${title}`);

    const results = {
        push: { success: false, error: null },
        email: { success: false, error: null }
    };

    try {
        // 1. ENVIAR PUSH NOTIFICATION
        try {
            const pushResult = await notificationService.sendPushNotification(
                userId,
                title || '📢 Nueva notificación',
                message || 'Tienes una nueva notificación',
                {
                    userId: userId.toString(),
                    type: type || 'generic',
                    relatedId: relatedId ? relatedId.toString() : '',
                    senderUsername: senderUsername || '',
                    timestamp: new Date().toISOString()
                }
            );
            results.push.success = pushResult.success > 0;
            results.push.sentCount = pushResult.success;
            console.log(`📱 Push notifications: ${pushResult.success} enviadas`);
        } catch (pushError) {
            results.push.error = pushError.message;
            console.error('❌ Error en push notification:', pushError.message);
        }

        // 2. ENVIAR EMAIL
        try {
            const userIdNumber = parseInt(userId, 10);
            const { data: userData, error: userError } = await supabaseService.client
                .from('usuarios')
                .select('email, username')
                .eq('id', userIdNumber)
                .single();

            if (!userError && userData && userData.email && 
                userData.email !== '.' && !userData.email.startsWith('missing_email_')) {
                
                const userEmail = userData.email;
                let emailSubject = title || '📢 Nueva notificación en CourseV';

                // Personalizar subject según el tipo
                const subjectPrefixes = {
                    'new_course': '📚',
                    'new_video': '🎬',
                    'task_graded': '📊',
                    'grade': '📊',
                    'grade_modified': '📊',
                    'task_submission': '📝',
                    'new_task': '📋'
                };
                const prefix = subjectPrefixes[type] || '📢';
                emailSubject = `${prefix} ${title}`;

                const emailHTML = generateGenericEmailHTML({
                    subject: title,
                    message: message,
                    type: type,
                    senderName: senderUsername
                });

                if (process.env.RESEND_API_KEY) {
                    const emailResponse = await fetch('https://api.resend.com/emails', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            from: 'CourseV <CourseV@yisuscompany.com>',
                            to: [userEmail],
                            subject: emailSubject,
                            html: emailHTML
                        })
                    });

                    if (emailResponse.ok) {
                        results.email.success = true;
                        console.log(`✅ Email enviado a ${userEmail}`);
                    } else {
                        const errorData = await emailResponse.json();
                        results.email.error = errorData.message || 'Email send failed';
                        console.error(`❌ Error enviando email:`, errorData);
                    }
                } else {
                    results.email.error = 'Resend API key not configured';
                }
            } else {
                let reason = 'Unknown';
                if (userError) reason = `DB error: ${userError.message}`;
                else if (!userData) reason = 'Usuario no encontrado';
                else if (!userData.email) reason = 'Email vacío';
                else if (userData.email === '.') reason = 'Email placeholder';
                results.email.error = reason;
                console.warn(`⚠️ No se pudo enviar email: ${reason}`);
            }
        } catch (emailError) {
            results.email.error = emailError.message;
            console.error('❌ Error en email:', emailError.message);
        }

        const overallSuccess = results.push.success || results.email.success;
        res.json({
            success: overallSuccess,
            message: `Notificación enviada: Push=${results.push.success}, Email=${results.email.success}`,
            results
        });

    } catch (error) {
        console.error('❌ Error general en /send-notification:', error);
        res.status(500).json({ error: error.message, results });
    }
});

export default router;
