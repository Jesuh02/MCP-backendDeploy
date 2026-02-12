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
    async processPrompt({ prompt, model, courseId, taskDescription, fileContent, fileUri, studentId, userId }) {
        if (!prompt || prompt.trim().length === 0) {
            return Result.fail(new ValidationError('El prompt es requerido'));
        }

        try {
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
            if (taskDescription) {
                systemPrompt += `\n\nContexto de la tarea: ${taskDescription}`;
            }
            if (ragContext) {
                systemPrompt += `\n\nContexto relevante del curso:\n${ragContext}`;
            }

            // 3. Build user prompt with file content if available
            let fullPrompt = prompt;
            if (fileContent) {
                fullPrompt = `Contenido del archivo:\n${fileContent}\n\nPregunta/Instrucción: ${prompt}`;
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

            // 6. Reinforcement history save is handled by the client via /reinforcement/save-questions
            // which uses MCPService with full uniqueness flow (hash + embedding + semantic dedup)
            // and correctly passes topicId/taskId. Do NOT save here to avoid duplicates.

            return Result.ok({
                response: response.content,
                model: response.model,
                usage: response.usage,
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