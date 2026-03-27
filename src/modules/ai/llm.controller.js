/**
 * LLMController — Controlador HTTP para procesamiento LLM.
 *
 * Recibe requests HTTP, valida con Joi, delega a LLMDomainService,
 * y devuelve respuestas estandarizadas.
 */

import { processPromptSchema, analyzeSubmissionSchema, feedbackSchema } from './llm.schemas.js';
import { ValidationError } from '../../shared/errors/index.js';

export class LLMController {
    constructor({ llmService }) {
        this.llmService = llmService;
    }

    processPrompt = async(req, res, next) => {
        try {
            const { error, value } = processPromptSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            // Normalize field names (Android client sends both formats)
            const params = {
                prompt: value.prompt,
                model: value.model,
                courseId: value.courseId,
                taskDescription: value.taskDescription,
                fileContent: value.fileContent,
                fileUri: value.fileUri || value.file_uri,
                studentId: value.studentId || value.student_id,
                userId: req.user?.userId || value.userId,
                submissionId: value.submissionId,
                taskId: value.taskId,
                topicId: value.topicId || value.topic_id,
                freeLearning: value.freeLearning || false,
                forceMCPTools: value.forceMCPTools || false,
                difficulty: value.difficulty || null,
                // Pass authenticated user's roles for data-access scoping
                userRoles: (req.user?.roles || []).map(Number),
            };

            const result = await this.llmService.processPrompt(params);
            if (result.isFail()) return next(result.getError());

            const resultValue = result.getValue();
            // Adapt to legacy Android client expectations (respuesta_texto)
            const data = {
                ...resultValue,
                respuesta_texto: resultValue.response
            };

            res.json({ success: true, data });
        } catch (err) { next(err); }
    };

    analyzeSubmission = async(req, res, next) => {
        try {
            const { error, value } = analyzeSubmissionSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const params = {
                submissionId: value.submissionId,
                fileUri: value.fileUri || value.file_uri,
                fileName: value.fileName || value.file_name,
                taskDescription: value.taskDescription || value.task_description,
                prompt: value.prompt,
                courseId: value.courseId,
            };

            const result = await this.llmService.analyzeSubmission(params);
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    feedbackSubmission = async(req, res, next) => {
        try {
            const { error, value } = feedbackSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const result = await this.llmService.feedbackSubmission(value);
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default LLMController;

