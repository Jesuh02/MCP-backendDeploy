/**
 * Joi Validation Schemas — Common (Topics, Tasks, ContentItems, Submissions, etc.)
 */
import Joi from 'joi';

// ─── Topics ──────────────────────────────────────────────
export const createTopicSchema = Joi.object({
    id: Joi.any().strip().optional(),
    title: Joi.string().min(1).max(200).optional(),
    name: Joi.string().min(1).max(200).optional(),
    description: Joi.string().max(2000).allow('').optional(),
    subjectId: Joi.number().integer().optional(),
    materiaId: Joi.number().integer().optional(),
    materia_id: Joi.number().integer().optional(),
    courseId: Joi.number().integer().optional(),
    course_id: Joi.number().integer().optional(),
    orderIndex: Joi.number().integer().min(0).default(0),
    order_index: Joi.number().integer().min(0).optional(),
    created_at: Joi.any().strip().optional(),
    updated_at: Joi.any().strip().optional(),
}).custom((value, helpers) => {
    if (!value.title && value.name) value.title = value.name;
    value.subjectId = value.subjectId || value.materiaId || value.materia_id || value.courseId || value.course_id;
    delete value.name;
    delete value.materiaId;
    delete value.materia_id;
    delete value.courseId;
    delete value.course_id;
    delete value.order_index;
    if (!value.title) return helpers.error('any.required', { key: 'title' });
    if (!value.subjectId) return helpers.error('any.required', { key: 'subjectId' });
    return value;
});

export const updateTopicSchema = Joi.object({
    id: Joi.any().strip().optional(),
    title: Joi.string().min(1).max(200).optional(),
    name: Joi.string().min(1).max(200).optional(),
    description: Joi.string().max(2000).allow('').optional(),
    orderIndex: Joi.number().integer().min(0).optional(),
    order_index: Joi.number().integer().min(0).optional(),
    created_at: Joi.any().strip().optional(),
    updated_at: Joi.any().strip().optional(),
}).custom((value) => {
    // Normalizar: aceptar 'name' como alias de 'title'
    if (!value.title && value.name) value.title = value.name;
    delete value.name;
    if (value.order_index !== undefined && value.orderIndex === undefined) value.orderIndex = value.order_index;
    delete value.order_index;
    return value;
}).min(1);

// ─── Tasks ───────────────────────────────────────────────
// Columnas reales en la tabla `tasks`: id, topic_id, title, description, due_date, created_at
// Se aceptan ambas notaciones (camelCase y snake_case) para máxima compatibilidad.
export const createTaskSchema = Joi.object({
    id: Joi.any().strip().optional(),
    title: Joi.string().min(1).max(300).required(),
    description: Joi.string().max(5000).allow('', null).optional(),
    topicId: Joi.number().integer().optional(),
    topic_id: Joi.number().integer().optional(),
    dueDate: Joi.date().iso().allow(null).optional(),
    due_date: Joi.date().iso().allow(null).optional(),
    timeLimitMinutes: Joi.number().integer().min(1).allow(null).optional(),
    time_limit_minutes: Joi.number().integer().min(1).allow(null).optional(),
    periodId: Joi.number().integer().allow(null).optional(),
    period_id: Joi.number().integer().allow(null).optional(),
    orderIndex: Joi.number().integer().min(0).default(0),
    order_index: Joi.number().integer().min(0).optional(),
}).custom((value, helpers) => {
    // Normalizar: preferir camelCase, fusionar snake_case si falta
    if (!value.topicId && value.topic_id) value.topicId = value.topic_id;
    if (!value.dueDate && value.due_date) value.dueDate = value.due_date;
    if (value.timeLimitMinutes === undefined && value.time_limit_minutes !== undefined) {
        value.timeLimitMinutes = value.time_limit_minutes;
    }
    if (value.periodId == null && value.period_id != null) value.periodId = value.period_id;
    delete value.topic_id;
    delete value.due_date;
    delete value.time_limit_minutes;
    delete value.period_id;
    delete value.order_index;
    if (!value.topicId) return helpers.error('any.required', { key: 'topicId' });
    return value;
});

