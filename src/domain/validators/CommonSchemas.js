/**
 * Joi Validation Schemas — Common (Topics, Tasks, ContentItems, Submissions, etc.)
 */
import Joi from 'joi';

// ─── Topics ──────────────────────────────────────────────
export const createTopicSchema = Joi.object({
    title: Joi.string().min(1).max(200).required(),
    description: Joi.string().max(2000).allow('').optional(),
    courseId: Joi.number().integer().required(),
    orderIndex: Joi.number().integer().min(0).default(0),
});

export const updateTopicSchema = Joi.object({
    title: Joi.string().min(1).max(200).optional(),
    description: Joi.string().max(2000).allow('').optional(),
    orderIndex: Joi.number().integer().min(0).optional(),
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
    orderIndex: Joi.number().integer().min(0).default(0),
    order_index: Joi.number().integer().min(0).optional(),
}).custom((value, helpers) => {
    // Normalizar: preferir camelCase, fusionar snake_case si falta
    if (!value.topicId && value.topic_id) value.topicId = value.topic_id;
    if (!value.dueDate && value.due_date) value.dueDate = value.due_date;
    delete value.topic_id;
    delete value.due_date;
    delete value.order_index;
    if (!value.topicId) return helpers.error('any.required', { key: 'topicId' });
    return value;
});

export const updateTaskSchema = Joi.object({
    title: Joi.string().min(1).max(300).optional(),
    description: Joi.string().max(5000).allow('', null).optional(),
    dueDate: Joi.date().iso().allow(null).optional(),
    due_date: Joi.date().iso().allow(null).optional(),
}).custom((value) => {
    if (!value.dueDate && value.due_date) value.dueDate = value.due_date;
    delete value.due_date;
    return value;
}).min(1);

// ─── Content Items ───────────────────────────────────────
export const createContentItemSchema = Joi.object({
    taskId: Joi.number().integer().required(),
    topicId: Joi.number().integer().allow(null).optional(),
    contentType: Joi.string().valid('text', 'file', 'link', 'image', 'video').default('text'),
    content: Joi.string().max(50000).allow('').optional(),
    fileUri: Joi.string().uri().allow(null, '').optional(),
    fileName: Joi.string().max(255).allow(null, '').optional(),
    orderIndex: Joi.number().integer().min(0).default(0),
});

export const updateContentItemSchema = Joi.object({
    content: Joi.string().max(50000).allow('').optional(),
    contentType: Joi.string().valid('text', 'file', 'link', 'image', 'video').optional(),
    fileUri: Joi.string().uri().allow(null, '').optional(),
    fileName: Joi.string().max(255).allow(null, '').optional(),
    orderIndex: Joi.number().integer().min(0).optional(),
}).min(1);
// ─── Submissions ─────────────────────────────────────────
export const createSubmissionSchema = Joi.object({
    taskId: Joi.number().integer().optional(),
    task_id: Joi.number().integer().optional(),
    student_id: Joi.any().strip().optional(), // Ignorar student_id (viene del token)
    fileUri: Joi.string().uri().allow(null, '').optional(),
    file_url: Joi.string().uri().allow(null, '').optional(),
    fileName: Joi.string().max(255).allow(null, '').optional(),
    content: Joi.string().max(255).allow(null, '').optional(), // Android envía content como fileName
    textContent: Joi.string().max(50000).allow(null, '').optional(),
    status: Joi.any().strip().optional(), // Ignorar status
}).custom((value, helpers) => {
    if (!value.taskId && value.task_id) value.taskId = value.task_id;
    if (!value.fileUri && value.file_url) value.fileUri = value.file_url;
    if (!value.fileName && value.content) value.fileName = value.content;
    delete value.task_id;
    delete value.file_url;
    delete value.content;
    
    if (!value.taskId) return helpers.error('any.required', { key: 'taskId' });
    return value;
});

export const gradeSubmissionSchema = Joi.object({
    grade: Joi.number().min(0).max(100).required(),
    feedback: Joi.string().max(5000).allow('').optional(),
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
    metadata: Joi.string().max(5000).allow(null, '').optional(),
});

// ─── Payment ─────────────────────────────────────────────
export const initiatePaymentSchema = Joi.object({
    courseId: Joi.number().integer().required(),
    redirectUrl: Joi.string().uri().required(),
});

// ─── Storage ─────────────────────────────────────────────
export const getUploadUrlSchema = Joi.object({
    key: Joi.string().min(1).max(500).required(),
    contentType: Joi.string().max(100).default('application/octet-stream'),
    prefix: Joi.string().valid('videos', 'thumbnails', 'avatars', 'submissions', 'content', 'courses').default('content'),
});

// ─── ID param ────────────────────────────────────────────
export const idParamSchema = Joi.object({
    id: Joi.number().integer().required(),
});