/**
 * LLMDomainService — Caso de uso para procesamiento de prompts con LLM.
 *
 * Depende de ILLMPort, IRAGPort, ICachePort, IGitHubPort, IFileStoragePort,
 * ISubmissionRepository, IFileContextRepository, IReinforcementRepository.
 * NO importa nada de infraestructura.
 *
 * Este servicio centraliza TODA la lógica que estaba en:
 *   - index.js: /procesar-prompt, /analizar-entrega, /feedback-entrega
 *   - llmRoutes.js: /procesar-prompt
 *
 * Principios:
 *   - SRP: orquesta flujo LLM (RAG + prompt + analysis)
 *   - DIP: depende de puertos abstractos
 *   - OCP: nuevo modelo LLM = nuevo adaptador
 */

import { Result } from '../../shared/Result.js';
import { ValidationError, NotFoundError } from '../../shared/errors/index.js';

export class LLMDomainService {
    constructor({
        llmPort,
        ragPort,
        cachePort,
        githubPort,
        fileStoragePort,
        submissionRepository,
        fileContextRepository,
        reinforcementRepository,
    }) {
        this.llm = llmPort;
        this.rag = ragPort;
        this.cache = cachePort;
        this.github = githubPort;
        this.storage = fileStoragePort;
        this.submissionRepo = submissionRepository;
        this.fileContextRepo = fileContextRepository;
        this.reinforcementRepo = reinforcementRepository;
    }