export const updateTaskSchema = Joi.object({
    title: Joi.string().min(1).max(300).optional(),
    description: Joi.string().max(5000).allow('', null).optional(),
    dueDate: Joi.date().iso().allow(null).optional(),
    due_date: Joi.date().iso().allow(null).optional(),
    timeLimitMinutes: Joi.number().integer().min(1).allow(null).optional(),
    time_limit_minutes: Joi.number().integer().min(1).allow(null).optional(),
    orderIndex: Joi.number().integer().min(0).optional(),
    order_index: Joi.number().integer().min(0).optional(),
}).custom((value) => {
    if (!value.dueDate && value.due_date) value.dueDate = value.due_date;
    if (value.timeLimitMinutes === undefined && value.time_limit_minutes !== undefined) {
        value.timeLimitMinutes = value.time_limit_minutes;
    }
    if (value.order_index !== undefined && value.orderIndex === undefined) value.orderIndex = value.order_index;
    delete value.due_date;
    delete value.time_limit_minutes;
    delete value.order_index;
    return value;
}).min(1);

export const reorderTasksSchema = Joi.object({
    items: Joi.array().items(
        Joi.object({
            id: Joi.number().integer().required(),
            orderIndex: Joi.number().integer().min(0).required(),
        })
    ).min(1).required(),
});

// ─── Content Items ───────────────────────────────────────
// Columnas reales en la tabla: id, topic_id, title, body, content_type, created_at,
//   creator_usuario_id, creator_username, order_index, task_id
// Android envía: topic_id, task_id, title (name), body (uriString), content_type, order_index
export const createContentItemSchema = Joi.object({
    taskId: Joi.number().integer().allow(null).optional(),
    task_id: Joi.number().integer().allow(null).optional(),
    topicId: Joi.number().integer().allow(null).optional(),
    topic_id: Joi.number().integer().allow(null).optional(),
    contentType: Joi.string().valid('text', 'file', 'link', 'image', 'video', 'document').optional(),
    content_type: Joi.string().valid('text', 'file', 'link', 'image', 'video', 'document').optional(),
    title: Joi.string().max(500).allow('', null).optional(),
    body: Joi.string().max(50000).allow('', null).optional(),
    content: Joi.string().max(50000).allow('', null).optional(),
    fileUri: Joi.string().allow(null, '').optional(),
    file_uri: Joi.string().allow(null, '').optional(),
    fileName: Joi.string().max(255).allow(null, '').optional(),
    file_name: Joi.string().max(255).allow(null, '').optional(),
    name: Joi.string().max(500).allow('', null).optional(),
    uriString: Joi.string().allow(null, '').optional(),
    orderIndex: Joi.number().integer().min(0).default(0),
    order_index: Joi.number().integer().min(0).optional(),
    creatorUsuarioId: Joi.number().integer().allow(null).optional(),
    creator_usuario_id: Joi.number().integer().allow(null).optional(),
    creatorUsername: Joi.string().max(100).allow(null, '').optional(),
    creator_username: Joi.string().max(100).allow(null, '').optional(),
    id: Joi.any().strip().optional(),
    created_at: Joi.any().strip().optional(),
}).custom((value, helpers) => {
    // Normalizar snake_case a camelCase
    if (!value.taskId && value.task_id) value.taskId = value.task_id;
    if (!value.topicId && value.topic_id) value.topicId = value.topic_id;
    // content_type always wins if provided (fixes default('text') overriding snake_case value)
    if (value.content_type) value.contentType = value.content_type;
    else if (!value.contentType) value.contentType = 'text';
    // Mapear campos Android: name→title, uriString→body
    if (!value.title && value.name) value.title = value.name;
    if (!value.fileName && value.file_name) value.fileName = value.file_name;
    if (!value.title && value.fileName) value.title = value.fileName;
    if (!value.body && value.uriString) value.body = value.uriString;
    if (!value.fileUri && value.file_uri) value.fileUri = value.file_uri;
    if (!value.body && value.fileUri) value.body = value.fileUri;
    if (!value.body && value.content) value.body = value.content;
    if (value.order_index !== undefined && value.orderIndex === undefined) value.orderIndex = value.order_index;
    if (!value.creatorUsuarioId && value.creator_usuario_id) value.creatorUsuarioId = value.creator_usuario_id;
    if (!value.creatorUsername && value.creator_username) value.creatorUsername = value.creator_username;
    // Limpiar campos duplicados
    delete value.task_id;
    delete value.topic_id;
    delete value.content_type;
    delete value.name;
    delete value.uriString;
    delete value.fileUri;
    delete value.file_uri;
    delete value.fileName;
    delete value.file_name;
    delete value.content;
    delete value.order_index;
    delete value.creator_usuario_id;
    delete value.creator_username;
    // Al menos topicId o taskId debe estar presente
    if (!value.taskId && !value.topicId) {
        return helpers.error('any.required', { key: 'topicId or taskId' });
    }
    return value;
});

