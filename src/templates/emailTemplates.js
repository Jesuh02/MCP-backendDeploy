/**
 * Email Templates Service
 * Plantillas HTML profesionales para emails de CourseV
 * @module templates/emailTemplates
 */

/**
 * Genera el CSS base para todas las plantillas de email
 * @returns {string} CSS styles
 */
export function getEmailBaseStyles() {
    return `
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background-color: #f8fafc; 
            margin: 0; 
            padding: 20px;
            color: #1e293b;
        }
        .container { 
            max-width: 600px; 
            margin: 0 auto; 
            background: #ffffff; 
            border-radius: 16px; 
            overflow: hidden;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        }
        .header { 
            background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); 
            padding: 32px 24px; 
            text-align: center;
        }
        .header-icon { 
            font-size: 48px; 
            margin-bottom: 8px;
        }
        .header h1 { 
            color: white; 
            margin: 0; 
            font-size: 24px; 
            font-weight: 600;
            letter-spacing: -0.5px;
        }
        .header p { 
            color: rgba(255,255,255,0.85); 
            margin: 8px 0 0 0; 
            font-size: 14px;
        }
        .content { 
            padding: 32px 24px;
        }
        .greeting { 
            font-size: 18px; 
            color: #334155; 
            margin-bottom: 24px;
        }
        .greeting strong { 
            color: #6366f1;
        }
        .card { 
            background: #f8fafc; 
            border-radius: 12px; 
            padding: 20px; 
            margin: 16px 0;
            border-left: 4px solid #6366f1;
        }
        .card-title { 
            font-size: 12px; 
            text-transform: uppercase; 
            letter-spacing: 1px; 
            color: #64748b; 
            margin: 0 0 8px 0;
            font-weight: 600;
        }
        .card-value { 
            font-size: 20px; 
            font-weight: 700; 
            color: #1e293b; 
            margin: 0;
        }
        .grade-display { 
            text-align: center; 
            padding: 24px; 
            background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); 
            border-radius: 12px; 
            margin: 20px 0;
        }
        .grade-display.low { 
            background: linear-gradient(135deg, #fef2f2 0%, #fecaca 100%);
        }
        .grade-display.medium { 
            background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
        }
        .grade-number { 
            font-size: 48px; 
            font-weight: 800; 
            color: #16a34a; 
            line-height: 1;
        }
        .grade-display.low .grade-number { 
            color: #dc2626;
        }
        .grade-display.medium .grade-number { 
            color: #d97706;
        }
        .grade-label { 
            font-size: 14px; 
            color: #64748b; 
            margin-top: 4px;
        }
        .comparison-grid { 
            display: table; 
            width: 100%; 
            margin: 20px 0;
        }
        .comparison-row { 
            display: table-row;
        }
        .comparison-cell { 
            display: table-cell; 
            width: 50%; 
            padding: 12px; 
            vertical-align: top;
        }
        .comparison-box { 
            background: #f8fafc; 
            border-radius: 12px; 
            padding: 16px; 
            text-align: center;
        }
        .comparison-box.old { 
            background: #fef2f2; 
        }
        .comparison-box.new { 
            background: #f0fdf4; 
        }
        .comparison-label { 
            font-size: 11px; 
            text-transform: uppercase; 
            letter-spacing: 1px; 
            color: #64748b; 
            margin-bottom: 8px;
        }
        .comparison-value { 
            font-size: 28px; 
            font-weight: 800;
        }
        .comparison-box.old .comparison-value { 
            color: #ef4444; 
        }
        .comparison-box.new .comparison-value { 
            color: #22c55e; 
        }
        .arrow-indicator { 
            text-align: center; 
            font-size: 24px; 
            padding: 20px 0;
        }
        .feedback-section { 
            background: #f1f5f9; 
            border-radius: 12px; 
            padding: 20px; 
            margin: 20px 0;
        }
        .feedback-title { 
            font-size: 14px; 
            font-weight: 600; 
            color: #475569; 
            margin-bottom: 12px;
        }
        .feedback-text { 
            color: #334155; 
            line-height: 1.6; 
            font-size: 15px;
        }
        .feedback-comparison { 
            display: table; 
            width: 100%; 
            margin-top: 16px;
        }
        .feedback-old, .feedback-new { 
            display: table-cell; 
            width: 50%; 
            padding: 12px;
            vertical-align: top;
        }
        .feedback-box { 
            background: white; 
            border-radius: 8px; 
            padding: 12px;
        }
        .feedback-box.old { 
            border-left: 3px solid #ef4444;
        }
        .feedback-box.new { 
            border-left: 3px solid #22c55e;
        }
        .cta-button { 
            display: inline-block; 
            background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); 
            color: white; 
            text-decoration: none; 
            padding: 14px 28px; 
            border-radius: 8px; 
            font-weight: 600; 
            font-size: 15px;
            margin-top: 16px;
        }
        .divider { 
            height: 1px; 
            background: #e2e8f0; 
            margin: 24px 0;
        }
        .footer { 
            text-align: center; 
            padding: 24px; 
            background: #f8fafc; 
            color: #64748b; 
            font-size: 13px;
        }
        .footer .brand { 
            color: #6366f1; 
            font-weight: 600;
        }
        .message { 
            color: #475569; 
            line-height: 1.7; 
            font-size: 15px;
        }
    `;
}