    /**
     * Procesa un prompt con RAG y contexto inteligente.
     * @param {{ prompt: string, model?: string, courseId?: number, taskDescription?: string, fileContent?: string, fileUri?: string, studentId?: number, userId?: number }} params
     * @returns {Promise<Result>}
     */
    async processPrompt({ prompt, model, courseId, taskDescription, fileContent, fileUri, studentId, userId, submissionId, taskId }) {
        if (!prompt || prompt.trim().length === 0) {
            return Result.fail(new ValidationError('El prompt es requerido'));
        }

        try {
            // 0. Auto-fetch file content from R2 when not provided by the client
            let resolvedFileContent = fileContent || '';
            if (!resolvedFileContent) {
                resolvedFileContent = await this._resolveFileContent({ fileUri, submissionId, taskId, studentId });
            }

            // 1. Build RAG context if available
            let ragContext = '';
            if (this.rag && courseId) {
                try {
                    ragContext = await this.rag.buildContext(prompt, { courseId, maxTokens: 2000 });
                } catch (ragErr) {
                    console.warn('[LLMDomainService] RAG context failed, proceeding without:', ragErr.message);
                }
            }

            // 2. Build system prompt with context
            let systemPrompt = 'Eres un asistente educativo experto. Responde de manera clara, precisa y útil.';

            // INSTRUCCIÓN SEMÁNTICA: Detección de intención de calificación (Requerimiento estricto: NO usar regex en input usuario)
            // El LLM es responsable de señalizar si es una solicitud de nota válida.
            systemPrompt += `\n\nIMPORTANTE: Tu eres capaz de detectar la intención del usuario. Si el usuario te pide explícitamente CALIFICAR, EVALUAR o dar una NOTA a la entrega/tarea adjunta, debes iniciar tu respuesta con la etiqueta exacta: [GRADING_REQUEST].
Si además determinas una nota numérica (0-100), usa el formato: [GRADING_REQUEST: <monto>] (Ejemplo: "[GRADING_REQUEST: 85]").
Si la solicitud es una pregunta general o no implica calificación formal (ej: "¿Qué nota tiene la escala musical?"), NO incluyas esta etiqueta.`;

            if (taskDescription) {
                systemPrompt += `\n\nContexto de la tarea: ${taskDescription}`;
            }
            if (ragContext) {
                systemPrompt += `\n\nContexto relevante del curso:\n${ragContext}`;
            }

            // 3. Build user prompt with file content if available
            let fullPrompt = prompt;
            if (resolvedFileContent) {
                fullPrompt = `Contenido del archivo:\n${resolvedFileContent}\n\nPregunta/Instrucción: ${prompt}`;
            }

            // 4. Check reinforcement history to avoid repetitions
            if (userId && courseId && this._isReinforcementRequest(prompt)) {
                try {
                    const history = await this.reinforcementRepo.getHistory(userId, courseId);
                    if (history && history.length > 0) {
                        systemPrompt += `\n\nPreguntas ya generadas (NO repetir):\n${JSON.stringify(history)}`;
                    }
                } catch (histErr) {
                    console.warn('[LLMDomainService] Reinforcement history failed:', histErr.message);
                }
            }

            // 5. Call LLM
            const response = await this.llm.chat(systemPrompt, fullPrompt, { model });

            // 6. Post-process response to detect Grading Signal
            let content = response.content;
            let esCalificacion = false;
            let nota = null;

            // Extract signal from LLM response (Semantic Detection)
            const gradingSignal = content.match(/^\[GRADING_REQUEST(?::\s*(\d+(?:\.\d+)?))?\]\s*/i);
            if (gradingSignal) {
                esCalificacion = true;
                if (gradingSignal[1]) {
                    nota = parseFloat(gradingSignal[1]);
                }
                // Cleanup the tag so user doesn't see it
                content = content.replace(gradingSignal[0], '');
            }

            // 7. Reinforcement history save is handled by the client via /reinforcement/save-questions
            // which uses MCPService with full uniqueness flow (hash + embedding + semantic dedup)
            // and correctly passes topicId/taskId. Do NOT save here to avoid duplicates.

            // 8. AUTO-SAVE GRADE: If LLM detected a grading request, persist to task_submissions
            if (esCalificacion && nota !== null && !isNaN(nota)) {
                const gradeValue = Math.max(0, Math.min(100, nota));
                const feedbackText = content; // The LLM response is the feedback

                try {
                    let targetSubmission = null;

                    // Strategy 1: Find by submissionId
                    if (submissionId && this.submissionRepo) {
                        targetSubmission = await this.submissionRepo.findById(submissionId);
                    }

                    // Strategy 2: Find by taskId + studentId
                    if (!targetSubmission && taskId && studentId && this.submissionRepo) {
                        targetSubmission = await this.submissionRepo.findByUserAndTask(studentId, taskId);
                    }

                    if (targetSubmission) {
                        await this.submissionRepo.update(targetSubmission.id, {
                            grade: gradeValue,
                            feedback: feedbackText.substring(0, 5000), // Limit feedback length
                        });
                        console.log(`✅ [LLMDomainService] Auto-saved grade ${gradeValue} to submission #${targetSubmission.id}`);
                    } else {
                        console.warn(`⚠️ [LLMDomainService] Grading detected (nota=${nota}) but no submission found (submissionId=${submissionId}, taskId=${taskId}, studentId=${studentId})`);
                    }
                } catch (gradeErr) {
                    console.error(`❌ [LLMDomainService] Failed to auto-save grade:`, gradeErr.message);
                }
            }

            return Result.ok({
                response: content,
                model: response.model,
                usage: response.usage,
                esCalificacion,
                nota
            });
        } catch (err) {
            return Result.fail(new ValidationError(`Procesamiento LLM falló: ${err.message}`));
        }
    }