export const updateContentItemSchema = Joi.object({
    title: Joi.string().max(500).allow('', null).optional(),
    body: Joi.string().max(50000).allow('', null).optional(),
    content: Joi.string().max(50000).allow('').optional(),
    contentType: Joi.string().valid('text', 'file', 'link', 'image', 'video', 'document').optional(),
    content_type: Joi.string().valid('text', 'file', 'link', 'image', 'video', 'document').optional(),
    fileUri: Joi.string().allow(null, '').optional(),
    fileName: Joi.string().max(255).allow(null, '').optional(),
    orderIndex: Joi.number().integer().min(0).optional(),
    order_index: Joi.number().integer().min(0).optional(),
}).custom((value) => {
    if (!value.contentType && value.content_type) value.contentType = value.content_type;
    if (!value.body && value.content) value.body = value.content;
    if (value.order_index !== undefined && value.orderIndex === undefined) value.orderIndex = value.order_index;
    delete value.content_type;
    delete value.content;
    delete value.order_index;
    return value;
}).min(1);
// ─── Submissions ─────────────────────────────────────────
export const createSubmissionSchema = Joi.object({
    taskId: Joi.number().integer().optional(),
    task_id: Joi.number().integer().optional(),
    student_id: Joi.any().strip().optional(), // Ignorar student_id (viene del token)
    fileUri: Joi.string().allow(null, '').optional(),
    file_uri: Joi.string().allow(null, '').optional(),
    file_url: Joi.string().allow(null, '').optional(),
    fileName: Joi.string().max(255).allow(null, '').optional(),
    file_name: Joi.string().max(255).allow(null, '').optional(),
    content: Joi.string().max(255).allow(null, '').optional(),
    textContent: Joi.string().max(50000).allow(null, '').optional(),
    text: Joi.string().max(50000).allow(null, '').optional(),
    additionalFiles: Joi.array().items(
        Joi.object({
            fileUri: Joi.string().allow(null, '').optional(),
            fileName: Joi.string().max(255).allow(null, '').optional(),
        })
    ).max(20).allow(null).optional(),
    status: Joi.any().strip().optional(),
}).custom((value, helpers) => {
    if (!value.taskId && value.task_id) value.taskId = value.task_id;
    if (!value.fileUri && (value.file_url || value.file_uri)) value.fileUri = value.file_url || value.file_uri;
    if (!value.fileName && (value.content || value.file_name)) value.fileName = value.file_name || value.content;
    if (!value.textContent && value.text) value.textContent = value.text;
    delete value.task_id;
    delete value.file_url;
    delete value.file_uri;
    delete value.content;
    delete value.file_name;
    delete value.text;

    if (!value.taskId) return helpers.error('any.required', { key: 'taskId' });
    return value;
});