/**
 * Plantilla: Notificación de nueva calificación
 * @param {string} studentName - Nombre del estudiante
 * @param {string} taskName - Nombre de la tarea
 * @param {number} grade - Calificación
 * @param {string} feedback - Retroalimentación
 * @param {string} gradedByUsername - Usuario que calificó
 * @returns {string} HTML del email
 */
export function generateGradeEmailHTML(studentName, taskName, grade, feedback, gradedByUsername) {
    const gradeNum = parseFloat(grade) || 0;
    const gradeClass = gradeNum >= 7 ? '' : gradeNum >= 5 ? 'medium' : 'low';
    const gradeEmoji = gradeNum >= 9 ? '🏆' : gradeNum >= 7 ? '⭐' : gradeNum >= 5 ? '✅' : '📚';
    
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${getEmailBaseStyles()}</style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-icon">${gradeEmoji}</div>
            <h1>¡Tu tarea ha sido calificada!</h1>
            <p>Revisa tu calificación y feedback</p>
        </div>
        
        <div class="content">
            <p class="greeting">¡Hola <strong>${studentName || 'estudiante'}</strong>! 👋</p>
            
            <div class="card">
                <p class="card-title">📝 Tarea evaluada</p>
                <p class="card-value">${taskName}</p>
            </div>
            
            <div class="grade-display ${gradeClass}">
                <div class="grade-number">${gradeNum.toFixed(1)}</div>
                <div class="grade-label">de 10 puntos</div>
            </div>
            
            ${gradedByUsername ? `
            <div class="card" style="border-left-color: #8b5cf6;">
                <p class="card-title">👨‍🏫 Evaluado por</p>
                <p class="card-value">${gradedByUsername}</p>
            </div>
            ` : ''}
            
            ${feedback ? `
            <div class="feedback-section">
                <p class="feedback-title">💬 Retroalimentación del profesor</p>
                <p class="feedback-text">${feedback}</p>
            </div>
            ` : ''}
            
            <div class="divider"></div>
            
            <div style="text-align: center;">
                <a href="#" class="cta-button">Ver detalles en CourseV</a>
            </div>
        </div>
        
        <div class="footer">
            <p>Este email fue enviado por <span class="brand">CourseV</span></p>
            <p style="margin-top: 8px;">© 2025 YisusCompany. Todos los derechos reservados.</p>
        </div>
    </div>
</body>
</html>
    `;
}

/**
 * Plantilla: Notificación de calificación MODIFICADA
 * @param {string} studentName - Nombre del estudiante
 * @param {string} taskName - Nombre de la tarea
 * @param {number} oldGrade - Calificación anterior
 * @param {number} newGrade - Nueva calificación
 * @param {string} oldFeedback - Feedback anterior
 * @param {string} newFeedback - Nuevo feedback
 * @param {string} gradedByUsername - Usuario que calificó
 * @returns {string} HTML del email
 */
export function generateGradeModifiedEmailHTML(studentName, taskName, oldGrade, newGrade, oldFeedback, newFeedback, gradedByUsername) {
    const oldNum = parseFloat(oldGrade) || 0;
    const newNum = parseFloat(newGrade) || 0;
    const improved = newNum > oldNum;
    const changeEmoji = improved ? '📈' : newNum < oldNum ? '📉' : '🔄';
    const changeText = improved ? '¡Tu nota ha mejorado!' : newNum < oldNum ? 'Tu nota ha cambiado' : 'Tu nota ha sido actualizada';
    
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${getEmailBaseStyles()}</style>
</head>
<body>
    <div class="container">
        <div class="header" style="background: linear-gradient(135deg, ${improved ? '#10b981' : '#f59e0b'} 0%, ${improved ? '#059669' : '#d97706'} 100%);">
            <div class="header-icon">${changeEmoji}</div>
            <h1>Calificación Actualizada</h1>
            <p>${changeText}</p>
        </div>
        
        <div class="content">
            <p class="greeting">¡Hola <strong>${studentName || 'estudiante'}</strong>! 👋</p>
            
            <p class="message">
                Tu profesor ha actualizado la calificación de tu tarea. 
                Aquí puedes ver los cambios:
            </p>
            
            <div class="card">
                <p class="card-title">📝 Tarea</p>
                <p class="card-value">${taskName}</p>
            </div>
            
            <div class="comparison-grid">
                <div class="comparison-row">
                    <div class="comparison-cell">
                        <div class="comparison-box old">
                            <div class="comparison-label">Nota Anterior</div>
                            <div class="comparison-value">${oldNum.toFixed(1)}</div>
                        </div>
                    </div>
                    <div class="comparison-cell">
                        <div class="comparison-box new">
                            <div class="comparison-label">Nueva Nota</div>
                            <div class="comparison-value">${newNum.toFixed(1)}</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="arrow-indicator">
                ${improved ? '⬆️ +' : newNum < oldNum ? '⬇️ ' : '↔️ '}${Math.abs(newNum - oldNum).toFixed(1)} puntos
            </div>
            
            ${gradedByUsername ? `
            <div class="card" style="border-left-color: #8b5cf6;">
                <p class="card-title">👨‍🏫 Actualizado por</p>
                <p class="card-value">${gradedByUsername}</p>
            </div>
            ` : ''}
            
            ${(oldFeedback || newFeedback) ? `
            <div class="feedback-section">
                <p class="feedback-title">💬 Retroalimentación</p>
                
                ${(oldFeedback && newFeedback && oldFeedback !== newFeedback) ? `
                <div class="feedback-comparison">
                    <div class="feedback-old">
                        <div class="feedback-box old">
                            <p class="comparison-label">Anterior</p>
                            <p class="feedback-text" style="font-size: 13px;">${oldFeedback}</p>
                        </div>
                    </div>
                    <div class="feedback-new">
                        <div class="feedback-box new">
                            <p class="comparison-label">Nuevo</p>
                            <p class="feedback-text" style="font-size: 13px;">${newFeedback}</p>
                        </div>
                    </div>
                </div>
                ` : `
                <p class="feedback-text">${newFeedback || oldFeedback}</p>
                `}
            </div>
            ` : ''}
            
            <div class="divider"></div>
            
            <div style="text-align: center;">
                <a href="#" class="cta-button" style="background: linear-gradient(135deg, ${improved ? '#10b981' : '#f59e0b'} 0%, ${improved ? '#059669' : '#d97706'} 100%);">
                    Ver detalles en CourseV
                </a>
            </div>
        </div>
        
        <div class="footer">
            <p>Este email fue enviado por <span class="brand">CourseV</span></p>
            <p style="margin-top: 8px;">© 2025 YisusCompany. Todos los derechos reservados.</p>
        </div>
    </div>
</body>
</html>
    `;
}

