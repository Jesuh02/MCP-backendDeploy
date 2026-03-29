/**
 * LLMController — Controlador HTTP para procesamiento LLM.
 *
 * Recibe requests HTTP, valida con Joi, delega a LLMDomainService,
 * y devuelve respuestas estandarizadas.
 */

import { processPromptSchema, analyzeSubmissionSchema, feedbackSchema } from './llm.schemas.js';
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
                : (req.user?.tenantId ? [req.user.tenantId] : [resolvedTenantId]);
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
                // Authenticated username from JWT — used for course ownership lookup
                username: req.user?.username || null,
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

            // Detect Excel generation intent for student progress and generate the file proactively
            let excelUrl = null;
            if (this.excelService && this._isProgressExcelIntent(params.prompt, params.taskDescription || '')) {
                try {
                    const progressQuery = (params.taskDescription || '').includes('RESUMEN DE PROGRESO')
                        ? `Progreso de estudiantes: ${params.taskDescription}`
                        : `Progreso de todos los estudiantes en los cursos del docente con userId ${params.userId}`;

                    const excelResult = await this.excelService.generateFromQuery({
                        query: progressQuery,
                        userId: String(params.userId || 'anon'),
                        username: params.username,
                        userRoles: params.userRoles,
                    });

                    if (!excelResult.isFail()) {
                        excelUrl = excelResult.getValue().url;
                        console.log(`[LLM] Excel de progreso generado: ${excelUrl}`);
                    }
                } catch (excelErr) {
                    console.error('[LLM] Error generando Excel de progreso:', excelErr.message);
                }
            }

            const result = await this.llmService.processPrompt(params);
            if (result.isFail()) return next(result.getError());

            const resultValue = result.getValue();
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
}
export default LLMController;

