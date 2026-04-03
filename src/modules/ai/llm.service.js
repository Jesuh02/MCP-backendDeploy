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
import { TENANT_CONFIGS, runInTenantContext } from '../../config/tenantRegistry.js';

/**
 * In-memory cache: tracks the last time a multi-tenant user was asked
 * to select an institution. Key = userId, value = { tenantId, askedAt }.
 * Cleared when the process restarts (acceptable — 24h window is advisory).
 */
const _tenantAskCache = new Map();

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
     * @param {{ prompt: string, model?: string, courseId?: number, taskDescription?: string, fileContent?: string, fileUri?: string, studentId?: number, userId?: number, tenantId?: string, availableTenants?: string[], institutionName?: string }} params
     * @returns {Promise<Result>}
     */
    async processPrompt({ prompt, model, courseId, taskDescription, fileContent, fileUri, studentId, userId, username, submissionId, taskId, topicId, freeLearning = false, forceMCPTools = false, difficulty = null, userRoles = [], fromWhatsApp = false, tenantId = null, availableTenants = [], institutionName = null }) {
        if (!prompt || prompt.trim().length === 0) {
            return Result.fail(new ValidationError('El prompt es requerido'));
        }

        try {
            // ── MULTI-TENANT INSTITUTION AWARENESS ────────────────────────────────
            // Determine institution context for this request.
            // Rules:
            //   A) Single tenant → use it directly, inform the LLM.
            //   B) Multiple tenants + prompt explicitly names an institution → match it.
            //   C) Multiple tenants + already asked within 24h → use the cached selection.
            //   D) Multiple tenants + not asked yet → ask the user (return early).
            const allTenantConfigs = TENANT_CONFIGS.map(t => ({ id: t.id, name: t.name }));
            // Limit to tenants the user is actually enrolled in (from JWT availableTenants).
            // If availableTenants is empty (old client/WhatsApp), fall back to all configs.
            // availableTenants may be strings ["qa-develop"] or objects [{id:"qa-develop",name:"..."}]
            const normalizedAvailable = (Array.isArray(availableTenants) && availableTenants.length > 0)
                ? availableTenants.map(t => typeof t === 'string' ? t : t?.id).filter(Boolean)
                : [];
            const userTenants = (normalizedAvailable.length > 0)
                ? allTenantConfigs.filter(t => normalizedAvailable.includes(t.id))
                : allTenantConfigs;

            // Resolve the effective institution name for the system prompt
            let effectiveInstitutionName = institutionName || (tenantId
                ? (userTenants.find(t => t.id === tenantId)?.name ?? tenantId)
                : null);
            // The tenant whose DB should actually serve queries (may differ from JWT tenantId
            // when user explicitly names a different institution in the prompt).
            let effectiveTenantId = tenantId;

            if (userTenants.length > 1 && !fromWhatsApp) {
                // Check if the prompt explicitly names one of the institutions
                const promptLower = prompt.toLowerCase();
                const explicitTenant = userTenants.find(t =>
                    promptLower.includes(t.name.toLowerCase()) ||
                    promptLower.includes(t.id.toLowerCase()),
                );

                if (explicitTenant) {
                    // User named a specific institution — use it and cache for 24h
                    effectiveInstitutionName = explicitTenant.name;
                    effectiveTenantId = explicitTenant.id;
                    if (userId) {
                        _tenantAskCache.set(`${tenantId || 'default'}:${userId}`, { tenantId: explicitTenant.id, askedAt: Date.now() });
                    }
                } else {
                    // Check 24-hour cache
                    const cached = userId ? _tenantAskCache.get(`${tenantId || 'default'}:${userId}`) : null;
                    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
                    if (cached && (Date.now() - cached.askedAt) < TWENTY_FOUR_HOURS) {
                        // Use the previously selected tenant
                        effectiveInstitutionName = userTenants.find(t => t.id === cached.tenantId)?.name ?? cached.tenantId;
                        effectiveTenantId = cached.tenantId;
                    } else {
                        // Must ask the user which institution to query
                        if (userId) {
                            _tenantAskCache.set(`${tenantId || 'default'}:${userId}`, { tenantId: tenantId || userTenants[0].id, askedAt: Date.now() });
                        }
                        const menuLines = userTenants.map((t, i) => `${i + 1}. *${t.name}*`).join('\n');
                        const askMsg = `🏫 Tienes acceso a múltiples instituciones. ¿De cuál deseas consultar la información?\n\n${menuLines}\n\nResponde con el número o el nombre de la institución y luego repite tu pregunta.`;
                        return Result.ok({
                            response: askMsg,
                            model: null,
                            usage: null,
                            esCalificacion: false,
                            nota: null,
                            requiresTenantSelection: true,
                        });
                    }
                }
            }
            // ── END MULTI-TENANT AWARENESS ─────────────────────────────────────────

            // ── CROSS-TENANT CONTEXT SWITCH ────────────────────────────────────────
            // When the resolved institution differs from the JWT tenant, re-run the
            // entire prompt inside that tenant's AsyncLocalStorage context so all
            // repository / MCP calls transparently query the correct Supabase DB.
            if (effectiveTenantId && effectiveTenantId !== tenantId) {
                return runInTenantContext(effectiveTenantId, () =>
                    this.processPrompt({
                        prompt, model, courseId, taskDescription, fileContent, fileUri,
                        studentId, userId, username, submissionId, taskId, topicId,
                        freeLearning, forceMCPTools, difficulty, userRoles, fromWhatsApp,
                        tenantId: effectiveTenantId,   // now matches context → no re-dispatch
                        availableTenants,
                        institutionName: effectiveInstitutionName,
                    }),
                );
            }

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
                        const isEasyDifficulty = String(difficulty || '').toUpperCase() === 'EASY';
                        let existingCount = 0;
                        if (!isEasyDifficulty) {
                            try {
                                const { MCPService } = await
                                import ('./mcp-legacy.service.js');
                                const mcpService = new MCPService();
                                const history = await mcpService.getReinforcementHistory(
                                    userId, courseId, topicId || null, taskId || null
                                );
                                existingCount = (history && history.length) || 0;
                            } catch (_) { /* ignore — will use page 0 */ }
                        }

                        const sessionIndex = Math.floor(existingCount / 10);

                        // ═══ HYBRID RETRIEVAL v2: Semantic + Window ONLY ═══
                        // Progressive is used as fallback ONLY when semantic returns 0 results.
                        // This prevents polluting relevant context with unrelated document chunks.
                        const compositeQuery = this._buildCompositeSearchQuery(prompt, topicId, taskId);

                        if (typeof this.rag.getHybridRagContent === 'function') {
                            const filter = { courseId };
                            if (!freeLearning) {
                                if (topicId) filter.topicId = topicId;
                                if (taskId) filter.taskId = taskId;
                            }

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
                            if (!freeLearning) {
                                if (topicId) filter.topicId = topicId;
                                if (taskId) filter.taskId = taskId;
                            }

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
                                topicId: freeLearning ? null : (topicId || null),
                                taskId: freeLearning ? null : (taskId || null),
                                maxTokens: 4000
                            });
                        }
                    } else {
                        ragContext = await this.rag.buildContext(prompt, {
                            courseId,
                            topicId: freeLearning ? null : (topicId || null),
                            taskId: freeLearning ? null : (taskId || null),
                            maxTokens: 2000
                        });
                    }
                } catch (ragErr) {
                    console.warn('[LLMDomainService] RAG context failed, proceeding without:', ragErr.message);
                }
            }

            // 2. Build system prompt with context
            let systemPrompt = 'Eres un asistente educativo experto y también un asistente de conocimiento general. Responde de manera clara, precisa y útil. Puedes responder tanto preguntas sobre la plataforma educativa y sus datos como preguntas de conocimiento general (historia, ciencia, cultura, etc.).';

            // ── Inject user identity so the LLM always knows who it is talking to ──
            if (username) {
                systemPrompt += `\n\nUSUARIO ACTUAL: ${username}. Dirígete al usuario por su nombre cuando sea apropiado.`;
            }

            systemPrompt += `\n\nREGLA DE PREGUNTAS GENERALES:\n- Si el usuario hace una pregunta de conocimiento general (historia, ciencia, matemáticas, cultura, idiomas, etc.) que NO requiere datos de la base de datos, responde directamente con tu conocimiento. NO uses herramientas de base de datos para este tipo de preguntas.\n- Solo usa las herramientas de base de datos cuando el usuario pregunte sobre datos de la plataforma (estudiantes, cursos, progreso, entregas, etc.).\n- Ejemplo de pregunta general: "¿Cuáles fueron los aportes de Marie Curie en física?" → Responde directamente.\n- Ejemplo de pregunta de datos: "¿Cuántos estudiantes tengo?" → Usa la herramienta query_database.`;

            // ── Inject user identity so the LLM always knows who it is talking to ──
            if (username) {
                systemPrompt += `\n\nUSUARIO ACTUAL: ${username}. Dirígete al usuario por su nombre cuando sea apropiado.`;
            }

            // ── Inject institution context so the LLM always knows which tenant it serves ──
            if (effectiveInstitutionName) {
                systemPrompt += `\n\nINSTITUCIÓN ACTIVA: ${effectiveInstitutionName}. ` +
                    `Todas las consultas, datos y respuestas corresponden a esta institución. ` +
                    `Si el usuario pregunta sobre otra institución, indícale que para eso debe seleccionarla desde el selector de institución en la interfaz.`;
            }

            systemPrompt += `\n\nREGLA DE PRESENTACIÓN — NUNCA MOSTRAR IDs NUMÉRICOS:\n- NUNCA muestres IDs numéricos de base de datos (user_id, course_id, id, student_id, creator_user_id, topic_id, task_id, etc.) al usuario.\n- NUNCA incluyas columnas de IDs en el SELECT de tus consultas SQL.\n- Para personas: muestra siempre el username o nombre (first_name, last_name). Haz JOIN con la tabla usuarios.\n- Para cursos: muestra siempre el título (title). Haz JOIN con courses.\n- Para temas: muestra siempre el nombre (name). Para tareas: muestra siempre el título (title).\n- Si una columna es una FK (ej: creator_user_id, student_id, subscriber_id), haz JOIN con la tabla correspondiente y selecciona el campo legible (username, title, name).\n- Ejemplo PROHIBIDO: "Usuario 42 tiene 3 cursos" o "id: 5" o SELECT user_id, course_id FROM ...\n- Ejemplo CORRECTO: "El usuario juanperez tiene 3 cursos" o SELECT u.username, c.title FROM ... JOIN usuarios u ON ...\n- Esta regla aplica a TODAS las respuestas y consultas SQL sin excepción.`;

            systemPrompt += `\n\nREGLA DE PRESENTACIÓN — NUNCA MOSTRAR SQL AL USUARIO:\n- PROHIBIDO mostrar código SQL, consultas SQL o bloques de código SQL en tu respuesta.\n- El usuario NO debe ver SELECT, FROM, WHERE, JOIN, ni ninguna sentencia SQL.\n- Cuando necesites datos de la base de datos, usa la herramienta internamente, pero tu respuesta final debe ser en lenguaje natural claro (Markdown).\n- Si la herramienta devuelve datos, presenta un resumen legible. NUNCA copies el SQL que usaste.`;

            systemPrompt += `\n\nREGLA DE EXCEL — GENERACIÓN AUTOMÁTICA:
- Cuando el usuario solicite un archivo Excel, un reporte en Excel o una hoja de cálculo, el SISTEMA se encarga de generarlo automáticamente. TÚ NO generas el archivo.
- NUNCA digas "No puedo generar archivos Excel" ni "no tengo la capacidad de crear Excel". El sistema SÍ genera el Excel y el usuario recibirá un botón de descarga automáticamente.
- Tu trabajo cuando el usuario pide un Excel: presenta los datos en una TABLA MARKDOWN bien formateada y añade un resumen breve. El archivo Excel se adjuntará automáticamente por el sistema.
- Ejemplo de respuesta CORRECTA cuando piden Excel: "Aquí tienes el progreso de tus estudiantes: [tabla markdown] El archivo Excel está listo para descargar."
- Ejemplo de respuesta PROHIBIDA: "No puedo generar archivos Excel, pero aquí tienes los datos..."`;

            systemPrompt += `\n\nREGLA DE FORMATO DE TABLAS — MARKDOWN:
- Cuando presentes datos tabulares, usa SIEMPRE tablas Markdown correctamente formateadas.
- Formato obligatorio:
  | Columna 1 | Columna 2 | Columna 3 |
  |-----------|-----------|-----------|
  | dato 1    | dato 2    | dato 3    |
- Asegúrate de que la línea de separadores (|---|---|---|) esté SIEMPRE presente después de los encabezados.
- Alinea las columnas para que sea legible.
- NO uses formato de lista o texto plano para datos que tienen estructura tabular.`;

            // INSTRUCCIÓN SEMÁNTICA: Detección de intención de calificación (Requerimiento estricto: NO usar regex en input usuario)
            // El LLM es responsable de señalizar si es una solicitud de nota válida.
            systemPrompt += `\n\nREGLA CRÍTICA — ETIQUETA [GRADING_REQUEST]:
Usa esta etiqueta ÚNICAMENTE cuando el usuario te pida de forma DIRECTA e IMPERATIVA que asignes una nota numérica a la entrega/tarea que está adjunta en este contexto.
Ejemplos que SÍ activan la etiqueta: "califica esta tarea", "ponle nota", "dame una calificación numérica", "¿qué nota le pondrías a esta entrega?", "evalúa y asigna puntaje".
Ejemplos que NUNCA activan la etiqueta (preguntas informativas, hipotéticas o sobre metodología):
  - "¿Qué criterios usas para calificar?" → NO (pregunta sobre metodología)
  - "¿Qué diferencia hay entre una buena y una mala tarea?" → NO (pregunta conceptual)
  - "¿Cómo se calcula la nota?" → NO (pregunta informativa)
  - "¿Qué nota tiene la escala musical?" → NO (uso de la palabra "nota" sin contexto de evaluación)
  - "¿Qué se necesita para sacar 10?" → NO (pregunta hipotética o criterial)
Regla semántica: la intención debe ser una ACCIÓN DIRECTA de asignación de nota a ESTA entrega concreta, no una consulta, comparación, criterio o pregunta hipotética.
Si usas [GRADING_REQUEST] con nota, el formato es: [GRADING_REQUEST: <número>] (escala 0-10 siempre, NUNCA 0-100).`;

            if (taskDescription) {
                systemPrompt += `\n\nContexto de la tarea: ${taskDescription}`;
            }
            if (ragContext) {
                systemPrompt += `\n\nContexto relevante del curso (extraído de rag_documents):\n${ragContext}`;
                systemPrompt += `\nINSTRUCCIÓN DE GROUNDING ESTRICTO:
- Usa EXCLUSIVAMENTE la información contenida en los fragmentos RAG anteriores.
- Cada pregunta y cada respuesta correcta DEBE poder verificarse en el texto de los fragmentos.
- NO inventes ni añadas información que NO aparezca en los fragmentos.
- Si un concepto NO está en los fragmentos, NO generes preguntas sobre él.
- Las explicaciones deben citar o parafrasear directamente el contenido del material.
- Extrae mecanismos, relaciones causa-efecto, comparaciones e implicaciones del material para formular preguntas que evalúen CONSECUENCIAS y COMPRENSIÓN PROFUNDA, nunca solo recuerdo de datos.
- Usa la información del material para crear ESCENARIOS donde el estudiante deba PENSAR y DECIDIR, no solo localizar una respuesta.
- PROHIBIDO preguntas que se respondan buscando un dato literal. Las preguntas deben requerir ENTENDER el mecanismo detrás del dato.
- PROHIBIDO generar preguntas generales basadas en el nombre del curso. Las preguntas DEBEN basarse en el TEMA y TAREA específicos.
- PROHIBIDO ABSOLUTO preguntas de memorización de eventos: NO preguntar "¿Qué ocurrió?", "¿Quién hizo X?", "¿Cuándo sucedió?", "¿Dónde se realizó?", "¿Qué evento causó X?". El estudiante NUNCA debe responder recordando un hecho, fecha, nombre o evento del documento.
- TODAS las preguntas deben premiar la COMPRENSIÓN y el PENSAMIENTO CRÍTICO: el estudiante debe demostrar que ENTIENDE relaciones, mecanismos, consecuencias e implicaciones — no que memorizó hechos.
- Usa la Taxonomía de Bloom niveles superiores: APLICAR, ANALIZAR, EVALUAR, CREAR. PROHIBIDO niveles inferiores: RECORDAR, IDENTIFICAR.`;
            }

            if (freeLearning) {
                systemPrompt += `\n\nMODO APRENDIZAJE LIBRE ACTIVADO:
- Las preguntas DEBEN cubrir TODOS los temas presentes en el material, no solo uno.
- Si el documento contiene múltiples temas (ej: SQL y Python), genera preguntas que cubran AMBOS.
- NO te limites al título del tema o tarea. Explora TODO el contenido disponible.
- Distribuye las preguntas equitativamente entre los distintos temas del material.`;
            }

            // 2.5. JSON format enforcement for reinforcement/quiz requests
            if (this._isReinforcementRequest(prompt)) {
                systemPrompt += `\n\nINSTRUCCIÓN CRÍTICA DE FORMATO JSON:
- Tu respuesta DEBE ser ÚNICAMENTE un array JSON válido. Sin texto antes ni después.
- Cada objeto DEBE tener un campo "type" que sea "multiple_choice", "fill_in_blank" o "ordering".
- Para "multiple_choice": campos "question", "type", "options" (array de 4), "correctIndex" (0-3), "explanation".
- Para "fill_in_blank": campos "question", "type", "correctAnswer" (string), "hint" (string opcional), "explanation".
- Para "ordering": campos "question", "type", "items" (array desordenado), "correctOrder" (array de índices), "explanation".
- NUNCA mezcles campos de diferentes objetos. Completa un objeto completamente ANTES de iniciar el siguiente.
- Asegúrate de poner comas entre campos y entre objetos.
- Genera EXACTAMENTE 10 ejercicios que se puedan verificar DIRECTAMENTE en el contexto RAG proporcionado.
- OBLIGATORIO: incluye AL MENOS 3 ejercicios "fill_in_blank" y AL MENOS 1 "ordering". NUNCA generes solo "multiple_choice".
- Cada explicación DEBE referenciar el texto específico del material que justifica la respuesta correcta.
- REGLA ANTI-SESGO DE LONGITUD EN OPCIONES (multiple_choice):
  * TODAS las opciones DEBEN tener longitud MUY SIMILAR (máximo 15% diferencia en caracteres).
  * La respuesta correcta NUNCA debe ser la más larga ni la más elaborada.
  * TÉCNICA: Escribe PRIMERO la correcta, luego escribe CADA distractor con la MISMA estructura gramatical, MISMO nivel de detalle y longitud SIMILAR.
  * Si la correcta tiene una explicación causal ("porque...", "ya que..."), TODAS deben tenerla.
  * Si la correcta es corta (número, palabra), TODAS deben ser igual de cortas.
  * VERIFICA: Cuenta los caracteres de cada opción antes de finalizar. Si alguna difiere >15% del promedio, REESCRIBE.`;

                // 2.6. PEDAGOGICAL QUALITY: 10/10 questions — thinking, not searching
                systemPrompt += `\n\nINSTRUCCIÓN PEDAGÓGICA — NIVEL 10/10 (OBLIGATORIO ESTRICTO):

═══ PRINCIPIO #1: EL ESTUDIANTE DEBE PENSAR, NO BUSCAR NI RECORDAR EVENTOS ═══
- PROHIBIDO preguntas donde el estudiante solo localiza un dato en el material (ej: "¿Qué modelo tiene menor tiempo?").
- PROHIBIDO preguntas de memorización de EVENTOS del documento: "¿Qué ocurrió?", "¿Quién hizo X?", "¿Cuándo sucedió?", "¿Dónde se realizó?", "¿Qué evento causó X?"
- El estudiante NUNCA debe poder responder simplemente recordando un hecho, evento, fecha o nombre del documento.
- Eso es nivel medio. El nivel 10/10 exige ANALIZAR, INTERPRETAR y DECIDIR.
- Cada pregunta debe requerir que el estudiante ENTIENDA un mecanismo, compare alternativas o prediga consecuencias.
- Ejemplo PROHIBIDO: "¿Cuál es el valor de X?" → solo buscar.
- Ejemplo CORRECTO: "Te encuentras en el caso de elegir un modelo que mantenga arquitectura MoE y reduzca el tiempo respecto a SMoE. ¿Cuál cumple esa condición?" → debes entender qué es SMoE, comparar y elegir.
- OBLIGATORIO en escenarios hipotéticos: redacta en SEGUNDA PERSONA ("tú", "te", "tu").
- PROHIBIDO iniciar escenarios con tercera persona genérica como "un investigador", "un estudiante", "un ingeniero".

═══ PRINCIPIO #2: OPCIONES QUE REQUIEREN COMPRENSIÓN REAL, NO COINCIDENCIA VISUAL ═══
- PROHIBIDO opciones que sean datos literales copiados del material (ej: "Dense – 41h30m", "SMoE – 42h11m").
  El estudiante solo buscaría coincidencia visual. Eso es nivel medio.
- Las opciones deben ser CONCEPTOS, ESTRATEGIAS o INTERPRETACIONES que obliguen a pensar.
- Ejemplo CORRECTO: "¿Qué modelo demuestra mayor eficiencia dentro de su categoría?"
  Opciones: nombres de modelos sin sus métricas → el estudiante debe saber qué significa "eficiencia" y comparar mentalmente.
- Las opciones correctas e incorrectas deben estar al MISMO NIVEL de plausibilidad visual.

═══ PRINCIPIO #3: EVALUAR CONSECUENCIAS E IMPLICACIONES, NO SOLO DATOS ═══
- Este es EL CRITERIO MÁS IMPORTANTE.
- PROHIBIDO: "¿Cuál es el tiempo de X?" (solo dato).
- OBLIGATORIO: "¿Qué IMPLICA ese tiempo?" / "¿Qué EFECTO tiene?" / "¿Qué CONSECUENCIA produce?"
- Ejemplo: "Si un modelo elimina cálculo de routing por token, ¿qué efecto directo tiene en el entrenamiento?"
  Opciones: "reduce tiempo ✓", "aumenta parámetros", "reduce GPU", "aumenta dataset"
  → El estudiante debe ENTENDER EL MECANISMO, no solo el número.
- Usa verbos como: implica, causa, produce, permite, impide, optimiza, degrada.

═══ PRINCIPIO #4: TRAMPAS CONCEPTUALES SUTILES ═══
- No se trata de confundir al estudiante, sino de evaluar comprensión REAL.
- Los 4 distractores deben ser TODOS plausibles a primera vista.
- Solo quien ENTIENDE el concepto puede distinguir la correcta.
- Tipos de trampas efectivas:
  a) Opción que suena técnicamente correcta pero invierte causa-efecto.
  b) Opción que aplica el concepto correcto al contexto equivocado.
  c) Opción que es verdadera en general pero NO responde la pregunta específica.
  d) Opción que confunde dos conceptos del mismo dominio (ej: optimización kernel vs optimización de arquitectura).
- PROHIBIDO opciones descartables por absurdas o fuera de tema.

═══ RESUMEN DE NIVEL 10/10 vs NIVEL MEDIO ═══
| Nivel Medio (PROHIBIDO)           | Nivel 10/10 (OBLIGATORIO)                    |
|-----------------------------------|----------------------------------------------|
| Buscar dato en el material        | Analizar y comparar datos                    |
| Coincidencia visual en opciones   | Interpretación conceptual en opciones        |
| Preguntar "¿Cuál es el valor?"    | Preguntar "¿Qué implica ese valor?"          |
| Distractores obvios               | Trampas conceptuales donde TODO parece válido|
| Responder sin entender            | Imposible responder sin comprender           |`;
            }

            // 2.7. HARD difficulty complexity enforcement for reinforcement
            if (String(difficulty || '').toUpperCase() === 'HARD' && this._isReinforcementRequest(prompt)) {
                systemPrompt += `\n\n═══ ENFORCEMENT DE COMPLEJIDAD HARD ═══
ERES un evaluador de nivel universitario avanzado / profesional.
Reglas OBLIGATORIAS para TODOS los ejercicios:

1. MATEMÁTICAS/ARITMÉTICA: Los números deben tener MÍNIMO 7 dígitos. Ejemplo válido: 1,023,232 + 12,213,456. Ejemplo PROHIBIDO: 24+18, 5×3.
2. SQL: OBLIGATORIO incluir JOINs, subqueries, window functions (OVER/PARTITION BY), CTEs o HAVING. SELECT simple sin JOIN está PROHIBIDO.
3. PROGRAMACIÓN: Exigir algoritmos (búsqueda binaria, grafos, recursión, DP), NO ejercicios de sintaxis básica como console.log o print.
4. CONCEPTOS: NO preguntar "¿Qué es X?" → preguntar "¿Qué implicaciones tiene X cuando se combina con Y en el contexto Z?"
5. TODOS los ejercicios deben requerir razonamiento multi-paso. Si se puede responder de memoria o en 1 paso, es DEMASIADO FÁCIL.

Si generas un ejercicio trivial, el sistema lo RECHAZARÁ. Maximiza la complejidad.`;
            }

            // 3. Build user prompt with file content if available
            let fullPrompt = prompt;
            if (resolvedFileContent) {
                fullPrompt = `Contenido del archivo:\n${resolvedFileContent}\n\nPregunta/Instrucción: ${prompt}`;
            }

            // 4. Check reinforcement history to avoid repetitions (skip for EASY — allow repeats for fast loading)
            const isEasyMode = String(difficulty || '').toUpperCase() === 'EASY';
            if (!isEasyMode && userId && courseId && this._isReinforcementRequest(prompt)) {
                try {
                    // Use MCPService WITHOUT topic/task filter to match the duplicate detection scope
                    const { MCPService } = await
                    import ('./mcp-legacy.service.js');
                    const mcpService = new MCPService();
                    // Pass null for topicId and taskId to get ALL questions for this user+course
                    const history = await mcpService.getReinforcementHistory(
                        userId, courseId, null, null
                    );
                    console.log(`[LLMDomainService] � Reinforcement history retrieved: ${history?.length || 0} questions for user=${userId} course=${courseId}`);
                    if (history && history.length > 0) {
                        const historyTexts = history.map(h => h.question || h.text || '').filter(Boolean);
                        systemPrompt += `\n\n═══ PREGUNTAS YA GENERADAS EN ESTE CURSO (PROHIBIDO REPETIR O PARAFRASEAR) ═══`;
                        systemPrompt += `\nHay ${historyTexts.length} preguntas existentes. Cada nueva pregunta DEBE cubrir un ASPECTO COMPLETAMENTE DIFERENTE:`;
                        historyTexts.forEach((q, i) => { systemPrompt += `\n${i + 1}. ${q}`; });
                        systemPrompt += `\n═══ FIN DEL HISTORIAL ═══`;
                        systemPrompt += `\nIMPORTANTE: NO reformules ni parafrasees ninguna de las preguntas anteriores. Genera preguntas sobre conceptos, funciones o secciones que NO aparezcan arriba.`;
                        systemPrompt += `\nSi el material ya fue cubierto por las preguntas existentes, busca DETALLES ESPECÍFICOS, EJEMPLOS CONCRETOS o APLICACIONES PRÁCTICAS que aún no se hayan preguntado.`;
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
            // If the prompt asks for database queries or BI instructions, expose MCP tools
            const promptLc = String(fullPrompt || '').toLowerCase();
            // Allow caller to force enabling MCP tools (useful for channel integrations)
            // Roles: 1=estudiante, 2=docente, 3=admin
            const isAdmin = Array.isArray(userRoles) && userRoles.map(Number).includes(3);
            const isTeacher = Array.isArray(userRoles) && userRoles.map(Number).includes(2);
            // Gate MCP tool access to teachers and admins only.
            // When fromWhatsApp=true, all authenticated users can query their OWN data (scoped by userId).
            // Students (role 1) get limited MCP access only when authenticated via WhatsApp.
            const roleAllowsMCPTools = isAdmin || isTeacher || (fromWhatsApp && !!userId);
            // ── Detect if the prompt needs MCP database tools ──
            // Broad detection: table names (Spanish & English), counting, records,
            // general data queries, student progress patterns, and explicit tool requests.
            const DB_TABLE_NAMES = /\b(usuarios|courses|cursos|videos|subjects|materias|topics|temas|tasks|tareas|task_submissions|entregas|submissions|subscriptions|suscripciones|transactions|transacciones|notifications|notificaciones|progreso_curso|progreso_materia|progreso|collaborators|colaboradores|personas|reinforcement_results|refuerzo|pr[aá]ctica)\b/i;
            const DB_QUERY_PATTERNS = /query[_ ]database|consulta de business inteli?gencia|usa ['"]?query_database['"]?|progreso.*estudiante|estudiante.*progreso|mis estudiantes|avance.*curso|rendimiento.*estudiante|entregas.*estudiante|estudiante.*entrega|calificaci[oó]n.*estudiante|estudiante.*calificaci[oó]n|cu[aá]nto|cu[aá]ntas|cu[aá]ntos|registros|total de|contar|conteo|cantidad|estad[ií]stica|reporte|datos de|d[ií]me|mu[eé]stra|lista|consulta|base de datos|tabla|schema|esquema|dashboard|m[eé]trica|ingresos|pagos|ventas|suscri|crear reporte|generar reporte|exportar|nota.*estudiante|estudiante.*nota|practican|pr[aá]ctica.*refuerzo/i;
            // Detect if the prompt matches DB patterns explicitly
            const promptMatchesDB = DB_TABLE_NAMES.test(promptLc) || DB_QUERY_PATTERNS.test(promptLc);
            // When forceMCPTools is on but the prompt doesn't match DB patterns,
            // enable tools in 'auto' mode so the LLM can answer general knowledge questions
            // directly without being forced to call a DB tool.
            let needsMCPTools = roleAllowsMCPTools && (forceMCPTools || promptMatchesDB);
            // Track whether tools were forced without an explicit DB pattern — use 'auto' toolChoice
            const toolsAvailableButOptional = needsMCPTools && forceMCPTools && !promptMatchesDB;
            if (needsMCPTools) {
                console.log(`[LLMDomainService] 🔐 MCP tools enabled — userId=${userId}, roles=${JSON.stringify(userRoles)}, isTeacher=${isTeacher}, isAdmin=${isAdmin}`);
            } else if (!roleAllowsMCPTools && (DB_TABLE_NAMES.test(promptLc) || DB_QUERY_PATTERNS.test(promptLc))) {
                // Prompt looks like a DB query but roles block access — log to help diagnose empty-roles issues
                console.warn(`[LLMDomainService] ⚠️ DB query detected but MCP tools BLOCKED — userId=${userId}, roles=${JSON.stringify(userRoles)} (empty roles = no DB access). Check that JWT contains roles or client sends userRoles in body.`);
            }
            // When tools are required we also augment the system prompt with explicit
            // instructions to use them.  This is important because some LLM models
            // (including deepseek-chat) may otherwise ignore the tool definitions.
            if (needsMCPTools) {
                systemPrompt += `\n\nINSTRUCCIONES DE HERRAMIENTA (OBLIGATORIAS):\n` +
                    `REGLA #1 — SIEMPRE CONSULTA ANTES DE AFIRMAR:\n` +
                    `- PROHIBIDO decir que una tabla, columna o dato "no existe" sin antes verificar con \`get_database_schema\` o \`query_database\`.\n` +
                    `- Si el usuario menciona un nombre de tabla en español (ej: "transacciones", "suscripciones", "tareas"), busca la tabla equivalente en inglés (transactions, subscriptions, tasks) o viceversa.\n` +
                    `- Si no estás seguro del nombre exacto de una tabla o columna, usa PRIMERO \`get_database_schema\` para ver todas las tablas disponibles.\n` +
                    `- Solo después de consultar la base de datos y confirmar que no hay resultados puedes informar al usuario.\n\n` +
                    `REGLA #2 — FLUJO OBLIGATORIO:\n` +
                    `1. Si tienes duda sobre el esquema → llama \`get_database_schema\`\n` +
                    `2. Construye tu SQL con los nombres reales de las tablas/columnas\n` +
                    `3. Ejecuta con \`query_database\`\n` +
                    `4. Formula tu respuesta en Markdown con los datos reales\n\n` +
                    `REGLA #3 — CÓMO USAR LAS HERRAMIENTAS:\n` +
                    `Emite exactamente un bloque JSON como el siguiente:\n\n` +
                    "```json\n" +
                    "{\"tool\": \"query_database\", \"arguments\": {\"query\": \"<tu SQL aquí>\"}}\n" +
                    "```\n" +
                    `O para ver el esquema:\n` +
                    "```json\n" +
                    "{\"tool\": \"get_database_schema\", \"arguments\": {}}\n" +
                    "```\n\n" +
                    `REGLA #4 — MAPEO DE NOMBRES ESPAÑOL↔INGLÉS:\n` +
                    `- transacciones = transactions\n` +
                    `- suscripciones = subscriptions\n` +
                    `- tareas = tasks\n` +
                    `- entregas = task_submissions\n` +
                    `- temas = topics\n` +
                    `- materias = subjects\n` +
                    `- cursos = courses\n` +
                    `- notificaciones = notifications\n` +
                    `- usuarios = usuarios (ya está en español)\n` +
                    `- Si el usuario dice un nombre que no coincide exactamente, busca la tabla más similar en el schema.\n\n` +
                    `No inventes valores. No respondas sin consultar la base de datos primero.`;

                // ── Role-based data-access restriction ──────────────────────────────
                // Roles: 1=estudiante, 2=docente, 3=admin
                // Sanitize JWT username for safe SQL embedding (prevent injection)
                const safeUsername = (username || '').replace(/'/g, "''");
                // Build user-id resolution: prefer userId, but also resolve from authenticated username
                // This handles cases where JWT userId doesn't match courses.creator_user_id
                const userIdResolution = safeUsername
                    ? `(SELECT id FROM usuarios WHERE id = ${userId} UNION SELECT id FROM usuarios WHERE username = '${safeUsername}')`
                    : `${userId}`;
                if (isAdmin && userId) {
                    if (fromWhatsApp) {
                        // WhatsApp channel: even admins are restricted to their own data
                        systemPrompt += `\n\nACCESO VÍA WHATSAPP — SOLO TUS PROPIOS DATOS (ADMIN):\n` +
                            `En este canal ÚNICAMENTE puedes consultar TUS datos (cursos que creaste, tus estudiantes, tu actividad).\n` +
                            `⚠️ PROHIBIDO: consultar datos de otros usuarios. PROHIBIDO: usar auth.uid().\n\n` +
                            `IDENTIDAD AUTENTICADA: userId=${userId}${safeUsername ? `, username='${safeUsername}'` : ''}.\n` +
                            `Filtra SIEMPRE usando:\n` +
                            `  WHERE creator_user_id IN ${userIdResolution}\n` +
                            `  O: WHERE user_id IN ${userIdResolution}\n\n` +
                            `⚠️ TABLA subscriptions: SOLO tiene subscriber_id y creator_id. NO tiene course_id.\n` +
                            `NUNCA uses subscriptions para contar estudiantes por curso.\n` +
                            `Para estudiantes por curso, usa SIEMPRE progreso_curso.\n\n` +
                            `CONSULTA DE REFERENCIA — CONTAR ESTUDIANTES POR CURSO:\n` +
                            `  SELECT c.title AS curso, COUNT(DISTINCT pc.usuario_estudiante) AS estudiantes\n` +
                            `  FROM courses c\n` +
                            `  LEFT JOIN progreso_curso pc ON pc.curso_id = c.id\n` +
                            `  WHERE c.creator_user_id IN ${userIdResolution}\n` +
                            `  GROUP BY c.title ORDER BY c.title;\n\n` +
                            `CONSULTA DE REFERENCIA — TUS ESTUDIANTES:\n` +
                            `  SELECT u.username AS estudiante, c.title AS curso,\n` +
                            `         pc.tareas_completadas, pc.tareas_totales, pc.porcentaje_progreso,\n` +
                            `         pc.calificacion_ponderada AS promedio, pc.estado\n` +
                            `  FROM progreso_curso pc\n` +
                            `  JOIN usuarios u ON pc.usuario_estudiante = u.id\n` +
                            `  JOIN courses c ON pc.curso_id = c.id\n` +
                            `  WHERE c.creator_user_id IN ${userIdResolution}\n` +
                            `  ORDER BY c.title, u.username;`;
                    } else {
                        systemPrompt += `\n\nNIVEL DE ACCESO: ADMINISTRADOR — Puedes consultar todos los datos de la plataforma (estudiantes, docentes, cursos, progreso, entregas).\n` +
                            `⚠️ PROHIBIDO: Nunca uses auth.uid() — esa función no existe en este contexto y causará errores de tipo.\n\n` +
                            `IDENTIDAD DEL USUARIO AUTENTICADO: userId=${userId}${safeUsername ? `, username='${safeUsername}'` : ''}.\n` +
                            `Cuando el usuario pregunte por "mis cursos", "mis estudiantes" o datos propios, filtra usando:\n` +
                            `  WHERE c.creator_user_id IN ${userIdResolution}\n` +
                            `  O con JOIN: JOIN usuarios creador ON c.creator_user_id = creador.id WHERE creador.username = '${safeUsername || 'N/A'}'\n\n` +
                            `⚠️ TABLA subscriptions: SOLO tiene subscriber_id y creator_id. NO tiene course_id.\n` +
                            `NUNCA uses subscriptions para contar estudiantes por curso — da resultados incorrectos (cross-join).\n` +
                            `Para contar estudiantes por curso, usa SIEMPRE progreso_curso.\n\n` +
                            `CONSULTA DE REFERENCIA — CONTAR ESTUDIANTES POR CURSO:\n` +
                            `  SELECT c.title AS curso, COUNT(DISTINCT pc.usuario_estudiante) AS estudiantes\n` +
                            `  FROM courses c\n` +
                            `  LEFT JOIN progreso_curso pc ON pc.curso_id = c.id\n` +
                            `  WHERE c.creator_user_id IN ${userIdResolution}\n` +
                            `  GROUP BY c.title ORDER BY c.title;\n\n` +
                            `CONSULTA DE REFERENCIA — TOTAL DE ESTUDIANTES ÚNICOS:\n` +
                            `  SELECT COUNT(DISTINCT pc.usuario_estudiante) AS total_estudiantes\n` +
                            `  FROM progreso_curso pc\n` +
                            `  WHERE pc.curso_id IN (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution});\n\n` +
                            `CONSULTA DE REFERENCIA — PROGRESO DE ESTUDIANTES:\n` +
                            `  SELECT u.username AS estudiante, c.title AS curso,\n` +
                            `         pc.tareas_completadas, pc.tareas_totales, pc.porcentaje_progreso,\n` +
                            `         pc.calificacion_ponderada AS promedio, pc.estado\n` +
                            `  FROM progreso_curso pc\n` +
                            `  JOIN usuarios u ON pc.usuario_estudiante = u.id\n` +
                            `  JOIN courses c ON pc.curso_id = c.id\n` +
                            `  WHERE pc.curso_id IN (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution})\n` +
                            `  ORDER BY c.title, u.username;`;
                    }
                } else if (isAdmin) {
                    systemPrompt += `\n\nNIVEL DE ACCESO: ADMINISTRADOR — Puedes consultar todos los datos de la plataforma (estudiantes, docentes, cursos, progreso, entregas).\n⚠️ PROHIBIDO: Nunca uses auth.uid() — esa función no existe en este contexto y causará errores de tipo. Usa siempre IDs numéricos concretos o JOINs con la tabla usuarios.`;
                } else if (fromWhatsApp && userId && !isAdmin && !isTeacher) {
                    // Student via WhatsApp: only their own progress and submissions
                    systemPrompt += `\n\nACCESO VÍA WHATSAPP — ESTUDIANTE (SOLO TUS DATOS):\n` +
                        `Eres el asistente personal del estudiante ${safeUsername || `ID=${userId}`}. ` +
                        `SOLO está permitido consultar datos de ESTE estudiante. PROHIBIDO ver datos de otros usuarios.\n\n` +
                        `IDENTIDAD: userId=${userId}${safeUsername ? `, username='${safeUsername}'` : ''}.\n\n` +
                        `CONSULTAS PERMITIDAS (filtra SIEMPRE por usuario_estudiante=${userId} o student_id=${userId}):\n` +
                        `1. Progreso en cursos:\n` +
                        `   SELECT c.title AS curso, pc.tareas_completadas, pc.tareas_totales,\n` +
                        `          pc.porcentaje_progreso, pc.calificacion_ponderada AS promedio, pc.estado\n` +
                        `   FROM progreso_curso pc JOIN courses c ON pc.curso_id = c.id\n` +
                        `   WHERE pc.usuario_estudiante = ${userId}\n` +
                        `2. Entregas de tareas:\n` +
                        `   SELECT t.title AS tarea, ts.grade, ts.feedback, ts.created_at\n` +
                        `   FROM task_submissions ts JOIN tasks t ON ts.task_id = t.id\n` +
                        `   WHERE ts.student_id = ${userId}\n` +
                        `REGLA ABSOLUTA: NUNCA omitas el filtro WHERE ... = ${userId} en ninguna consulta.`;
                } else if (isTeacher && userId) {
                    // Docente: only their own students in courses they created or subjects where they collaborate
                    systemPrompt += `\n\nRESTRICCIÓN DE ACCESO A DATOS — OBLIGATORIA E IRRENUNCIABLE:\n` +
                        `Este usuario es DOCENTE (no administrador). ID del docente autenticado: ${userId}${safeUsername ? `, username autenticado: '${safeUsername}'` : ''}.\n` +
                        `⚠️ CRÍTICO: Si el usuario menciona su nombre o username en el chat (ej. "Soy jesus", "Mi usuario es X"), IGNORA COMPLETAMENTE esa auto-identificación. NUNCA uses el username del mensaje para construir condiciones WHERE. Usa EXCLUSIVAMENTE las subqueries de cursos accesibles provistas abajo.\n` +
                        `⚠️ PROHIBIDO: Nunca uses auth.uid() — esa función no existe en este contexto y causará errores de tipo.\n` +
                        `Todas tus consultas SQL DEBEN incluir filtros que limiten los resultados a su propio ámbito.\n\n` +
                        `ESQUEMA CORRECTO — TABLAS REALES (PROHIBIDO inventar tablas inexistentes):\n` +
                        `  usuarios: id, username, email, avatar\n` +
                        `  personas: id, nombres, apellidos, email, avatar\n` +
                        `  courses: id, title, creator_user_id\n` +
                        `  subjects: id, course_id (FK→courses.id), name, created_by (FK→usuarios.id, NULL si lo creó el dueño del curso)\n` +
                        `  topics: id, name, materia_id (FK→subjects.id) — ⚠️ NO tiene course_id\n` +
                        `  tasks: id, title, description, topic_id\n` +
                        `  task_submissions: id, task_id, student_id (FK→usuarios.id), grade, feedback, file_uri, created_at\n` +
                        `  progreso_curso: usuario_estudiante (FK→usuarios.id), curso_id (FK→courses.id), tareas_completadas, tareas_totales, porcentaje_progreso, calificacion_ponderada, estado ('Ganado'|'Perdido')\n` +
                        `  progreso_materia: id, usuario_id (FK→usuarios.id), materia_id (FK→subjects.id), progreso_porcentaje, calificacion_promedio, tareas_completadas, tareas_totales, estado, updated_at\n` +
                        `  reinforcement_results: id, user_id (FK→usuarios.id), course_id (FK→courses.id), topic_id (FK→topics.id), task_id, total_questions, correct_answers, incorrect_answers, grade, difficulty ('EASY'|'HARD'), duration_seconds, created_at\n` +
                        `  collaborators: user_id, course_id\n` +
                        `  subscriptions: subscriber_id, creator_id  ← SIN course_id\n` +
                        `  TABLAS INEXISTENTES (PROHIBIDO usarlas): lessons, lesson_completions, enrollments, student_courses, progreso_estudiante\n\n` +
                        `═══ ÁMBITO DEL DOCENTE: MATERIAS DONDE ES COLABORADOR ═══\n` +
                        `Como docente colaborador, SOLO tienes acceso a información de estudiantes matriculados en cursos donde eres colaborador.\n` +
                        `Tu ámbito de visibilidad se define por las materias (subjects) de esos cursos.\n\n` +
                        `SUBQUERY DE CURSOS ACCESIBLES (úsala siempre para filtrar por curso):\n` +
                        `  (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution})\n\n` +
                        `SUBQUERY DE MATERIAS ACCESIBLES (úsala para filtrar por materia/subject):\n` +
                        `  (SELECT s.id FROM subjects s WHERE s.course_id IN (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution}))\n\n` +
                        `SUBQUERY DE ALUMNOS ACCESIBLES (úsala siempre para filtrar estudiantes):\n` +
                        `  (SELECT DISTINCT pc.usuario_estudiante FROM progreso_curso pc WHERE pc.curso_id IN (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution}))\n\n` +
                        `CONSULTA DE REFERENCIA — CONTAR ESTUDIANTES POR CURSO:\n` +
                        `  SELECT c.title AS curso, COUNT(DISTINCT pc.usuario_estudiante) AS estudiantes\n` +
                        `  FROM courses c\n` +
                        `  LEFT JOIN progreso_curso pc ON pc.curso_id = c.id\n` +
                        `  WHERE c.id IN (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution})\n` +
                        `  GROUP BY c.title ORDER BY c.title;\n\n` +
                        `CONSULTA DE REFERENCIA — PROGRESO DE ESTUDIANTES POR CURSO (adapta según la pregunta):\n` +
                        `  SELECT u.username AS estudiante, c.title AS curso,\n` +
                        `         pc.tareas_completadas, pc.tareas_totales, pc.porcentaje_progreso,\n` +
                        `         pc.calificacion_ponderada AS promedio, pc.estado\n` +
                        `  FROM progreso_curso pc\n` +
                        `  JOIN usuarios u ON pc.usuario_estudiante = u.id\n` +
                        `  JOIN courses c ON pc.curso_id = c.id\n` +
                        `  WHERE pc.curso_id IN (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution})\n` +
                        `  ORDER BY c.title, u.username;\n\n` +
                        `CONSULTA DE REFERENCIA — PROGRESO DE ESTUDIANTES POR MATERIA (progreso_materia):\n` +
                        `  SELECT u.username AS estudiante, s.name AS materia, c.title AS curso,\n` +
                        `         pm.progreso_porcentaje, pm.calificacion_promedio, pm.tareas_completadas,\n` +
                        `         pm.tareas_totales, pm.estado\n` +
                        `  FROM progreso_materia pm\n` +
                        `  JOIN usuarios u ON pm.usuario_id = u.id\n` +
                        `  JOIN subjects s ON pm.materia_id = s.id\n` +
                        `  JOIN courses c ON s.course_id = c.id\n` +
                        `  WHERE pm.materia_id IN (SELECT s2.id FROM subjects s2 WHERE s2.course_id IN (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution}))\n` +
                        `  ORDER BY c.title, s.name, u.username;\n\n` +
                        `CONSULTA DE REFERENCIA — NOTAS/CALIFICACIONES DE TAREAS DE TUS ESTUDIANTES:\n` +
                        `  SELECT u.username AS estudiante, t.title AS tarea, tp.name AS tema,\n` +
                        `         s.name AS materia, c.title AS curso,\n` +
                        `         ts.grade AS nota, t.max_grade AS nota_maxima, ts.feedback, ts.created_at\n` +
                        `  FROM task_submissions ts\n` +
                        `  JOIN usuarios u ON ts.student_id = u.id\n` +
                        `  JOIN tasks t ON ts.task_id = t.id\n` +
                        `  JOIN topics tp ON t.topic_id = tp.id\n` +
                        `  JOIN subjects s ON tp.materia_id = s.id\n` +
                        `  JOIN courses c ON s.course_id = c.id\n` +
                        `  WHERE s.course_id IN (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution})\n` +
                        `  ORDER BY c.title, s.name, t.title, u.username;\n\n` +
                        `CONSULTA DE REFERENCIA — PRÁCTICA DE REFUERZO (reinforcement_results) DE TUS ESTUDIANTES:\n` +
                        `  SELECT u.username AS estudiante, c.title AS curso, tp.name AS tema,\n` +
                        `         rr.total_questions AS preguntas_totales, rr.correct_answers AS respuestas_correctas,\n` +
                        `         rr.incorrect_answers AS respuestas_incorrectas, rr.grade AS nota,\n` +
                        `         rr.difficulty AS dificultad, rr.duration_seconds AS duracion_segundos,\n` +
                        `         rr.created_at AS fecha\n` +
                        `  FROM reinforcement_results rr\n` +
                        `  JOIN usuarios u ON rr.user_id = u.id\n` +
                        `  JOIN courses c ON rr.course_id = c.id\n` +
                        `  LEFT JOIN topics tp ON rr.topic_id = tp.id\n` +
                        `  WHERE rr.course_id IN (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution})\n` +
                        `  ORDER BY c.title, u.username, rr.created_at DESC;\n\n` +

                        `REGLAS DE FILTRADO OBLIGATORIAS (aplican a TODAS las queries sin excepción):\n` +
                        `1. Consultas de progreso por curso → usar tabla progreso_curso, filtrar por curso_id IN (subquery de cursos accesibles).\n` +
                        `2. Consultas de progreso por materia → usar tabla progreso_materia, filtrar por materia_id IN (subquery de materias accesibles).\n` +
                        `3. Consultas de entregas (task_submissions) → filtrar por tasks que pertenezcan a topics de materias accesibles via la cadena tasks→topics→subjects.\n` +
                        `4. Consultas de práctica/refuerzo (reinforcement_results) → filtrar por course_id IN (subquery de cursos accesibles).\n` +
                        `5. Consultas de cursos → filtrar por id IN (subquery de cursos accesibles).\n` +
                        `6. PROHIBIDO devolver datos de estudiantes o cursos de otros docentes.\n` +
                        `7. PROHIBIDO omitir estos filtros en cualquier consulta SQL.\n` +
                        `8. PROHIBIDO usar tablas que no existen: lessons, lesson_completions, enrollments, student_courses, progreso_estudiante.\n` +
                        `9. Si el usuario solicita ver "todos" los estudiantes o cursos, aplica igualmente los filtros — solo muestra los suyos.\n` +
                        `10. PROHIBIDO usar auth.uid() — causa errores de tipo. Usa las subqueries provistas.`;
                }
                // ────────────────────────────────────────────────────────────────────
            }

            // ── PRE-LOAD SCHEMA: fetch real DB schema and inject before first LLM call ──
            // This prevents the LLM from guessing table names from training knowledge and
            // immediately saying "la tabla X no existe" without checking.
            // We call get_database_schema HERE (programmatically) so the model already has
            // full, accurate table names even if it skips the tool call itself.
            if (needsMCPTools) {
                try {
                    const { MCPService } = await import('./mcp-legacy.service.js');
                    const mcp = new MCPService();
                    const schemaText = await mcp.getDynamicSchema();
                    if (schemaText) {
                        systemPrompt +=
                            `\n\n[ESQUEMA ACTUAL DE LA BASE DE DATOS — Obtenido via get_database_schema]\n` +
                            schemaText +
                            `\n[FIN DEL ESQUEMA]\n\n` +
                            `ACCIÓN OBLIGATORIA: Usa los nombres de tabla EXACTOS del esquema anterior.\n` +
                            `Si el usuario menciona "transacciones" → usa la tabla real del esquema.\n` +
                            `NUNCA digas que una tabla no existe sin primero mirar el esquema arriba.\n` +
                            `Ahora llama query_database con el SQL correcto basado en el esquema real.`;
                        console.log('[LLMDomainService] ✅ DB schema pre-loaded into system prompt');
                    }
                } catch (schErr) {
                    console.warn('[LLMDomainService] Schema pre-fetch failed, continuing without:', schErr.message);
                }
            }

            const tools = needsMCPTools ? [
                { name: 'query_database', description: 'Execute queries on Supabase database', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
                { name: 'get_database_schema', description: 'Get complete database schema', parameters: { type: 'object', properties: {} } },
            ] : [];

            let response = await this.llm.chat(systemPrompt, fullPrompt, {
                model,
                tools,
                // When MCP tools are needed AND the prompt explicitly matches DB patterns,
                // force the model to call at least one tool on the first turn.
                // When tools are available but optional (general knowledge question from
                // admin/teacher), use 'auto' so the LLM can answer directly without DB.
                toolChoice: needsMCPTools ? (toolsAvailableButOptional ? 'auto' : 'required') : 'auto',
            });

            // If the model returned tool_calls, execute them using MCPService and feed results back.
            let toolLoopExecuted = false;
            try {
                const extractToolCalls = (r) => r?.tool_calls || r?.toolCalls || (r?.raw && (r.raw.tool_calls || r.raw.toolCalls)) || null;
                let toolCalls = extractToolCalls(response);
                let loop = 0;
                const MAX_TOOL_ITERS = 3;
                while (toolCalls && toolCalls.length > 0 && loop < MAX_TOOL_ITERS) {
                    loop++;
                    toolLoopExecuted = true;
                    // Process each tool call sequentially
                    for (const tc of toolCalls) {
                        const toolName = tc.name || tc.id || (tc.function && tc.function.name) || null;
                        let toolArgs = {};
                        try {
                            if (typeof tc.arguments === 'string') toolArgs = JSON.parse(tc.arguments);
                            else toolArgs = tc.arguments || tc.args || tc.input || {};
                        } catch (e) {
                            toolArgs = { raw: tc.arguments };
                        }

                        try {
                            const { MCPService } = await import('./mcp-legacy.service.js');
                            const mcp = new MCPService();
                            const toolResult = await mcp.executeMCPTool(toolName, toolArgs, { fromWhatsApp, scopedUserId: userId });
                            // Append tool result to system prompt to allow the model to continue reasoning
                            let toolResultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2);
                            // Truncate very large tool results to prevent token overflow
                            if (toolResultStr.length > 12000) {
                                toolResultStr = toolResultStr.substring(0, 12000) + '\n... (resultados truncados por longitud)';
                            }
                            // If query_database returned data successfully, don't pass tools so the LLM formulates a text response
                            const gotData = toolName === 'query_database' && toolResult && (toolResult.success || toolResult.results);
                            const nextTools = gotData ? [] : tools;
                            response = await this.llm.chat(systemPrompt + `\n\n[TOOL_RESULT name=${toolName}]\n${toolResultStr}`, fullPrompt, { model, tools: nextTools });
                        } catch (execErr) {
                            const errStr = String(execErr && (execErr.message || execErr));
                            response = await this.llm.chat(systemPrompt + `\n\n[TOOL_ERROR name=${toolName}]\n${errStr}`, fullPrompt, { model, tools });
                        }
                    }

                    toolCalls = extractToolCalls(response);
                }
            } catch (toolLoopErr) {
                console.warn('[LLMDomainService] Tool execution loop failed:', toolLoopErr && (toolLoopErr.message || toolLoopErr));
            }

            // If we expected tools but the proper tool_calls mechanism never fired, try recovery strategies.
            // NOTE: only enter this block if the tool-calls loop never executed — if it ran at least once
            // the model already received DB data and composed its final answer; running the fallback
            // would overwrite that valid response.
            if (needsMCPTools && !toolLoopExecuted) {
                const textContent = String(response.content || '').trim();

                // Strategy 1: detect inline JSON tool call emitted by the model in its text body.
                // DeepSeek and some models emit {"tool":...,"arguments":...} as markdown instead of tool_calls.
                const inlineCall = this._extractInlineToolCall(textContent);
                if (inlineCall) {
                    let inlineSucceeded = false;
                    try {
                        const { MCPService } = await import('./mcp-legacy.service.js');
                        const mcp = new MCPService();
                        const toolResult = await mcp.executeMCPTool(inlineCall.tool, inlineCall.arguments, { fromWhatsApp, scopedUserId: userId });
                        const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2);
                        response = await this.llm.chat(
                            systemPrompt + `\n\n[TOOL_RESULT name=${inlineCall.tool}]\n${resultStr}\n[END_TOOL_RESULT]`,
                            fullPrompt, { model, tools: [] }
                        );
                        inlineSucceeded = true;
                    } catch (e) {
                        console.warn('[LLMDomainService] Inline tool call execution failed, falling back to direct query:', e.message);
                    }

                    // If inline execution failed, cascade to Strategy 2 so we don't return raw SQL to the user.
                    if (!inlineSucceeded) {
                        try {
                            const fallbackResult = await this._directDbQueryFallback(systemPrompt, fullPrompt, prompt, model);
                            if (fallbackResult !== null && fallbackResult !== undefined) response = fallbackResult;
                        } catch (e) {
                            console.warn('[LLMDomainService] Direct DB query fallback (after inline failure) failed:', e.message);
                        }
                    }
                } else {
                    // Strategy 2: two-step direct DB query (SQL generation + execution + final answer).
                    // Runs when the model produced no tool call at all (neither via tool_calls nor inline JSON).
                    try {
                        const fallbackResult = await this._directDbQueryFallback(systemPrompt, fullPrompt, prompt, model);
                        if (fallbackResult !== null && fallbackResult !== undefined) response = fallbackResult;
                    } catch (e) {
                        console.warn('[LLMDomainService] Direct DB query fallback failed:', e.message);
                    }
                }

                // Final safety net: strip any SQL or tool call JSON that leaked into the response
                let finalContent = String(response?.content || '');
                if (/"tool"\s*:\s*"query_database"/.test(finalContent)) {
                    console.warn('[LLMDomainService] Response still contains raw tool call after all fallbacks — suppressing.');
                    response = { ...response, content: 'Lo siento, no pude obtener los datos en este momento. Por favor intenta de nuevo.' };
                } else {
                    // Strip SQL code blocks that leaked through (user must never see raw SQL)
                    let cleaned = finalContent;
                    cleaned = cleaned.replace(/```sql[\s\S]*?```/gi, '');
                    cleaned = cleaned.replace(/```\s*SELECT[\s\S]*?```/gi, '');
                    if (cleaned !== finalContent) {
                        console.warn('[LLMDomainService] Stripped leaked SQL blocks from response.');
                        response = { ...response, content: cleaned.trim() };
                    }
                }
            }

            // 6. Post-process response to detect Grading Signal
            // Guard: if all fallbacks failed response may still be null/missing content
            if (!response || response.content == null) {
                return Result.fail(new ValidationError('El asistente no pudo generar una respuesta. Por favor intenta de nuevo.'));
            }
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

            // 9. Grade is saved only when the user explicitly confirms via the green button
            // (POST /submission/:id/grade). Do NOT auto-save here.

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
            // detect DB tool needs for this userPrompt
            const userPromptLc = String(userPrompt || '').toLowerCase();
            const needsTools2 = /query[_ ]database|consulta de business intelligence|query database/.test(userPromptLc);
            const tools2 = needsTools2 ? [
                { name: 'query_database', description: 'Execute queries on Supabase database', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
                { name: 'get_database_schema', description: 'Get complete database schema', parameters: { type: 'object', properties: {} } },
            ] : [];

            const response = await this.llm.chat(systemPrompt, userPrompt, { tools: tools2 });

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

            const questionLc = String(question || '').toLowerCase();
            const needsTools3 = /query[_ ]database|consulta de business intelligence|query database/.test(questionLc);
            const tools3 = needsTools3 ? [
                { name: 'query_database', description: 'Execute queries on Supabase database', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
                { name: 'get_database_schema', description: 'Get complete database schema', parameters: { type: 'object', properties: {} } },
            ] : [];

            const response = await this.llm.chat(systemPrompt, question, { tools: tools3 });

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

            const type = String(rawQuestion?.type || 'multiple_choice').trim().toLowerCase();

            if (type === 'fill_in_blank') {
                const correctAnswer = String(rawQuestion?.correctAnswer ?? rawQuestion?.correct_answer ?? '').trim();
                if (!correctAnswer) continue;
                sanitized.push({
                    type: 'fill_in_blank',
                    question: questionText,
                    correctAnswer,
                    hint: String(rawQuestion?.hint ?? '').trim() || null,
                    explanation: String(rawQuestion?.explanation || '').trim() || `La respuesta correcta es: "${correctAnswer}"`,
                });
                seenQuestions.add(normalizedQuestion);
                if (sanitized.length >= 10) break;
                continue;
            }

            if (type === 'ordering') {
                const items = Array.isArray(rawQuestion?.items) ? rawQuestion.items.map(i => String(i ?? '').trim()) : [];
                const correctOrder = Array.isArray(rawQuestion?.correctOrder ?? rawQuestion?.correct_order)
                    ? (rawQuestion.correctOrder ?? rawQuestion.correct_order).map(Number)
                    : [];
                if (items.length < 3 || correctOrder.length !== items.length) continue;
                sanitized.push({
                    type: 'ordering',
                    question: questionText,
                    items,
                    correctOrder,
                    explanation: String(rawQuestion?.explanation || '').trim() || 'Revisa el orden correcto en la explicación.',
                });
                seenQuestions.add(normalizedQuestion);
                if (sanitized.length >= 10) break;
                continue;
            }

            // multiple_choice (default)
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
                type: 'multiple_choice',
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

        // Math verification: recompute arithmetic answers programmatically
        return sanitized.map(q => this._verifyMathAnswer(q)).filter(Boolean);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MATH VERIFICATION — Programmatic answer validation for quiz questions
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Verifies and fixes math in a quiz question by recomputing the answer
     * programmatically. Returns the corrected question, or null to reject.
     * @private
     */
    _verifyMathAnswer(q) {
        if (!q) return q;
        const text = q.question;
        const lower = (text || '').toLowerCase();

        const mathSignals = /calcula|suma|total|multiplica|divide|resta|resultado|costo\s+total|precio\s+total|monto\s+total|redondea|¿cuánto|cuántos|cuántas|promedio|media|porcentaje/i;
        const hasSignificantNumbers = /\d{3,}/.test(text.replace(/,/g, ''));
        if (!mathSignals.test(lower) && !hasSignificantNumbers) return q;

        try {
            const result = this._computeExpectedMathAnswer(text);
            if (result === null) return q;

            const requestedDecimals = this._extractRequestedDecimals(text);
            let finalAnswer = result.value;
            if (requestedDecimals !== null) {
                finalAnswer = parseFloat(finalAnswer.toFixed(requestedDecimals));
            } else if (!Number.isInteger(finalAnswer)) {
                finalAnswer = parseFloat(finalAnswer.toFixed(2));
            }

            if (q.type === 'fill_in_blank') {
                const currentAnswer = parseFloat(String(q.correctAnswer).replace(/,/g, ''));
                if (!Number.isFinite(currentAnswer)) return q;
                const tolerance = Math.max(Math.abs(finalAnswer) * 0.001, 0.01);
                if (Math.abs(currentAnswer - finalAnswer) > tolerance) {
                    console.warn(`🔧 [LLM MathVerify] CORRECTED fill_in_blank: LLM="${q.correctAnswer}" → Correct="${finalAnswer}"`);
                    q.correctAnswer = String(finalAnswer);
                    q.explanation = `${result.steps.join('. ')}. Resultado final: ${finalAnswer}.`;
                }
            } else if (q.type === 'multiple_choice') {
                const optionValues = q.options.map(opt => {
                    const nums = opt.match(/[\d,]+\.?\d*/g);
                    if (!nums) return NaN;
                    const parsed = nums.map(n => parseFloat(n.replace(/,/g, ''))).filter(Number.isFinite);
                    return parsed.length > 0 ? parsed.reduce((a, b) => Math.abs(a) > Math.abs(b) ? a : b) : NaN;
                });
                let closestIdx = -1;
                let closestDiff = Infinity;
                for (let i = 0; i < optionValues.length; i++) {
                    if (!Number.isFinite(optionValues[i])) continue;
                    const diff = Math.abs(optionValues[i] - finalAnswer);
                    if (diff < closestDiff) { closestDiff = diff; closestIdx = i; }
                }
                const tolerance = Math.max(Math.abs(finalAnswer) * 0.001, 0.01);
                if (closestIdx >= 0 && closestDiff <= tolerance) {
                    if (closestIdx !== q.correctIndex) {
                        console.warn(`🔧 [LLM MathVerify] CORRECTED multiple_choice: index ${q.correctIndex}→${closestIdx} (computed=${finalAnswer})`);
                        q.correctIndex = closestIdx;
                        q.explanation = `${result.steps.join('. ')}. Resultado final: ${finalAnswer}.`;
                    }
                } else {
                    console.warn(`🔧 [LLM MathVerify] REJECTED: No option ≈ computed=${finalAnswer}`);
                    return null;
                }
            }
        } catch (err) {
            console.warn(`[LLM MathVerify] Error (non-blocking): ${err.message}`);
        }
        return q;
    }

    /** @private */
    _computeExpectedMathAnswer(text) {
        const explicit = this._tryExplicitMathArithmetic(text);
        if (explicit !== null) return explicit;
        const wordProblem = this._tryMathWordProblem(text);
        if (wordProblem !== null) return wordProblem;
        const sumFallback = this._tryMathSumFallback(text);
        if (sumFallback !== null) return sumFallback;
        return null;
    }

    /** @private Parse and evaluate explicit arithmetic chains */
    _tryExplicitMathArithmetic(text) {
        // Strip currency symbols so "$45,230 + $78,945" matches as arithmetic
        const cleaned = text.replace(/[$€¥£₡₿]\s*/g, '');
        const numberPat = '\\d[\\d,]*\\.?\\d*';
        const opPat = '[+\\-×*÷/]';
        const exprRegex = new RegExp(
            `(${numberPat})\\s*(${opPat})\\s*(${numberPat}(?:\\s*${opPat}\\s*${numberPat})*)`, 'g'
        );
        const match = exprRegex.exec(cleaned);
        if (!match) return null;
        const tokens = match[0].split(/\s*([+\-×*÷/])\s*/).filter(t => t.trim());
        let result = parseFloat(tokens[0].replace(/,/g, ''));
        if (!Number.isFinite(result)) return null;
        const steps = [];
        for (let i = 1; i < tokens.length; i += 2) {
            const op = tokens[i];
            const num = parseFloat((tokens[i + 1] || '').replace(/,/g, ''));
            if (!Number.isFinite(num)) return null;
            const prev = result;
            switch (op) {
                case '+': result += num; break;
                case '-': result -= num; break;
                case '×': case '*': result *= num; break;
                case '÷': case '/': if (num === 0) return null; result /= num; break;
                default: return null;
            }
            steps.push(`${prev} ${op} ${num} = ${result}`);
        }
        // Follow-up operation
        const after = cleaned.substring(cleaned.indexOf(match[0]) + match[0].length);
        const multMatch = after.match(/(?:multiplic[aá]r?\s+por|×|costo\s+(?:de\s+\w+\s+)*(?:de\s*)?\$?|precio\s+(?:de|por)\s*\$?)\s*([\d,.]+)/i);
        if (multMatch) {
            const factor = parseFloat(multMatch[1].replace(/,/g, ''));
            if (Number.isFinite(factor) && factor > 0) {
                const prev = result; result *= factor;
                steps.push(`${prev} × ${factor} = ${result}`);
            }
        }
        const pctMatch = after.match(/(?:impuesto|descuento|incremento|aumento|IVA)\s+(?:del?)?\s*([\d,.]+)\s*%/i);
        if (pctMatch) {
            const pct = parseFloat(pctMatch[1].replace(/,/g, ''));
            if (Number.isFinite(pct) && pct > 0) {
                const prev = result;
                const factor = /descuento/i.test(pctMatch[0]) ? (1 - pct / 100) : (1 + pct / 100);
                result *= factor;
                steps.push(`${prev} × ${factor} = ${result}`);
            }
        }
        return { value: result, steps };
    }

    /** @private Parse word problems with sum + rate/percentage */
    _tryMathWordProblem(text) {
        const lower = text.toLowerCase();
        if (!/total|suma|calcula|acumulad|promedio|media|¿cuánto|cuántos|monto|resultado/i.test(lower)) return null;
        const dataNumbers = [];
        const labeledPattern = /(?:[a-zA-ZáéíóúñÁÉÍÓÚÑ][a-zA-ZáéíóúñÁÉÍÓÚÑ\s]*[:=]\s*\$?)([\d,]+\.?\d*)/gi;
        let m;
        while ((m = labeledPattern.exec(text)) !== null) {
            const num = parseFloat(m[1].replace(/,/g, ''));
            if (Number.isFinite(num) && num >= 10) dataNumbers.push(num);
        }
        // Pattern 1b: currency amounts — "$45,230"
        if (dataNumbers.length < 2) {
            dataNumbers.length = 0;
            const currencyPat = /\$\s?([\d,]+\.?\d*)/gi;
            while ((m = currencyPat.exec(text)) !== null) {
                const num = parseFloat(m[1].replace(/,/g, ''));
                if (Number.isFinite(num) && num >= 1) dataNumbers.push(num);
            }
        }
        // Pattern 1c: "de" amounts — "ventas de 45,230"
        if (dataNumbers.length < 2) {
            dataNumbers.length = 0;
            const dePat = /(?:de|por|con|=)\s*\$?\s*([\d,]+\.?\d*)/gi;
            while ((m = dePat.exec(text)) !== null) {
                const num = parseFloat(m[1].replace(/,/g, ''));
                if (Number.isFinite(num) && num >= 10) dataNumbers.push(num);
            }
        }
        // Pattern 2: all significant numbers (≥10)
        if (dataNumbers.length < 2) {
            dataNumbers.length = 0;
            const stripped = text.replace(/[$€¥£₡₿]\s*/g, '');
            const allNums = stripped.match(/\d[\d,]*\.?\d*/g) || [];
            const pctSet = new Set();
            const pctRe = /([\d,.]+)\s*%/g;
            let pm;
            while ((pm = pctRe.exec(text)) !== null) {
                pctSet.add(parseFloat(pm[1].replace(/,/g, '')));
            }
            for (const raw of allNums) {
                const num = parseFloat(raw.replace(/,/g, ''));
                if (!Number.isFinite(num) || num < 10) continue;
                if (pctSet.has(num)) continue;
                if (num >= 1900 && num <= 2100 && Number.isInteger(num)) continue;
                dataNumbers.push(num);
            }
        }
        if (dataNumbers.length < 2) return null;
        const steps = [];
        let result;
        if (/promedio|media\b/i.test(lower)) {
            const sum = dataNumbers.reduce((a, b) => a + b, 0);
            result = sum / dataNumbers.length;
            steps.push(`Suma: ${dataNumbers.join(' + ')} = ${sum}`);
            steps.push(`Promedio: ${sum} / ${dataNumbers.length} = ${result}`);
        } else {
            result = dataNumbers.reduce((a, b) => a + b, 0);
            steps.push(`Suma: ${dataNumbers.join(' + ')} = ${result}`);
        }
        const ratePatterns = [
            /costo\s+(?:de\s+(?:procesamiento|producción|envío|operación|mantenimiento))?\s*(?:de|es|por|=)?\s*\$?([\d,.]+)/i,
            /precio\s+(?:de|por|unitario|cada)?\s*\$?([\d,.]+)/i,
            /cada\s+\w+\s+(?:tiene\s+)?(?:un\s+)?(?:costo|precio|valor)\s+(?:de\s*)?\$?([\d,.]+)/i,
            /(?:multiplic[aá]r?|×)\s*(?:por)?\s*\$?([\d,.]+)/i,
            /(?:tasa|tarifa|factor|coeficiente)\s+(?:de\s+)?(?:[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+\s+)*(?:del?\s+)?\$?([\d,.]+)(?!\s*%)/i,
            /(?:se\s+)?aplic[aá]\s+(?:un\s+)?(?:[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+\s+)*(?:del?\s+)?\$?([\d,.]+)(?!\s*%)/i,
        ];
        for (const re of ratePatterns) {
            const rm = text.match(re);
            if (rm) {
                const rate = parseFloat(rm[1].replace(/,/g, ''));
                if (Number.isFinite(rate) && rate > 0 && rate < result) {
                    const prev = result; result = result * rate;
                    steps.push(`${prev} × ${rate} = ${result}`);
                    break;
                }
            }
        }
        const pctMatch = text.match(/(?:impuesto|descuento|incremento|aumento|IVA|ISR)\s+(?:del?)?\s*([\d,.]+)\s*%/i);
        if (pctMatch) {
            const pct = parseFloat(pctMatch[1].replace(/,/g, ''));
            if (Number.isFinite(pct) && pct > 0 && pct <= 200) {
                const prev = result;
                const factor = /descuento/i.test(pctMatch[0]) ? (1 - pct / 100) : (1 + pct / 100);
                result *= factor;
                steps.push(`${prev} × ${factor} = ${result}`);
            }
        }
        // Post-operation addition (e.g. "se agrega un tráfico de respaldo de 5,000,000.500")
        const addMatch = text.match(/(?:se\s+)?(?:agrega[rn]?|añad[aeir]+|suma[rn]?|adiciona[rn]?|incorpora[rn]?)\s+(?:\S+\s+){0,8}?([\d,]+\.?\d*)/i);
        if (addMatch) {
            const addVal = parseFloat(addMatch[1].replace(/,/g, ''));
            if (Number.isFinite(addVal) && addVal > 0 && !dataNumbers.includes(addVal)) {
                const prev = result;
                result += addVal;
                steps.push(`Adición: ${prev} + ${addVal} = ${result}`);
            }
        }
        if (steps.length === 0) return null;
        return { value: result, steps };
    }

    /** @private */
    _extractRequestedDecimals(text) {
        const match = text.match(/redonde[ao].*?(\d+)\s*decimal/i);
        if (match) return parseInt(match[1]);
        const match2 = text.match(/(\d+)\s*(?:cifras?\s+)?decimal/i);
        if (match2) return parseInt(match2[1]);
        return null;
    }

    /**
     * Fallback: extract ALL significant numbers, compute sum + optional percentage.
     * @private
     */
    _tryMathSumFallback(text) {
        const lower = text.toLowerCase();
        if (!/(?:total|suma|calcula|resultado|¿cuánto|cuántos|monto|costo|precio|valor)/i.test(lower)) return null;

        const cleaned = text.replace(/[$€¥£₡₿]\s*/g, '');
        const pctValues = new Set();
        const pctRe = /([\d,.]+)\s*%/g;
        let pm;
        while ((pm = pctRe.exec(text)) !== null) {
            pctValues.add(parseFloat(pm[1].replace(/,/g, '')));
        }

        const numRe = /\d[\d,]*\.?\d*/g;
        let nm;
        const candidates = [];
        while ((nm = numRe.exec(cleaned)) !== null) {
            const val = parseFloat(nm[0].replace(/,/g, ''));
            if (!Number.isFinite(val)) continue;
            if (pctValues.has(val)) continue;
            if (val <= 5) continue;
            if (val >= 1900 && val <= 2100 && Number.isInteger(val)) continue;
            candidates.push(val);
        }
        if (candidates.length < 2) return null;

        const sorted = [...candidates].sort((a, b) => a - b);
        const largest = sorted[sorted.length - 1];
        const dataNumbers = sorted.filter(n => n >= largest * 0.001 && n >= 10);
        if (dataNumbers.length < 2) return null;

        let result;
        const steps = [];
        if (/promedio|media\b/i.test(lower)) {
            const sum = dataNumbers.reduce((a, b) => a + b, 0);
            result = sum / dataNumbers.length;
            steps.push(`Suma: ${dataNumbers.join(' + ')} = ${sum}`);
            steps.push(`Promedio: ${sum} / ${dataNumbers.length} = ${result}`);
        } else {
            result = dataNumbers.reduce((a, b) => a + b, 0);
            steps.push(`Suma: ${dataNumbers.join(' + ')} = ${result}`);
        }

        if (pctValues.size > 0) {
            const pct = [...pctValues][0];
            if (Number.isFinite(pct) && pct > 0 && pct <= 200) {
                const prev = result;
                if (/descuento/i.test(lower)) {
                    result *= (1 - pct / 100);
                    steps.push(`Descuento ${pct}%: ${prev} × ${(1 - pct / 100)} = ${result}`);
                } else if (/impuesto|iva|incremento|aumento|interés|recargo/i.test(lower)) {
                    result *= (1 + pct / 100);
                    steps.push(`+ ${pct}%: ${prev} × ${(1 + pct / 100)} = ${result}`);
                }
            }
        }

        const ratePatterns = [
            /(?:multiplic[aá]r?|×)\s*(?:por)?\s*\$?([\d,.]+)/i,
            /(?:costo|precio|tarifa|tasa|factor|coeficiente)\s+(?:de\s+)?(?:[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+\s+)*(?:del?\s+)?\$?([\d,.]+)(?!\s*%)/i,
            /(?:se\s+)?aplic[aá]\s+(?:un\s+)?(?:[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+\s+)*(?:del?\s+)?\$?([\d,.]+)(?!\s*%)/i,
        ];
        for (const re of ratePatterns) {
            const rm = text.match(re);
            if (rm) {
                const rate = parseFloat(rm[1].replace(/,/g, ''));
                if (Number.isFinite(rate) && rate > 0 && rate < result) {
                    const prev = result;
                    result *= rate;
                    steps.push(`Multiplicación: ${prev} × ${rate} = ${result}`);
                    break;
                }
            }
        }

        // Post-operation addition
        const addMatchFb = text.match(/(?:se\s+)?(?:agrega[rn]?|añad[aeir]+|suma[rn]?|adiciona[rn]?|incorpora[rn]?)\s+(?:\S+\s+){0,8}?([\d,]+\.?\d*)/i);
        if (addMatchFb) {
            const addVal = parseFloat(addMatchFb[1].replace(/,/g, ''));
            if (Number.isFinite(addVal) && addVal > 0 && !candidates.includes(addVal)) {
                const prev = result;
                result += addVal;
                steps.push(`Adición: ${prev} + ${addVal} = ${result}`);
            }
        }

        if (steps.length === 0) return null;
        return { value: result, steps };
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

    /**
     * Extracts an inline JSON tool call from model text output.
     * DeepSeek sometimes emits the JSON in the message body instead of tool_calls.
     * Supports both ```json {...} ``` blocks and bare JSON objects.
     */
    _extractInlineToolCall(text) {
        if (!text) return null;
        // Match ```json { "tool": ..., "arguments": ... } ```
        const codeBlock = text.match(/```json\s*(\{[\s\S]*?\})\s*```/i);
        if (codeBlock) {
            try {
                const parsed = JSON.parse(codeBlock[1]);
                if (parsed.tool && parsed.arguments) return parsed;
            } catch { /* not valid JSON */ }
        }
        // Match bare JSON objects containing "tool" and "arguments" keys
        const bare = text.match(/\{[^{}]*"tool"\s*:[^{}]*"arguments"\s*:[^{}]*\}/s);
        if (bare) {
            try {
                const parsed = JSON.parse(bare[0]);
                if (parsed.tool && parsed.arguments) return parsed;
            } catch { /* not valid JSON */ }
        }
        return null;
    }

    /**
     * Two-step DB query fallback when DeepSeek refuses to use tool_calls.
     * Step 1: Ask the model to generate SQL.
     * Step 2: Execute via MCPService directly.
     * Step 3: Ask the model to format the result in Markdown.
     */
    async _directDbQueryFallback(systemPrompt, fullPrompt, originalPrompt, model) {
        // Step 1: generate SQL
        // Extract any role-based access restrictions AND user identity from the existing systemPrompt
        const restrictionMatch = systemPrompt.match(/(?:NIVEL DE ACCESO|RESTRICCIÓN DE ACCESO)[\s\S]*$/);
        const restrictionCtx = restrictionMatch ? `\n\n${restrictionMatch[0]}` : '';

        const sqlSystemPrompt = [
            'Eres un experto en SQL para PostgreSQL/Supabase.',
            'El usuario hace una pregunta de negocio. Responde ÚNICAMENTE con el SQL necesario (SELECT o WITH ... SELECT), sin explicaciones.',
            'NUNCA selecciones columnas de ID. Usa JOINs para obtener nombres legibles.',
            'PROHIBIDO usar auth.uid() — esa función no existe en este contexto y causará errores de tipo.',
            'MAPEO DE NOMBRES ESPAÑOL↔INGLÉS (el usuario puede usar cualquier idioma): transacciones=transactions, suscripciones=subscriptions, tareas=tasks, entregas=task_submissions, temas=topics, materias=subjects, cursos=courses, notificaciones=notifications, usuarios=usuarios.',
            'Tablas reales del esquema: usuarios (id, username, email, avatar), personas (id, nombres, apellidos, email, avatar), courses (id, title, creator_user_id), subjects (id, course_id FK→courses.id, name), topics (id, name, materia_id FK→subjects.id — ⚠️ NO tiene course_id), tasks (id, title, description, topic_id), task_submissions (id, task_id, student_id, grade, feedback, file_uri, created_at), progreso_curso (usuario_estudiante FK→usuarios.id, curso_id FK→courses.id, tareas_completadas, tareas_totales, porcentaje_progreso, calificacion_ponderada, estado), collaborators (user_id, course_id), subscriptions (subscriber_id, creator_id — SIN course_id), transactions (id, user_id, amount, status, payment_method, reference, currency, created_at), notifications (id, user_id, title, message, type, read, created_at), videos (id, title, description, course_id, video_url, duration, order_index, created_at), whatsapp_sessions (id, user_id FK→usuarios.id, phone_number, wa_id, is_active, linked_at, last_message_at, otp_code, otp_expires_at — is_active=TRUE significa vinculado y verificado). CADENA tareas→cursos: tasks.topic_id → topics.materia_id → subjects.id → subjects.course_id → courses.id.',
            'TABLAS QUE NO EXISTEN (NUNCA las uses): lessons, lesson_completions, enrollments, student_courses, progreso_estudiante.',
            'REGLA CRÍTICA: Si el usuario menciona un nombre que no coincide exactamente con una tabla, busca la tabla más similar. NUNCA digas que algo no existe sin intentar buscarlo primero.',
            'Puedes usar CTEs (WITH ... AS (...) SELECT ...) para consultas complejas.',
        ].join('\n') + restrictionCtx;

        const sqlResponse = await this.llm.chat(sqlSystemPrompt, originalPrompt, { model, tools: [] });
        const sqlText = String(sqlResponse.content || '').trim();

        // Extract SQL from possible code block (also supports CTEs starting with WITH)
        const sqlMatch = sqlText.match(/```sql\s*([\s\S]+?)\s*```/i) ||
            sqlText.match(/```\s*((WITH|SELECT)[\s\S]+?)\s*```/i) ||
            sqlText.match(/((WITH\s+\w+|SELECT)[\s\S]+)/i);
        const sql = sqlMatch ? sqlMatch[1].trim() : sqlText;

        if (!sql || !/^\s*(SELECT|WITH)\b/i.test(sql)) {
            console.warn('[LLMDomainService] SQL fallback: no valid SELECT generated');
            return null;
        }

        console.log('[LLMDomainService] Direct SQL fallback executing:', sql.substring(0, 120));

        // Step 2: execute via MCPService
        const { MCPService } = await import('./mcp-legacy.service.js');
        const mcp = new MCPService();
        const toolResult = await mcp.executeMCPTool('query_database', { query: sql });
        const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2);

        // Step 3: format final answer
        return await this.llm.chat(
            systemPrompt + `\n\n[DATOS OBTENIDOS DE LA BASE DE DATOS]\n${resultStr}\n[FIN DE DATOS]\n\nFormula ahora tu respuesta en Markdown claro usando SOLO los datos anteriores. No inventes valores.`,
            fullPrompt,
            { model, tools: [] }
        );
    }
}
export default LLMDomainService;