// Schema para crear una entrega en nombre de otro usuario (solo para roles con permiso)
export const createSubmissionForStudentSchema = Joi.object({
    taskId: Joi.number().integer().optional(),
    task_id: Joi.number().integer().optional(),
    studentId: Joi.number().integer().required(),
    student_id: Joi.number().integer().optional(),
    fileUri: Joi.string().allow(null, '').optional(),
    file_uri: Joi.string().allow(null, '').optional(),
    file_url: Joi.string().allow(null, '').optional(),
    fileName: Joi.string().max(255).allow(null, '').optional(),
    file_name: Joi.string().max(255).allow(null, '').optional(),
    content: Joi.string().max(255).allow(null, '').optional(),
    textContent: Joi.string().max(50000).allow(null, '').optional(),
    text: Joi.string().max(50000).allow(null, '').optional(),
    additionalFiles: Joi.array().items(
        Joi.object({
            fileUri: Joi.string().allow(null, '').optional(),
            fileName: Joi.string().max(255).allow(null, '').optional(),
        })
    ).max(20).allow(null).optional(),
    status: Joi.any().strip().optional(),
}).custom((value, helpers) => {
    if (!value.taskId && value.task_id) value.taskId = value.task_id;
    if (!value.studentId && value.student_id) value.studentId = value.student_id;
    if (!value.fileUri && (value.file_url || value.file_uri)) value.fileUri = value.file_url || value.file_uri;
    if (!value.fileName && (value.content || value.file_name)) value.fileName = value.file_name || value.content;
    if (!value.textContent && value.text) value.textContent = value.text;
    delete value.task_id;
    delete value.file_url;
    delete value.file_uri;
    delete value.content;
    delete value.file_name;
    delete value.text;
    delete value.student_id;

    if (!value.taskId) return helpers.error('any.required', { key: 'taskId' });
    if (!value.studentId) return helpers.error('any.required', { key: 'studentId' });
    return value;
});

export const gradeSubmissionSchema = Joi.object({
    grade: Joi.number().min(0).max(10).required(),
    feedback: Joi.string().max(5000).allow('', null).optional().default(null),
});

// ─── Comments ────────────────────────────────────────────
export const createCommentSchema = Joi.object({
    videoId: Joi.number().integer().required(),
    content: Joi.string().min(1).max(5000).required(),
    parentId: Joi.number().integer().allow(null).optional(),
});

export const updateCommentSchema = Joi.object({
    content: Joi.string().min(1).max(5000).required(),
});

// ─── Likes ───────────────────────────────────────────────
export const toggleLikeSchema = Joi.object({
    entityType: Joi.string().valid('video', 'comment', 'course').required(),
    entityId: Joi.number().integer().required(),
});

// ─── Notifications ───────────────────────────────────────
export const sendNotificationSchema = Joi.object({
    userId: Joi.number().integer().required(),
    title: Joi.string().min(1).max(200).required(),
    message: Joi.string().min(1).max(5000).required(),
    type: Joi.string().max(50).default('generic'),
    data: Joi.object().allow(null).optional(),
    relatedId: Joi.number().integer().allow(null).optional(),
    senderUsername: Joi.string().max(100).allow(null, '').optional(),
    senderAvatarUrl: Joi.string().max(1000).allow(null, '').optional(),
    thumbnailUrl: Joi.string().max(1000).allow(null, '').optional(),
    thumbnail_url: Joi.string().max(1000).allow(null, '').optional(),
    metadata: Joi.string().max(5000).allow(null, '').optional(),
}).custom((value) => {
    if (!value.thumbnailUrl && value.thumbnail_url) value.thumbnailUrl = value.thumbnail_url;
    delete value.thumbnail_url;
    return value;
});

// ─── Payment ─────────────────────────────────────────────
export const initiatePaymentSchema = Joi.object({
    courseId: Joi.number().integer().required(),
    redirectUrl: Joi.string().uri().optional(),
    userId: Joi.number().integer().optional(), // Ignored — userId comes from JWT
    // Fields sent by the Android client for legacy compatibility.
    // They are stripped and NOT used — amount is fetched from DB, userId from JWT.
    amount: Joi.number().optional(),
    bankCode: Joi.string().allow('', null).optional(),
    payerEmail: Joi.string().allow('', null).optional(),
    payerName: Joi.string().allow('', null).optional(),
    payerDocType: Joi.string().allow('', null).optional(),
    payerDocNumber: Joi.string().allow('', null).optional(),
    ipAddress: Joi.string().allow('', null).optional(),
    userAgent: Joi.string().allow('', null).optional(),
});

// ─── Storage ─────────────────────────────────────────────
export const getUploadUrlSchema = Joi.object({
    key: Joi.string().min(1).max(500).required(),
    contentType: Joi.string().max(100).default('application/octet-stream'),
    prefix: Joi.string().valid('videos', 'thumbnails', 'avatars', 'submissions', 'content', 'courses', 'images').default('content'),
});

// ─── ID param ────────────────────────────────────────────
export const idParamSchema = Joi.object({
    id: Joi.number().integer().required(),
});
