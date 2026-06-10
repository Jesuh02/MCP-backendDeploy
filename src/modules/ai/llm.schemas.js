/**
 * LLMSchemas — Joi schemas para validación de endpoints LLM.
 */

import Joi from 'joi';

export const processPromptSchema = Joi.object({
    prompt: Joi.string().min(1).required(),
    model: Joi.string().allow('', null).optional(),
    courseId: Joi.number().integer().optional(),
    taskDescription: Joi.string().allow('', null).optional(),
    fileContent: Joi.string().allow('', null).optional(),
    fileUri: Joi.string().allow('', null).optional(),
    file_uri: Joi.string().allow('', null).optional(),
    studentId: Joi.number().integer().optional(),
    student_id: Joi.number().integer().optional(),
    userId: Joi.number().integer().optional(),
    sessionId: Joi.string().allow('', null).optional(),
    session_id: Joi.string().allow('', null).optional(),
    ollamaUrl: Joi.string().allow('', null).optional(),
    jsonContent: Joi.any().optional(),
    submissionId: Joi.number().integer().optional(),
    taskId: Joi.number().integer().optional(),
    topicId: Joi.number().integer().optional(),
    topic_id: Joi.number().integer().optional(),
    freeLearning: Joi.boolean().optional(),
    forceMCPTools: Joi.boolean().optional(),
    difficulty: Joi.string().valid('EASY', 'INTERMEDIATE', 'HARD').optional(),
    userRoles: Joi.array().items(Joi.number().integer()).optional(),
    imageBase64: Joi.string().allow('', null).max(10_000_000).optional(), // max ~7.5MB image
    courseMode: Joi.boolean().optional(),
    fastMode: Joi.boolean().optional(),
    courseDraft: Joi.object({
        topic: Joi.string().allow('', null).optional(),
        area: Joi.string().allow('', null).optional(),
        objective: Joi.string().allow('', null).optional(),
        level: Joi.string().allow('', null).optional(),
        durationWeeks: Joi.number().integer().positive().allow(null).optional(),
        hoursPerWeek: Joi.number().positive().allow(null).optional(),
        studentProfile: Joi.string().allow('', null).optional(),
        lastAskedField: Joi.string().allow('', null).optional(),
    }).optional(),
    conversationHistory: Joi.array().items(Joi.object({
        role: Joi.string().valid('user', 'assistant').required(),
        content: Joi.string().allow('').required(),
    })).max(20).optional(),
}).options({ allowUnknown: true });

export const analyzeSubmissionSchema = Joi.object({
    submissionId: Joi.number().integer().optional(),
    fileUri: Joi.string().allow('', null).optional(),
    file_uri: Joi.string().allow('', null).optional(),
    fileName: Joi.string().allow('', null).optional(),
    file_name: Joi.string().allow('', null).optional(),
    taskDescription: Joi.string().allow('', null).optional(),
    task_description: Joi.string().allow('', null).optional(),
    prompt: Joi.string().allow('', null).optional(),
    courseId: Joi.number().integer().optional(),
}).options({ allowUnknown: true });

export const feedbackSchema = Joi.object({
    submissionId: Joi.number().integer().required(),
    question: Joi.string().min(1).required(),
});

export const confirmCoursePlanSchema = Joi.object({
    plan: Joi.object({
        title: Joi.string().min(1).max(300).required(),
        description: Joi.string().allow('', null).optional(),
        category: Joi.string().allow('', null).optional(),
        level: Joi.string().allow('', null).optional(),
        durationWeeks: Joi.number().integer().optional(),
        subjects: Joi.array().items(Joi.object({
            name: Joi.string().min(1).required(),
            description: Joi.string().allow('', null).optional(),
            topics: Joi.array().items(Joi.object({
                title: Joi.string().min(1).required(),
                description: Joi.string().allow('', null).optional(),
                contentDescription: Joi.string().allow('', null).optional(),
                tasks: Joi.array().items(Joi.object({
                    title: Joi.string().min(1).required(),
                    description: Joi.string().allow('', null).optional(),
                    dueWeek: Joi.number().integer().optional(),
                    contentDescription: Joi.string().allow('', null).optional(),
                })).optional(),
            })).optional(),
        })).min(1).required(),
    }).required(),
    model: Joi.string().allow('', null).optional(),
    userId: Joi.number().integer().optional(),
    username: Joi.string().allow('', null).optional(),
    sessionId: Joi.string().allow('', null).optional(),
    session_id: Joi.string().allow('', null).optional(),
}).options({ allowUnknown: true });

export const generateCourseContentSchema = Joi.object({
    courseId: Joi.number().integer().positive().required(),
    courseTitle: Joi.string().min(1).max(300).required(),
    topics: Joi.array().items(Joi.object({
        id: Joi.number().integer().positive().required(),
        title: Joi.string().min(1).required(),
        description: Joi.string().allow('', null).optional(),
        contentDescription: Joi.string().allow('', null).optional(),
        subjectName: Joi.string().min(1).required(),
    })).min(1).required(),
    model: Joi.string().allow('', null).optional(),
});

export default { processPromptSchema, analyzeSubmissionSchema, feedbackSchema, confirmCoursePlanSchema, generateCourseContentSchema };