    /**
     * Analiza una entrega de tarea (archivo / repo GitHub).
     * @param {{ submissionId: number, fileUri: string, fileName: string, taskDescription: string, prompt?: string, courseId?: number }} params
     * @returns {Promise<Result>}
     */
    async analyzeSubmission({ submissionId, fileUri, fileName, taskDescription, prompt, courseId }) {
        if (!taskDescription) {
            return Result.fail(new ValidationError('taskDescription es requerida'));
        }

        try {
            // 1. Get file content
            let fileContent = '';
            if (fileUri) {
                // Check if it's a GitHub repo
                if (this._isGitHubRepo(fileName)) {
                    const repoUrl = this._extractGitHubUrl(fileName);
                    if (this.github && this.github.isAvailable()) {
                        const analysis = await this.github.analyzeRepository(repoUrl, { taskDescription, prompt });
                        fileContent = JSON.stringify(analysis);
                    }
                } else {
                    // Check file_contexts first
                    if (submissionId && this.fileContextRepo) {
                        try {
                            const ctx = await this.fileContextRepo.findBySubmissionId(submissionId);
                            if (ctx && ctx.content) {
                                fileContent = ctx.content;
                            }
                        } catch (_) { /* ignore */ }
                    }

                    // Fallback to storage
                    if (!fileContent && this.storage) {
                        try {
                            const objectKey = this._extractR2ObjectKey(fileUri);
                            if (objectKey) {
                                const file = await this.storage.downloadFile(objectKey);
                                fileContent = file.toString('utf-8');
                            }
                        } catch (_) { /* ignore */ }
                    }
                }
            }

            // 2. Build analysis prompt
            const systemPrompt = `Eres un profesor experto evaluando entregas de tareas.
Analiza la entrega del estudiante y proporciona:
1. Una nota del 0 al 100
2. Un resumen detallado del análisis
3. Porcentaje de cumplimiento de los requisitos

Descripción de la tarea: ${taskDescription}

Responde SIEMPRE en formato JSON:
{"nota": <0-100>, "resumen": "<análisis detallado>", "cumplimiento": <0-100>}`;

            const userPrompt = fileContent ?
                `Contenido de la entrega:\n${fileContent}\n\n${prompt || 'Evalúa esta entrega.'}` :
                `No se pudo obtener el contenido del archivo. ${prompt || 'Evalúa basándote en la descripción.'}`;

            // 3. Check cache
            const cacheKey = `analysis_${submissionId}_${Date.now()}`;
            if (this.cache && submissionId) {
                const cached = this.cache.get(`analysis_${submissionId}`);
                if (cached) return Result.ok(cached);
            }

            // 4. Call LLM
            const response = await this.llm.chat(systemPrompt, userPrompt);

            // 5. Parse response
            let analysis;
            try {
                const jsonMatch = response.content.match(/\{[\s\S]*\}/);
                analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { nota: 0, resumen: response.content, cumplimiento: 0 };
            } catch {
                analysis = { nota: 0, resumen: response.content, cumplimiento: 0 };
            }

            // 6. Cache result
            if (this.cache && submissionId) {
                this.cache.set(`analysis_${submissionId}`, analysis, 30 * 60 * 1000); // 30 min
            }

            return Result.ok(analysis);
        } catch (err) {
            return Result.fail(new ValidationError(`Análisis de entrega falló: ${err.message}`));
        }
    }

    /**
     * Feedback conversacional sobre una entrega ya analizada.
     * @param {{ submissionId: number, question: string }} params
     * @returns {Promise<Result>}
     */
    async feedbackSubmission({ submissionId, question }) {
            if (!submissionId || !question) {
                return Result.fail(new ValidationError('submissionId y question son requeridos'));
            }

            try {
                // Get cached analysis
                let cachedAnalysis = null;
                if (this.cache) {
                    cachedAnalysis = this.cache.get(`analysis_${submissionId}`);
                }

                const systemPrompt = `Eres un profesor experto. El estudiante te hace una pregunta sobre la calificación de su tarea.
${cachedAnalysis ? `Análisis previo: Nota=${cachedAnalysis.nota}, Resumen=${cachedAnalysis.resumen}` : 'No hay análisis previo disponible.'}
Responde de forma clara y constructiva.`;

            const response = await this.llm.chat(systemPrompt, question);

            return Result.ok({
                response: response.content,
                model: response.model,
            });
        } catch (err) {
            return Result.fail(new ValidationError(`Feedback falló: ${err.message}`));
        }
    }