/**
 * Plantilla: Notificación de nuevo curso
 * @param {string} userName - Nombre del usuario
 * @param {string} creatorUsername - Username del creador
 * @param {string} courseTitle - Título del curso
 * @param {string} thumbnailUrl - URL del thumbnail
 * @returns {string} HTML del email
 */
export function generateNewCourseEmailHTML(userName, creatorUsername, courseTitle, thumbnailUrl) {
    const thumbnailSection = thumbnailUrl ? `
            <div style="text-align: center; margin: 24px 0;">
                <img src="${thumbnailUrl}" alt="Thumbnail del curso" style="max-width: 100%; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
            </div>
            ` : '';
    
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${getEmailBaseStyles()}</style>
</head>
<body>
    <div class="container">
        <div class="header" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">
            <div class="header-icon">📚</div>
            <h1>¡Nuevo Curso Disponible!</h1>
            <p>De un creador que sigues</p>
        </div>
        
        <div class="content">
            <p class="greeting">¡Hola <strong>${userName || 'estudiante'}</strong>! 👋</p>
            
            <p class="message">
                <strong>${creatorUsername}</strong> acaba de publicar un nuevo curso que podría interesarte.
            </p>
            
            ${thumbnailSection}
            
            <div class="card" style="border-left-color: #10b981;">
                <p class="card-title">🎓 Nuevo curso</p>
                <p class="card-value">${courseTitle}</p>
            </div>
            
            <div style="background: #f0fdf4; border-radius: 12px; padding: 16px; margin: 20px 0; text-align: center;">
                <p style="margin: 0; color: #166534; font-size: 15px;">
                    ¡No te pierdas este nuevo contenido!<br>
                    Entra ahora y comienza a aprender.
                </p>
            </div>
            
            <div style="text-align: center;">
                <a href="#" class="cta-button" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">
                    Ver curso ahora
                </a>
            </div>
        </div>
        
        <div class="footer">
            <p>Este email fue enviado por <span class="brand">CourseV</span></p>
            <p style="margin-top: 8px;">© 2025 YisusCompany. Todos los derechos reservados.</p>
        </div>
    </div>
</body>
</html>
    `;
}

/**
 * Plantilla: Notificación genérica profesional
 * @param {string} title - Título de la notificación
 * @param {string} message - Mensaje
 * @param {string} type - Tipo de notificación
 * @param {string} senderUsername - Username del remitente
 * @returns {string} HTML del email
 */
export function generateGenericEmailHTML(title, message, type, senderUsername) {
    const typeConfig = {
        'new_course': { icon: '📚', color: '#10b981', gradient: 'linear-gradient(135deg, #10b981 0%, #059669 100%)' },
        'new_video': { icon: '🎬', color: '#f59e0b', gradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)' },
        'task_graded': { icon: '📊', color: '#6366f1', gradient: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' },
        'task_submission': { icon: '📝', color: '#0ea5e9', gradient: 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)' },
        'new_task': { icon: '📋', color: '#8b5cf6', gradient: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)' },
        'default': { icon: '🔔', color: '#6366f1', gradient: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' }
    };
    
    const config = typeConfig[type] || typeConfig['default'];
    
    const senderSection = senderUsername ? `
            <div class="card" style="border-left-color: ${config.color};">
                <p class="card-title">👤 De</p>
                <p class="card-value">${senderUsername}</p>
            </div>
            ` : '';

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${getEmailBaseStyles()}</style>
</head>
<body>
    <div class="container">
        <div class="header" style="background: ${config.gradient};">
            <div class="header-icon">${config.icon}</div>
            <h1>${title || 'Nueva Notificación'}</h1>
        </div>
        
        <div class="content">
            ${senderSection}
            
            <div class="message" style="font-size: 16px; line-height: 1.8; padding: 20px 0;">
                ${message}
            </div>
            
            <div class="divider"></div>
            
            <div style="text-align: center;">
                <a href="#" class="cta-button" style="background: ${config.gradient};">
                    Abrir en CourseV
                </a>
            </div>
        </div>
        
        <div class="footer">
            <p>Este email fue enviado por <span class="brand">CourseV</span></p>
            <p style="margin-top: 8px;">© 2025 YisusCompany. Todos los derechos reservados.</p>
        </div>
    </div>
</body>
</html>
    `;
}

