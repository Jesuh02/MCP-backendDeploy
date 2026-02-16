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
    async processPrompt({ prompt, model, courseId, taskDescription, fileContent, fileUri, studentId, userId, submissionId, taskId, topicId }) {
        if (!prompt || prompt.trim().length === 0) {
            return Result.fail(new ValidationError('El prompt es requerido'));
        }

        try {
            // 0. Auto-fetch file content from R2 when not provided by the client
            let resolvedFileContent = fileContent || '';
            if (!resolvedFileContent) {
                resolvedFileContent = await this._resolveFileContent({ fileUri, submissionId, taskId, studentId });
            }

            // 1. Build RAG context if available — pass topicId/taskId for scoped retrieval
            // For reinforcement requests, use HYBRID RETRIEVAL to combine semantic search
            // with window expansion and progressive coverage for maximum relevance.
            let ragContext = '';
            if (this.rag && courseId) {
                try {
                    if (this._isReinforcementRequest(prompt) && userId) {
                        // Count existing questions to determine which chunk page to use
                        let existingCount = 0;
                        try {
                            const { MCPService } = await
                            import ('./MCPService.js');
                            const mcpService = new MCPService();
                            const history = await mcpService.getReinforcementHistory(
                                userId, courseId, topicId || null, taskId || null
                            );
                            existingCount = (history && history.length) || 0;
                        } catch (_) { /* ignore — will use page 0 */ }

                        const sessionIndex = Math.floor(existingCount / 10);

                        // ═══ HYBRID RETRIEVAL v2: Semantic + Window ONLY ═══
                        // Progressive is used as fallback ONLY when semantic returns 0 results.
                        // This prevents polluting relevant context with unrelated document chunks.
                        const compositeQuery = this._buildCompositeSearchQuery(prompt, topicId, taskId);

                        if (typeof this.rag.getHybridRagContent === 'function') {
                            const filter = { courseId };
                            if (topicId) filter.topicId = topicId;
                            if (taskId) filter.taskId = taskId;

                            const hybridData = await this.rag.getHybridRagContent(compositeQuery, filter, {
                                semanticTopK: 5,
                                windowSize: 2,
                                semanticThreshold: 0.45,
                                sessionIndex, // Only used as progressive fallback if semantic=0
                                maxTokens: 4000,
                                maxChunks: 12,
                            });

                            if (hybridData && hybridData.content) {
                                ragContext = `═══════════════════════════════════════════════════════════\n`;
                                ragContext += `📚 CONTEXTO DEL MATERIAL — Hybrid Retrieval\n`;
                                ragContext += `   Búsqueda semántica: ${hybridData.semanticHits || 0} coincidencias\n`;
                                ragContext += `   Contexto expandido: ${hybridData.expandedChunks || 0} fragmentos\n`;
                                if (hybridData.totalPages > 1) {
                                    ragContext += `   Cobertura progresiva: Sección ${(hybridData.page ?? 0) + 1}/${hybridData.totalPages}\n`;
                                }
                                ragContext += `═══════════════════════════════════════════════════════════\n\n`;
                                ragContext += hybridData.content;
                                ragContext += `\n═══════════════════════════════════════════════════════════\n`;
                                ragContext += `Total: ${hybridData.chunks} fragmentos de ${hybridData.totalChunks} totales.\n`;
                                ragContext += `═══════════════════════════════════════════════════════════\n`;

                                console.log(`[LLMDomainService] Hybrid RAG context: semanticHits=${hybridData.semanticHits}, expanded=${hybridData.expandedChunks}, chunks=${hybridData.chunks}/${hybridData.totalChunks}, session=${sessionIndex}`);
                            }
                        }

                        // Fallback to progressive context if hybrid didn't produce results
                        if (!ragContext && typeof this.rag.getProgressiveRagContent === 'function') {
                            const filter = { courseId };
                            if (topicId) filter.topicId = topicId;
                            if (taskId) filter.taskId = taskId;

                            const progressiveData = await this.rag.getProgressiveRagContent(filter, sessionIndex);

                            if (progressiveData && progressiveData.content) {
                                ragContext = `═══════════════════════════════════════════════════════════\n`;
                                ragContext += `📚 CONTEXTO DEL MATERIAL (Sección ${(progressiveData.page ?? 0) + 1}/${progressiveData.totalPages ?? '?'})\n`;
                                ragContext += `═══════════════════════════════════════════════════════════\n\n`;
                                ragContext += progressiveData.content;
                                ragContext += `\n═══════════════════════════════════════════════════════════\n`;
                                ragContext += `Total: ${progressiveData.chunks} fragmentos de ${progressiveData.totalChunks} totales.\n`;
                                ragContext += `═══════════════════════════════════════════════════════════\n`;

                                console.log(`[LLMDomainService] Progressive RAG context: page=${(progressiveData.page ?? 0) + 1}/${progressiveData.totalPages}, chunks=${progressiveData.chunks}/${progressiveData.totalChunks}, session=${sessionIndex}`);
                            }
                        }

                        // Fallback to standard context if progressive didn't produce results
                        if (!ragContext) {
                            ragContext = await this.rag.buildContext(prompt, {
                                courseId,
                                topicId: topicId || null,
                                taskId: taskId || null,
                                maxTokens: 4000
                            });
                        }
                    } else {
                        // Non-reinforcement: use standard semantic search context
                        ragContext = await this.rag.buildContext(prompt, {
                            courseId,
                            topicId: topicId || null,
                            taskId: taskId || null,
                            maxTokens: 2000
                        });
                    }
                } catch (ragErr) {
                    console.warn('[LLMDomainService] RAG context failed, proceeding without:', ragErr.message);
                }
            }

            // 2. Build system prompt with context
            let systemPrompt = 'Eres un asistente educativo experto. Responde de manera clara, precisa y útil.';

            // INSTRUCCIÓN SEMÁNTICA: Detección de intención de calificación (Requerimiento estricto: NO usar regex en input usuario)
            // El LLM es responsable de señalizar si es una solicitud de nota válida.
            systemPrompt += `\n\nIMPORTANTE: Tu eres capaz de detectar la intención del usuario. Si el usuario te pide explícitamente CALIFICAR, EVALUAR o dar una NOTA a la entrega/tarea adjunta, debes iniciar tu respuesta con la etiqueta exacta: [GRADING_REQUEST].
Si además determinas una nota numérica (0-10), usa el formato: [GRADING_REQUEST: <monto>] (Ejemplo: "[GRADING_REQUEST: 8.5]").
La escala de calificación es SIEMPRE del 0 al 10. NUNCA uses escala de 100.
Si la solicitud es una pregunta general o no implica calificación formal (ej: "¿Qué nota tiene la escala musical?"), NO incluyas esta etiqueta.`;

            if (taskDescription) {
                systemPrompt += `\n\nContexto de la tarea: ${taskDescription}`;
            }
            if (ragContext) {
                systemPrompt += `\n\nContexto relevante del curso (extraído de rag_documents):\n${ragContext}`;
                systemPrompt += `\nINSTRUCCIÓN DE GROUNDING ESTRICTO:
- Usa EXCLUSIVAMENTE la información contenida en los fragmentos RAG anteriores.
- Cada pregunta y cada respuesta correcta DEBE poder verificarse directamente en el texto de los fragmentos.
- NO inventes, infieras ni añadas información que NO aparezca explícitamente en los fragmentos.
- Si un concepto NO está en los fragmentos, NO generes preguntas sobre él.
- Las explicaciones deben citar o parafrasear directamente el contenido del material.
- Extrae conceptos específicos, definiciones, procesos y datos del material para formular preguntas de APLICACIÓN y ANÁLISIS, no solo de recuerdo directo.
- Usa la información del material para crear ESCENARIOS realistas donde el estudiante deba aplicar los conceptos.
- PROHIBIDO generar preguntas generales basadas en el nombre del curso. Las preguntas DEBEN basarse en el TEMA y TAREA específicos.`;
            }

            // 2.5. JSON format enforcement for reinforcement/quiz requests
            if (this._isReinforcementRequest(prompt)) {
                systemPrompt += `\n\nINSTRUCCIÓN CRÍTICA DE FORMATO JSON:
- Tu respuesta DEBE ser ÚNICAMENTE un array JSON válido. Sin texto antes ni después.
- Cada objeto debe tener los 4 campos en este ORDEN EXACTO: "question", "options", "correctIndex", "explanation".
- NUNCA mezcles campos de diferentes objetos. Completa un objeto completamente ANTES de iniciar el siguiente.
- Estructura cada objeto así: {"question":"...","options":["A","B","C","D"],"correctIndex":N,"explanation":"..."}
- Asegúrate de poner comas entre campos y entre objetos.
- Genera EXACTAMENTE 10 preguntas que se puedan verificar DIRECTAMENTE en el contexto RAG proporcionado.
- Cada explicación DEBE referenciar el texto específico del material que justifica la respuesta correcta.`;

                // 2.6. PEDAGOGICAL QUALITY: Scenario-based, application-level questions
                systemPrompt += `\n\nINSTRUCCIÓN PEDAGÓGICA — CALIDAD DE PREGUNTAS (OBLIGATORIO):

1. CONTEXTUALIZACIÓN Y ESCENARIOS:
   - Cada pregunta DEBE presentar un ESCENARIO o CONTEXTO real antes de formular la interrogante.
   - PROHIBIDO preguntas directas tipo "¿Qué es X?" o "¿Cuál es la definición de Y?".
   - En su lugar, plantea situaciones como: "Un desarrollador está construyendo...", "En una empresa que necesita...", "Durante la revisión de un proyecto se detectó que...".
   - El escenario debe ser verosímil y reflejar un caso de uso real del concepto evaluado.

2. APLICACIÓN DEL CONOCIMIENTO (TAXONOMÍA DE BLOOM — Niveles 3-5):
   - Las preguntas DEBEN evaluar APLICACIÓN, ANÁLISIS o EVALUACIÓN, NO solo RECUERDO o COMPRENSIÓN.
   - Distribución obligatoria de las 10 preguntas:
     • 4 de APLICACIÓN: El estudiante debe usar un concepto para resolver un problema concreto.
     • 3 de ANÁLISIS: El estudiante debe descomponer, comparar o identificar relaciones causa-efecto.
     • 3 de EVALUACIÓN: El estudiante debe juzgar, decidir o seleccionar la mejor solución entre alternativas válidas.
   - Verbos recomendados: implementar, resolver, diagnosticar, comparar, optimizar, predecir, justificar, diseñar.

3. DISTRACTORES PLAUSIBLES (OBLIGATORIO):
   - Las 3 opciones incorrectas DEBEN ser plausibles y reflejar errores comunes de comprensión.
   - Tipos de distractores efectivos:
     a) Confusión entre conceptos similares (ej: confundir stack con heap).
     b) Aplicación parcialmente correcta (ej: solución que funciona pero no es eficiente).
     c) Inversión de causa-efecto o de orden de pasos.
     d) Generalización excesiva o sobresimplificación de un concepto.
   - PROHIBIDO distractores obviamente absurdos, irrelevantes o fácilmente descartables.
   - Un estudiante que NO domina el material debería encontrar los distractores tentadores.
   - La explicación DEBE indicar POR QUÉ cada distractor es incorrecto, no solo por qué la correcta es correcta.`;
            }

            // 3. Build user prompt with file content if available
            let fullPrompt = prompt;
            if (resolvedFileContent) {
                fullPrompt = `Contenido del archivo:\n${resolvedFileContent}\n\nPregunta/Instrucción: ${prompt}`;
            }

            // 4. Check reinforcement history to avoid repetitions — filter by topic/task
            if (userId && courseId && this._isReinforcementRequest(prompt)) {
                try {
                    // Use MCPService for topic/task-scoped history when available
                    const { MCPService } = await
                    import ('./MCPService.js');
                    const mcpService = new MCPService();
                    const history = await mcpService.getReinforcementHistory(
                        userId, courseId, topicId || null, taskId || null
                    );
                    if (history && history.length > 0) {
                        const historyTexts = history.map(h => h.question || h.text || '');
                        systemPrompt += `\n\n═══ PREGUNTAS YA GENERADAS PARA ESTE TEMA/TAREA (PROHIBIDO REPETIR O PARAFRASEAR) ═══`;
                        systemPrompt += `\nHay ${historyTexts.length} preguntas existentes. Cada nueva pregunta DEBE cubrir un ASPECTO DIFERENTE del material:`;
                        historyTexts.forEach((q, i) => { systemPrompt += `\n${i + 1}. ${q}`; });
                        systemPrompt += `\n═══ FIN DEL HISTORIAL ═══`;
                        systemPrompt += `\nIMPORTANTE: NO reformules ni parafrasees ninguna de las preguntas anteriores. Aborda conceptos, funciones o secciones del material que NO aparezcan en el historial.`;
                    }
                } catch (histErr) {
                    console.warn('[LLMDomainService] Reinforcement history failed:', histErr.message);
                    // Fallback to legacy repo method
                    try {
                        const history = await this.reinforcementRepo.getHistory(userId, courseId);
                        if (history && history.length > 0) {
                            systemPrompt += `\n\nPreguntas ya generadas (NO repetir):\n${JSON.stringify(history)}`;
                        }
                    } catch (_) { /* ignore */ }
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

            // 7. Repair malformed quiz JSON before sending to the client
            // Some LLMs produce scrambled JSON (fields interleaved between objects).
            // We detect if this is a reinforcement/quiz response and repair it server-side.
            if (this._isReinforcementRequest(prompt)) {
                content = this._repairQuizJson(content);
            }

            // 8. Reinforcement history save is handled by the client via /reinforcement/save-questions
            // which uses MCPService with full uniqueness flow (hash + embedding + semantic dedup)
            // and correctly passes topicId/taskId. Do NOT save here to avoid duplicates.

            // 9. AUTO-SAVE GRADE: If LLM detected a grading request, persist to task_submissions
            if (esCalificacion && nota !== null && !isNaN(nota)) {
                const gradeValue = Math.max(0, Math.min(10, nota));
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
1. Una nota del 0 al 10
2. Un resumen detallado del análisis
3. Porcentaje de cumplimiento de los requisitos

Descripción de la tarea: ${taskDescription}

Responde SIEMPRE en formato JSON:
{"nota": <0-10>, "resumen": "<análisis detallado>", "cumplimiento": <0-100>}`;

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

    /**
     * Repairs malformed quiz JSON from LLM responses.
     * Uses position-aware field extraction: groups fields by proximity
     * to correctly reconstruct question objects even when fields are interleaved.
     * @private
     * @param {string} text - Raw LLM response text
     * @returns {string} - Repaired text with valid JSON array
     */
    _repairQuizJson(text) {
        if (!text) return text;

        // Extract the JSON array portion
        const startIdx = text.indexOf('[');
        const endIdx = text.lastIndexOf(']');
        if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) return text;

        const prefix = text.substring(0, startIdx);
        const suffix = text.substring(endIdx + 1);
        const jsonPart = text.substring(startIdx, endIdx + 1);

        // Try parsing as-is first
        try {
            const parsed = JSON.parse(jsonPart);
            if (Array.isArray(parsed) && parsed.length > 1) {
                const sanitized = this._sanitizeQuizQuestions(parsed);
                if (sanitized.length > 0) {
                    return prefix + JSON.stringify(sanitized) + suffix;
                }
            }
        } catch (_) { /* needs repair */ }

        try {
            // Position-aware extraction: capture each field match with its position
            const fieldMatches = [];

            const questionRegex = /"question"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
            const optionsRegex = /"options"\s*:\s*\[((?:[^\]]*?))\]/g;
            const correctIndexRegex = /"correctIndex"\s*:\s*(\d+)/g;
            const explanationRegex = /"explanation"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

            let m;
            while ((m = questionRegex.exec(jsonPart)) !== null) {
                fieldMatches.push({ type: 'question', value: m[1], pos: m.index });
            }
            while ((m = optionsRegex.exec(jsonPart)) !== null) {
                fieldMatches.push({ type: 'options', value: m[1], pos: m.index });
            }
            while ((m = correctIndexRegex.exec(jsonPart)) !== null) {
                fieldMatches.push({ type: 'correctIndex', value: parseInt(m[1]), pos: m.index });
            }
            while ((m = explanationRegex.exec(jsonPart)) !== null) {
                fieldMatches.push({ type: 'explanation', value: m[1], pos: m.index });
            }

            // Sort all fields by position in the text
            fieldMatches.sort((a, b) => a.pos - b.pos);

            if (fieldMatches.filter(f => f.type === 'question').length < 2) return text;

            // Group fields into question objects using question boundaries
            const questionObjects = [];
            let current = null;

            for (const field of fieldMatches) {
                if (field.type === 'question') {
                    // Start a new question object (save previous if exists)
                    if (current && current.question) {
                        questionObjects.push(current);
                    }
                    current = { question: field.value, options: null, correctIndex: null, explanation: null };
                } else if (current) {
                    // Assign to current question if not already set
                    if (field.type === 'options' && current.options === null) {
                        current.options = field.value;
                    } else if (field.type === 'correctIndex' && current.correctIndex === null) {
                        current.correctIndex = field.value;
                    } else if (field.type === 'explanation' && current.explanation === null) {
                        current.explanation = field.value;
                    }
                }
            }
            // Push the last question
            if (current && current.question) {
                questionObjects.push(current);
            }

            // Build repaired JSON
            const repaired = questionObjects.map(q => {
                let parsedOpts;
                try {
                    parsedOpts = JSON.parse(`[${q.options || '"A","B","C","D"'}]`);
                } catch (_) {
                    parsedOpts = ['A', 'B', 'C', 'D'];
                }

                const ci = typeof q.correctIndex === 'number'
                    ? Math.min(q.correctIndex, parsedOpts.length - 1)
                    : 0;

                return {
                    question: q.question,
                    options: parsedOpts,
                    correctIndex: ci,
                    explanation: q.explanation || `La respuesta correcta es: "${parsedOpts[ci] || 'la opción correcta'}".`
                };
            });

            const sanitized = this._sanitizeQuizQuestions(repaired);
            if (sanitized.length >= 2) {
                console.log(`🔧 [LLMDomainService] Repaired quiz JSON: ${sanitized.length} questions reconstructed (position-aware grouping)`);
                return prefix + JSON.stringify(sanitized) + suffix;
            }
        } catch (repairErr) {
            console.warn(`⚠️ [LLMDomainService] Quiz JSON repair failed: ${repairErr.message}`);
        }

        return text;
    }

    _sanitizeQuizQuestions(questions) {
        if (!Array.isArray(questions) || questions.length === 0) {
            return [];
        }

        const sanitized = [];
        const seenQuestions = new Set();

        for (const rawQuestion of questions) {
            const questionText = String(rawQuestion?.question || '').trim();
            const normalizedQuestion = this._normalizeQuizText(questionText);
            if (!normalizedQuestion || seenQuestions.has(normalizedQuestion)) {
                continue;
            }

            const rawOptions = Array.isArray(rawQuestion?.options)
                ? rawQuestion.options.map(option => String(option || '').trim()).filter(Boolean)
                : [];

            const uniqueOptions = [];
            const seenOptions = new Set();
            for (const option of rawOptions) {
                const normalizedOption = this._normalizeQuizText(option);
                if (!normalizedOption || seenOptions.has(normalizedOption)) {
                    continue;
                }
                seenOptions.add(normalizedOption);
                uniqueOptions.push(option);
            }

            if (uniqueOptions.length < 4) {
                continue;
            }

            const options = uniqueOptions.slice(0, 4);
            const requestedIndex = Number(rawQuestion?.correctIndex);
            const safeRequestedIndex = Number.isInteger(requestedIndex) ? requestedIndex : 0;
            const originalCorrectOption = rawOptions[safeRequestedIndex] || options[0];
            const normalizedCorrectOption = this._normalizeQuizText(originalCorrectOption);

            let correctIndex = options.findIndex(option => this._normalizeQuizText(option) === normalizedCorrectOption);
            if (correctIndex < 0) {
                correctIndex = 0;
            }

            const explanation = String(rawQuestion?.explanation || '').trim() ||
                `La respuesta correcta es: "${options[correctIndex] || 'la opción correcta'}".`;

            sanitized.push({
                question: questionText,
                options,
                correctIndex,
                explanation
            });

            seenQuestions.add(normalizedQuestion);

            if (sanitized.length >= 10) {
                break;
            }
        }

        return sanitized;
    }

    _normalizeQuizText(text = '') {
        return String(text)
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
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

    /**
     * Builds a composite search query for hybrid RAG retrieval.
     * Extracts topic and task titles from the prompt and combines them
     * to ensure retrieval covers material from BOTH sources.
     *
     * @private
     * @param {string} prompt - The user's prompt (may contain TEMA/TAREA labels)
     * @param {number|null} topicId
     * @param {number|null} taskId
     * @returns {string} - Composite search query
     */
    _buildCompositeSearchQuery(prompt, topicId, taskId) {
        const parts = [];

        // Extract topic name from prompt structure: TEMA: "..."
        const topicMatch = prompt.match(/TEMA(?:\s+PRINCIPAL)?:\s*"([^"]+)"/i);
        if (topicMatch && topicMatch[1] && topicMatch[1] !== 'General') {
            parts.push(topicMatch[1]);
        }

        // Extract task name from prompt structure: TAREA: "..." or TAREA ESPECÍFICA: "..."
        const taskMatch = prompt.match(/TAREA(?:\s+ESPEC[ÍI]FICA)?(?:\s*\([^)]*\))?:\s*"([^"]+)"/i);
        if (taskMatch && taskMatch[1] && taskMatch[1] !== 'General') {
            parts.push(taskMatch[1]);
        }

        // If both extracted, create a blended query for better semantic coverage
        if (parts.length === 2) {
            parts.push(`${parts[0]} ${parts[1]}`);
        }

        // Fallback to using the first 200 chars of the prompt
        if (parts.length === 0) {
            return prompt.substring(0, 200);
        }

        return parts.join(' ').trim();
    }
}
export default LLMDomainService;