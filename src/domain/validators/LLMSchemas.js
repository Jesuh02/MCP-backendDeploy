/**
 * LLMSchemas — Joi schemas para validación de endpoints LLM.
 */

import Joi from 'joi';

export const processPromptSchema = Joi.object({
    prompt: Joi.string().min(1).required(),
    model: Joi.string().optional(),
    courseId: Joi.number().integer().optional(),
    taskDescription: Joi.string().optional(),
    fileContent: Joi.string().optional(),
    fileUri: Joi.string().optional(),
    file_uri: Joi.string().optional(),
    studentId: Joi.number().integer().optional(),
    student_id: Joi.number().integer().optional(),
    userId: Joi.number().integer().optional(),
    ollamaUrl: Joi.string().optional(),
    jsonContent: Joi.any().optional(),
}).options({ allowUnknown: true });

export const analyzeSubmissionSchema = Joi.object({
    submissionId: Joi.number().integer().optional(),
    fileUri: Joi.string().optional(),
    file_uri: Joi.string().optional(),
    fileName: Joi.string().optional(),
    file_name: Joi.string().optional(),
    taskDescription: Joi.string().required(),
    task_description: Joi.string().optional(),
    prompt: Joi.string().optional(),
    courseId: Joi.number().integer().optional(),
}).options({ allowUnknown: true });

export const feedbackSchema = Joi.object({
    submissionId: Joi.number().integer().required(),
    question: Joi.string().min(1).required(),
});

export default { processPromptSchema, analyzeSubmissionSchema, feedbackSchema };