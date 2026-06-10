/**
 * LLMController — Controlador HTTP para procesamiento LLM.
 *
 * Recibe requests HTTP, valida con Joi, delega a LLMDomainService,
 * y devuelve respuestas estandarizadas.
 */

import { processPromptSchema, analyzeSubmissionSchema, feedbackSchema, confirmCoursePlanSchema, generateCourseContentSchema } from './llm.schemas.js';
import { ValidationError } from '../../shared/errors/index.js';
import { TENANT_CONFIGS, getCurrentTenantId, getAllTenantEntries } from '../../config/tenantRegistry.js';
import { SupabaseUserRepository } from '../user/infrastructure/supabase.user.repository.js';

export class LLMController {
    constructor({ llmService, excelService = null }) {
        this.llmService = llmService;
        this.excelService = excelService;
    }

    /**
     * Returns true when the user's prompt (and optional progress context) indicates an intent
     * to export student progress as an Excel/spreadsheet file.
     */
    _isProgressExcelIntent(prompt, taskDescription = '') {
        const excelKw = /\b(excel|xls|xlsx|exportar|descargar\s+reporte|generar\s+reporte|haz?\s+un?\s+excel|crea?\s+un?\s+excel|spreadsheet|hoja\s+de\s+c[aá]lculo|reporte\s+excel)\b/i;
        const progressKw = /\b(progreso|estudiantes?|calificaci[oó]n(es)?|notas?|avance|rendimiento)\b/i;
        const combined = `${prompt} ${taskDescription}`;
        return excelKw.test(combined) && (progressKw.test(combined) || taskDescription.includes('RESUMEN DE PROGRESO'));
    }

    /**
     * Returns true when the user's prompt indicates ANY intent to generate an Excel file,
     * regardless of topic (progress, payments, users, etc.).
     */
    _isExcelIntent(prompt) {
        return /\b(excel|xls|xlsx|exportar|descargar\s+reporte|generar\s+reporte|haz?\s+un?\s+excel|crea?\s+un?\s+excel|spreadsheet|hoja\s+de\s+c[aá]lculo|reporte\s+excel)\b/i.test(prompt);
    }

    /**
     * Detects if the prompt asks about which institutions the user belongs to.
     * e.g. "¿En cuántas instituciones estoy?", "mis instituciones", "a qué instituciones pertenezco"
     */
    _isInstitutionLookupIntent(prompt) {
        const p = prompt.toLowerCase();
        return /\b(cu[aá]ntas?\s+instituciones|en\s+qu[eé]\s+instituciones|mis\s+instituciones|instituciones\s+pertenezco|instituciones\s+estoy|a\s+qu[eé]\s+instituciones|pertenezco\s+a\s+(?:cu[aá]ntas?|qu[eé])\s+instituciones)\b/i.test(p);
    }

    /**
     * Searches a username across all registered tenant databases and returns
     * a human-readable summary of the institutions found.
     */
    async _lookupUserInstitutions(username) {
        const entries = getAllTenantEntries();
        const results = await Promise.allSettled(
            entries.map(async (entry) => {
                if (!entry.client) return null;
                const repo = new SupabaseUserRepository(entry.client);
                const user = await repo.findByUsername(username);
                if (!user) return null;
                return {
                    tenantId: entry.id,
                    tenantName: entry.name,
                    username: user.username,
                    roles: (user.roles || []).map(r => r.nombre || r.name || r.id || r),
                };
            }),
        );
        return results
            .filter(r => r.status === 'fulfilled' && r.value !== null)
            .map(r => r.value);
    }

