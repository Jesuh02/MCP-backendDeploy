/**
 * whatsappFormatter.js — Utilidades de formateo para mensajes de WhatsApp.
 *
 * WhatsApp soporta un subconjunto limitado de formato:
 *   *negrita*, _cursiva_, ~tachado~, ```monospace```
 *   Máximo 4096 caracteres por mensaje.
 */

const MAX_MESSAGE_LENGTH = 4096;

/**
 * Convierte Markdown básico al formato soportado por WhatsApp.
 * @param {string} text — Texto en Markdown.
 * @returns {string}
 */
export function markdownToWhatsApp(text) {
    if (!text) return '';
    const safeText = String(text).replace(/\r\n/g, '\n');

    return safeText
        // Headers → negrita
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        // **negrita** → *negrita*
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        // __negrita__ → *negrita*
        .replace(/__(.+?)__/g, '*$1*')
        // - item → • item
        .replace(/^[-*]\s+/gm, '• ')
        // Links [text](url) → text (url)
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
        // Horizontal rules
        .replace(/^-{3,}$/gm, '─────────────')
        // Clean up multiple newlines
        .replace(/\n{3,}/g, '\n\n');
}

/**
 * Divide un texto largo en múltiples mensajes respetando el límite de WhatsApp.
 * Intenta cortar en saltos de línea o puntos para no romper frases.
 *
 * @param {string} text
 * @param {number} [maxLength=4096]
 * @returns {string[]}
 */
export function truncateResponse(text, maxLength = MAX_MESSAGE_LENGTH) {
    if (!text) return [''];
    const safeText = String(text);
    if (safeText.length <= maxLength) return [safeText];

    const chunks = [];
    let remaining = safeText;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        // Buscar el mejor punto de corte
        let cutPoint = remaining.lastIndexOf('\n\n', maxLength);
        if (cutPoint < maxLength * 0.5) cutPoint = remaining.lastIndexOf('\n', maxLength);
        if (cutPoint < maxLength * 0.5) cutPoint = remaining.lastIndexOf('. ', maxLength);
        if (cutPoint < maxLength * 0.5) cutPoint = maxLength;
        chunks.push(remaining.substring(0, cutPoint).trim());
        remaining = remaining.substring(cutPoint).trim();
    }

    return chunks;
}

/**
 * Formatea una tabla de datos como texto plano legible en WhatsApp.
 * @param {object[]} rows — Array de objetos.
 * @param {string[]} columns — Nombres de columnas a mostrar.
 * @returns {string}
 */
export function formatTable(rows, columns) {
    if (!rows || rows.length === 0) return '_Sin datos_';

    const lines = rows.map((row, i) => {
        const fields = columns
            .map(col => `  ${col}: ${row[col] ?? '—'}`)
            .join('\n');
        return `*${i + 1}.* \n${fields}`;
    });

    return lines.join('\n\n');
}

/**
 * Formatea un reporte de progreso de estudiantes.
 * @param {object[]} data — Datos de progreso_estudiante con joins.
 * @returns {string}
 */
export function formatProgressReport(data) {
    if (!data || data.length === 0) return '_No hay datos de progreso disponibles._';

    const lines = data.map(item => {
        const status = item.estado === 'Ganado' ? '✅' : '⚠️';
        const pct = item.porcentaje_progreso != null ?
            `${Math.round(item.porcentaje_progreso)}%` :
            '—';
        return `${status} *${item.username || 'Estudiante'}* — ${item.curso || 'Curso'}\n` +
            `   📊 Progreso: ${pct} | Tareas: ${item.tareas_completadas}/${item.tareas_totales}\n` +
            `   📝 Promedio: ${item.promedio ?? '—'} | Estado: ${item.estado ?? '—'}`;
    });

    return `*📊 Reporte de Progreso*\n\n${lines.join('\n\n')}`;
}

/**
 * Formatea la confirmación de calificación.
 * @param {object} params
 * @returns {string}
 */
export function formatGradeConfirmation({ submissionId, taskTitle, studentName, grade, feedback }) {
    let msg = `✅ *Calificación registrada*\n\n` +
        `📝 Entrega: #${submissionId}\n` +
        `📚 Tarea: ${taskTitle || '—'}\n` +
        `👤 Estudiante: ${studentName || '—'}\n` +
        `📊 Nota: ${grade}/10`;

    if (feedback) {
        msg += `\n💬 Feedback: ${feedback}`;
    }

    msg += '\n\n_El estudiante ha sido notificado._';
    return msg;
}

// ── Mensajes Predefinidos ───────────────────────────────────

export const MESSAGES = {
    WELCOME: (name) =>
        `👋 ¡Hola *${name}*! Bienvenido/a al asistente CourseV.\n\n` +
        `Puedo ayudarte con:\n` +
        `📚 Preguntas generales\n` +
        `📊 Progreso de tus estudiantes\n` +
        `✏️ Calificar entregas\n\n` +
        `Escribe */ayuda* para ver todos los comandos.`,

    HELP: `*Comandos disponibles:*\n\n` +
        `*/calificar* <id> <nota> [feedback]\n→ Califica una entrega\n\n` +
        `*/progreso* [curso]\n→ Ver progreso de estudiantes\n\n` +
        `*/consulta* <pregunta> *(solo admin)*\n→ Consultar base de datos\n\n` +
        `*/desvincular*\n→ Desvincular tu cuenta\n\n` +
        `*/ayuda*\n→ Ver este mensaje`,

    NOT_LINKED: `⚠️ Este número no está vinculado a ninguna cuenta.\n\n` +
        `Para usar el asistente por WhatsApp:\n` +
        `1. Abre la app CourseV\n` +
        `2. Ve a tu Perfil → Configuración\n` +
        `3. Selecciona 'Vincular WhatsApp'\n` +
        `4. Ingresa este número de teléfono`,

    ACCESS_DENIED: (role, required) =>
        `❌ No tienes permisos para esta acción.\n` +
        `Tu rol actual: ${role}\nRol requerido: ${required}`,

    OTP_SENT: (phone) =>
        `📱 Se ha enviado un código de verificación a *${phone}*.\n` +
        `Ingresa el código de 6 dígitos en la app para completar la vinculación.`,

    UNLINKED: `✅ Tu cuenta ha sido desvinculada de WhatsApp.\n` +
        `Ya no recibirás mensajes por este canal.`,

    ERROR: `😔 Lo siento, hubo un error procesando tu mensaje. Intenta de nuevo en unos momentos.`,

    PROCESSING: `⏳ Procesando tu solicitud...`,
};

export default {
    markdownToWhatsApp,
    truncateResponse,
    formatTable,
    formatProgressReport,
    formatGradeConfirmation,
    MESSAGES,
};