/**
 * Escapa entidades HTML para prevenir inyecciones en contenido dinámico.
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Plantilla: Recordatorio de entrega de tarea (minimalista/profesional)
 * @param {object} params
 * @param {string} params.userName
 * @param {string} params.taskTitle
 * @param {string} params.courseTitle
 * @param {string} params.dueDateText
 * @param {string} [params.ctaUrl]
 * @returns {string}
 */
export function generateTaskReminderEmailHTML({ userName, taskTitle, courseTitle, dueDateText, ctaUrl }) {
    const safeUserName = escapeHtml(userName || 'estudiante');
    const safeTaskTitle = escapeHtml(taskTitle || 'Actividad pendiente');
    const safeCourseTitle = escapeHtml(courseTitle || 'Curso');
    const safeDueDateText = escapeHtml(dueDateText || 'fecha no disponible');
    const safeCtaUrl = typeof ctaUrl === 'string' && /^https?:\/\//i.test(ctaUrl) ? escapeHtml(ctaUrl) : '';

    const ctaSection = safeCtaUrl
        ? `<div style="text-align: center; margin-top: 26px;">
                <a href="${safeCtaUrl}" style="display: inline-block; padding: 12px 22px; border-radius: 999px; border: 1px solid #111827; text-decoration: none; color: #111827; font-size: 14px; font-weight: 600; letter-spacing: 0.2px;">Revisar tarea</a>
           </div>`
        : '';

    return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Recordatorio de entrega</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            background: #f5f6f8;
            color: #111827;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }
        .outer {
            width: 100%;
            padding: 28px 14px;
        }
        .card {
            max-width: 600px;
            margin: 0 auto;
            background: #ffffff;
            border: 1px solid #e5e7eb;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 10px 30px rgba(17, 24, 39, 0.06);
        }
        .top-line {
            height: 4px;
            background: linear-gradient(90deg, #111827 0%, #374151 100%);
        }
        .content {
            padding: 26px 24px;
        }
        .tag {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 999px;
            background: #f3f4f6;
            color: #4b5563;
            font-size: 11px;
            letter-spacing: 0.7px;
            text-transform: uppercase;
            font-weight: 600;
        }
        .title {
            margin: 14px 0 8px;
            font-size: 24px;
            line-height: 1.25;
            letter-spacing: -0.2px;
            color: #111827;
        }
        .subtitle {
            margin: 0;
            font-size: 14px;
            line-height: 1.6;
            color: #6b7280;
        }
        .details {
            margin-top: 22px;
            border: 1px solid #e5e7eb;
            border-radius: 12px;
            padding: 16px;
            background: #fcfcfd;
        }
        .row {
            margin-bottom: 12px;
        }
        .row:last-child {
            margin-bottom: 0;
        }
        .label {
            margin: 0 0 4px;
            font-size: 11px;
            letter-spacing: 0.7px;
            text-transform: uppercase;
            color: #9ca3af;
            font-weight: 600;
        }
        .value {
            margin: 0;
            font-size: 15px;
            color: #1f2937;
            line-height: 1.5;
            font-weight: 500;
        }
        .note {
            margin-top: 18px;
            font-size: 13px;
            line-height: 1.6;
            color: #6b7280;
        }
        .footer {
            padding: 14px 24px 22px;
            font-size: 12px;
            color: #9ca3af;
            text-align: center;
        }
        @media (max-width: 480px) {
            .content { padding: 22px 18px; }
            .title { font-size: 22px; }
        }
    </style>
</head>
<body>
    <div class="outer">
        <div class="card">
            <div class="top-line"></div>
            <div class="content">
                <span class="tag">Recordatorio</span>
                <h1 class="title">Tu tarea vence en 5 horas</h1>
                <p class="subtitle">Hola ${safeUserName}, este es un aviso para que puedas enviar tu entrega con tiempo.</p>

                <div class="details">
                    <div class="row">
                        <p class="label">Tarea</p>
                        <p class="value">${safeTaskTitle}</p>
                    </div>
                    <div class="row">
                        <p class="label">Curso</p>
                        <p class="value">${safeCourseTitle}</p>
                    </div>
                    <div class="row">
                        <p class="label">Fecha limite</p>
                        <p class="value">${safeDueDateText}</p>
                    </div>
                </div>

                <p class="note">Si ya realizaste la entrega, puedes ignorar este mensaje.</p>
                ${ctaSection}
            </div>
            <div class="footer">CourseV · Notificacion automatica</div>
        </div>
    </div>
</body>
</html>
    `;
}

/**
 * Plantilla: Email de respuesta de chat IA
 * @param {string} subject - Asunto del email
 * @returns {string} HTML del email
 */
export function generateChatResponseEmailHTML(subject) {
    return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${subject}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: #0f172a;
            color: #e2e8f0;
        }
        
        .container {
            max-width: 600px;
            margin: 0 auto;
            background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
        }
        
        .header {
            background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
            padding: 40px 30px;
            text-align: center;
        }
        
        .logo-container {
            width: 80px;
            height: 80px;
            margin: 0 auto 20px;
            background: rgba(255, 255, 255, 0.15);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .logo-emoji {
            font-size: 40px;
        }
        
        .header h1 {
            color: white;
            font-size: 26px;
            font-weight: 700;
            margin-bottom: 8px;
            letter-spacing: -0.5px;
        }
        
        .header p {
            color: rgba(255, 255, 255, 0.8);
            font-size: 15px;
        }
        
        .content {
            padding: 40px 30px;
        }
        
        .message-card {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            padding: 24px;
            margin-bottom: 24px;
        }
        
        .message-card p {
            color: #94a3b8;
            line-height: 1.7;
            font-size: 15px;
        }
        
        .cta-button {
            display: block;
            text-align: center;
            background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
            color: white;
            text-decoration: none;
            padding: 16px 32px;
            border-radius: 12px;
            font-weight: 600;
            font-size: 16px;
            margin: 30px auto;
            max-width: 280px;
        }
        
        .footer {
            padding: 30px;
            text-align: center;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .footer p {
            color: #64748b;
            font-size: 13px;
            line-height: 1.6;
        }
        
        .brand {
            color: #8b5cf6;
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo-container">
                <span class="logo-emoji">🤖</span>
            </div>
            <h1>Respuesta Lista</h1>
            <p>DeepSeek ha procesado tu consulta</p>
        </div>
        
        <div class="content">
            <div class="message-card">
                <p>
                    ¡Hola! Tu consulta ha sido procesada exitosamente por DeepSeek.
                    Abre la aplicación para ver la respuesta completa.
                </p>
            </div>
            
            <a href="#" class="cta-button">Ver Respuesta en CourseV</a>
        </div>
        
        <div class="footer">
            <p>
                Recibiste este correo porque eres usuario de <span class="brand">CourseV</span>.
                <br>© 2025 YisusCompany. Todos los derechos reservados.
            </p>
        </div>
    </div>
</body>
</html>
    `;
}

export default {
    getEmailBaseStyles,
    generateGradeEmailHTML,
    generateGradeModifiedEmailHTML,
    generateNewCourseEmailHTML,
    generateGenericEmailHTML,
    generateChatResponseEmailHTML,
    generateTaskReminderEmailHTML
};