    processPrompt = async(req, res, next) => {
        try {
            const { error, value } = processPromptSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            // Normalize field names (Android client sends both formats)
            // Resolve tenant context: TenantMiddleware has already run and set the AsyncLocalStorage
            // context. getCurrentTenantId() returns the tenant resolved from X-Tenant-Id / JWT.
            const resolvedTenantId = getCurrentTenantId() || req.user?.tenantId || 'qa-develop';
            const jwtAvailableTenants = Array.isArray(req.user?.availableTenants)
                ? req.user.availableTenants
                : (req.user?.tenantId ? [{ id: req.user.tenantId, name: req.user.tenantId }] : [{ id: resolvedTenantId, name: resolvedTenantId }]);
            const institutionName = TENANT_CONFIGS.find(t => t.id === resolvedTenantId)?.name ?? resolvedTenantId;

            const params = {
                prompt: value.prompt,
                model: value.model,
                courseId: value.courseId,
                taskDescription: value.taskDescription,
                fileContent: value.fileContent,
                fileUri: value.fileUri || value.file_uri,
                studentId: value.studentId || value.student_id,
                userId: req.user?.userId || value.userId,
                // Authenticated username from JWT — used for course ownership lookup.
                // Fall back to body-supplied username (for Android/web clients).
                username: req.user?.username || value.username || null,
                submissionId: value.submissionId,
                taskId: value.taskId,
                topicId: value.topicId || value.topic_id,
                freeLearning: value.freeLearning || false,
                forceMCPTools: value.forceMCPTools || false,
                difficulty: value.difficulty || null,
                // Pass authenticated user's roles for data-access scoping.
                // Prefer JWT roles (from req.user), fall back to body-supplied roles (for Android without JWT).
                userRoles: (req.user?.roles || value.userRoles || []).map(Number),
                // Multi-tenant context: which institution is active and which ones are available
                tenantId: resolvedTenantId,
                availableTenants: jwtAvailableTenants,
                institutionName,
                // Vision: base64-encoded image for multimodal analysis
                imageBase64: value.imageBase64 || null,
                // Fast mode: shorten primary-model timeout to 10s so chat UIs (ChatBot,
                // DatabaseQuery view, WhatsApp) fail over to DeepSeek faster instead of
                // waiting up to 5 min for Qwen.
                fastMode: value.fastMode === true,
                // Course planner mode: bypasses the educational assistant system prompt
                // and uses a dedicated course planner system prompt instead.
                courseMode: value.courseMode === true,
                // Course planner state: lets the model interpret short replies like
                // "intermedio" as the answer to the previous question.
                courseDraft: value.courseDraft || null,
                conversationHistory: Array.isArray(value.conversationHistory) ? value.conversationHistory : [],
            };

            // ── INSTITUTION LOOKUP SHORT-CIRCUIT ──────────────────────────────────
            // Detect "¿En cuántas instituciones estoy?" and answer directly without LLM.
            if (this._isInstitutionLookupIntent(value.prompt)) {
                const username = req.user?.username || null;
                if (!username) {
                    return res.json({
                        success: true,
                        data: {
                            response: '❌ No se pudo determinar tu nombre de usuario. Inicia sesión nuevamente.',
                            respuesta_texto: '❌ No se pudo determinar tu nombre de usuario. Inicia sesión nuevamente.',
                        },
                    });
                }
                try {
                    const found = await this._lookupUserInstitutions(username);
                    let response;
                    if (found.length === 0) {
                        response = `No se encontró el usuario **${username}** en ninguna institución registrada.`;
                    } else {
                        const list = found.map((f, i) =>
                            `${i + 1}. **${f.tenantName}** — Roles: ${Array.isArray(f.roles) && f.roles.length > 0 ? f.roles.join(', ') : 'Sin roles asignados'}`,
                        ).join('\n');
                        response = `🏛️ El usuario **${username}** está registrado en **${found.length}** institución(es):\n\n${list}`;
                    }
                    return res.json({
                        success: true,
                        data: { response, respuesta_texto: response },
                    });
                } catch (lookupErr) {
                    console.error('[LLM] Institution lookup error:', lookupErr.message);
                    // Fall through to normal LLM processing
                }
            }

            // Excel is generated AFTER processPrompt so we can use the exact rows
            // the LLM queried, preventing row-count mismatches between text and spreadsheet.
            // excelDataForContext is no longer needed before the LLM call.
            const isExcelRequest = this.excelService && this._isExcelIntent(params.prompt);

            const result = await this.llmService.processPrompt(params);
            if (result.isFail()) return next(result.getError());

            const resultValue = result.getValue();

            // ── Build Excel from the LLM's own query results ──────────────────────
            let excelUrl = null;
            if (isExcelRequest) {
                try {
                    // Prefer rawQueryData: the exact rows the LLM described to the user.
                    // Fall back to generateFromQuery (independent agent) only when rawQueryData is absent.
                    const rawRows = resultValue.rawQueryData;
                    if (Array.isArray(rawRows)) {
                        const excelBuffer = await this.excelService._buildStyledWorkbook({
                            data: rawRows,
                            sheetTitle: 'Reporte',
                            query: params.prompt,
                            username: params.username,
                            generatedAt: new Date(),
                        });
                        const timestamp = Date.now();
                        const filename = `reports/excel_export_${params.userId || 'anon'}_${timestamp}.xlsx`;
                        if (!this.excelService.fileStoragePort) {
                            console.error('[LLM] fileStoragePort no disponible — R2 no configurado');
                        } else {
                        const uploadResult = await this.excelService.fileStoragePort.uploadFile(
                            excelBuffer,
                            filename,
                            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                        );
                        excelUrl = uploadResult?.getValue ? uploadResult.getValue() : uploadResult;
                        console.log(`[LLM] Excel generado desde rawQueryData: ${excelUrl} (${rawRows.length} filas)`);
                        }
                    } else {
                        // Fallback: independent agent query (may produce different row count)
                        let excelQuery = params.prompt;
                        if (this._isProgressExcelIntent(params.prompt, params.taskDescription || '')) {
                            excelQuery = (params.taskDescription || '').includes('RESUMEN DE PROGRESO')
                                ? `Progreso de estudiantes: ${params.taskDescription}`
                                : `Progreso de todos los estudiantes en los cursos del docente con userId ${params.userId}`;
                        }
                        const excelResult = await this.excelService.generateFromQuery({
                            query: excelQuery,
                            userId: String(params.userId || 'anon'),
                            username: params.username,
                            userRoles: params.userRoles,
                        });
                        if (!excelResult.isFail()) {
                            const excelValue = excelResult.getValue();
                            excelUrl = excelValue.url;
                            console.log(`[LLM] Excel generado (fallback agent): ${excelUrl} (${excelValue.rows} filas)`);
                        }
                    }
                } catch (excelErr) {
                    console.error('[LLM] Error generando Excel:', excelErr.message);
                }
            }

            // Adapt to legacy Android client expectations (respuesta_texto)
            const data = {
                ...resultValue,
                respuesta_texto: resultValue.response,
                ...(excelUrl && { excelUrl }),
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

    generateCourseContent = async (req, res, next) => {
        try {
            const { error, value } = generateCourseContentSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const userId = req.user?.id || req.user?.userId || null;
            const username = req.user?.username || null;

            const result = await this.llmService.generateCourseContent({
                ...value,
                userId,
                username,
            });
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    confirmCoursePlan = async (req, res, next) => {
        try {
            const { error, value } = confirmCoursePlanSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const userId = req.user?.userId || req.user?.id || value.userId || null;
            const username = req.user?.username || value.username || null;

            const result = await this.llmService.confirmCoursePlan({
                plan: value.plan,
                userId,
                username,
                model: value.model,
            });
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default LLMController;

