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
export const createTaskSchema = Joi.object({
    id: Joi.any().strip().optional(),
    title: Joi.string().min(1).max(300).required(),
    description: Joi.string().max(5000).allow('', null).optional(),
    topicId: Joi.number().integer().required(),
    courseId: Joi.number().integer().allow(null).optional(),
    dueDate: Joi.date().iso().allow(null).optional(),
    maxScore: Joi.number().min(0).max(1000).default(100),
    orderIndex: Joi.number().integer().min(0).default(0),
});

export const updateTaskSchema = Joi.object({
    title: Joi.string().min(1).max(300).optional(),
    description: Joi.string().max(5000).allow('', null).optional(),
    dueDate: Joi.date().iso().allow(null).optional(),
    maxScore: Joi.number().min(0).max(1000).optional(),
    isActive: Joi.boolean().optional(),
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
    taskId: Joi.number().integer().required(),
    fileUri: Joi.string().uri().allow(null, '').optional(),
    fileName: Joi.string().max(255).allow(null, '').optional(),
    textContent: Joi.string().max(50000).allow(null, '').optional(),
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