    /**
     * Resolves file content from R2/Supabase when the client did not send it.
     * Tries in order: fileUri direct download, submissionId lookup, taskId+studentId lookup.
     * @private
     */
    async _resolveFileContent({ fileUri, submissionId, taskId, studentId }) {
        // Strategy 1: Download directly from R2 using fileUri
        if (fileUri && this.storage && this.storage.isAvailable()) {
            try {
                const objectKey = this._extractR2ObjectKey(fileUri);
                if (objectKey) {
                    console.log(`[LLMDomainService] Fetching file from R2: ${objectKey}`);
                    const file = await this.storage.fetchFile(objectKey);
                    const content = file.buffer.toString('utf-8');
                    if (content && content.trim().length > 0) {
                        console.log(`[LLMDomainService] File content resolved from R2 (${content.length} chars)`);
                        return content;
                    }
                }
            } catch (err) {
                console.warn('[LLMDomainService] R2 direct download failed:', err.message);
            }
        }

        // Strategy 2: Lookup submission by submissionId and fetch its file from R2
        if (submissionId && this.submissionRepo) {
            try {
                const submission = await this.submissionRepo.findById(submissionId);
                if (submission && submission.file_uri) {
                    console.log(`[LLMDomainService] Found submission ${submissionId}, file_uri: ${submission.file_uri}`);
                    return await this._fetchContentFromUri(submission.file_uri);
                }
            } catch (err) {
                console.warn('[LLMDomainService] Submission lookup failed:', err.message);
            }
        }

        // Strategy 3: Lookup submission by taskId + studentId
        if (taskId && studentId && this.submissionRepo) {
            try {
                const submission = await this.submissionRepo.findByUserAndTask(studentId, taskId);
                if (submission && submission.file_uri) {
                    console.log(`[LLMDomainService] Found submission for task=${taskId} student=${studentId}, file_uri: ${submission.file_uri}`);
                    return await this._fetchContentFromUri(submission.file_uri);
                }
            } catch (err) {
                console.warn('[LLMDomainService] Task+Student submission lookup failed:', err.message);
            }
        }

        // Strategy 4: Check file_contexts table
        if (submissionId && this.fileContextRepo) {
            try {
                const ctx = await this.fileContextRepo.findBySubmissionId(submissionId);
                if (ctx && ctx.content) {
                    console.log(`[LLMDomainService] File content resolved from file_contexts (${ctx.content.length} chars)`);
                    return ctx.content;
                }
            } catch (_) { /* ignore */ }
        }

        return '';
    }

    /**
     * Fetches text content from an R2 file URI.
     * @private
     */
    async _fetchContentFromUri(uri) {
        if (!uri || !this.storage || !this.storage.isAvailable()) return '';
        // Skip local device paths
        if (!uri.startsWith('http://') && !uri.startsWith('https://')) return '';
        try {
            const objectKey = this._extractR2ObjectKey(uri);
            if (!objectKey) return '';
            console.log(`[LLMDomainService] Downloading from R2: ${objectKey}`);
            const file = await this.storage.fetchFile(objectKey);
            const content = file.buffer.toString('utf-8');
            console.log(`[LLMDomainService] Downloaded ${content.length} chars from R2`);
            return content;
        } catch (err) {
            console.warn('[LLMDomainService] Failed to fetch file from R2:', err.message);
            return '';
        }
    }

    /** @private */
    _isReinforcementRequest(prompt) {
        const keywords = ['refuerzo', 'reinforcement', 'quiz', 'examen', 'pregunta', 'evalua', 'genera pregunta'];
        const lower = (prompt || '').toLowerCase();
        return keywords.some(k => lower.includes(k));
    }

    /** @private */
    _isGitHubRepo(fileName) {
        return fileName && /^github_/i.test(fileName);
    }

    /** @private */
    _extractGitHubUrl(fileName) {
        if (!fileName) return null;
        const parts = fileName.replace(/^github_/i, '').split('_');
        if (parts.length >= 2) {
            return `https://github.com/${parts[0]}/${parts[1]}`;
        }
        return null;
    }

    /** @private */
    _extractR2ObjectKey(url) {
        if (!url) return null;
        try {
            const urlObj = new URL(url);
            return urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;
        } catch {
            return url;
        }
    }
}
export default LLMDomainService;