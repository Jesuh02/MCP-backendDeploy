/**
 * MCP Service - Model Context Protocol
 * Handles prompt processing and context management
 */

import { RAGService } from './RAGService.js';
import { SupabaseService } from '../../infrastructure/database/SupabaseService.js';
import { logger } from '../../infrastructure/logging/Logger.js';
import { LLMService } from '../../infrastructure/ai/LLMService.js';
import { getGitHubService } from '../../infrastructure/github/GitHubService.js';
import { HumanMessage, SystemMessage, ToolMessage, AIMessage } from "@langchain/core/messages";

export class MCPService {
    constructor() {
        this.ragService = new RAGService();
        this.supabase = SupabaseService.getInstance();
        this.llmService = LLMService.getInstance();
        this.githubService = getGitHubService();
    }

    /**
     * Get reinforcement learning history for a user in a course
     * Aggregates questions from all history records
     * Optionally filters by topicId and taskId if provided
     */
    async getReinforcementHistory(userId, courseId, topicId = null, taskId = null) {
        if (!userId || !courseId) return [];
        
        console.log(`📚 MCPService: Fetching reinforcement history for user ${userId}, course ${courseId} (topic: ${topicId}, task: ${taskId})`);
        
        // Ensure supabase is initialized
        if (!this.supabase) {
             console.warn('⚠️ MCPService: SupabaseService not initialized, attempting to get instance');
             try {
                 this.supabase = SupabaseService.getInstance();
             } catch(e) {
                 console.error('❌ MCPService: Failed to get SupabaseService instance:', e.message);
                 return [];
             }
        }

        try {
            let query = this.supabase.client
                .from('reinforcement_question_history')
                .select('questions')
                .eq('user_id', userId)
                .eq('course_id', courseId);

            if (topicId) query = query.eq('topic_id', topicId);
            if (taskId) query = query.eq('task_id', taskId);
            
            const { data: existingRows, error } = await query;
            
            if (error) throw error;

            let history = [];
            if (existingRows && Array.isArray(existingRows)) {
                existingRows.forEach(row => {
                    if (row.questions && Array.isArray(row.questions)) {
                        history = history.concat(row.questions);
                    }
                });
            }
            console.log(`✅ MCPService: Found ${history.length} questions in history for user ${userId} course ${courseId}`);
            
            // Log for clarity as requested (simulation of tool execution log)
            logger.info(`🔍 Executing query: SELECT questions FROM reinforcement_question_history WHERE user_id = ${userId} AND course_id = ${courseId}`);
            
            return history;
        } catch (error) {
            logger.warn(`Error fetching reinforcement history: ${error.message}`);
            return [];
        }
    }

    /**
     * Return only the question text strings from reinforcement history
     * Useful for prompt injection / deduplication checks
     */
    async getReinforcementQuestionsText(userId, courseId) {
        const history = await this.getReinforcementHistory(userId, courseId);
        if (!Array.isArray(history) || !history.length) return [];

        return history
            .map(item => (item && (item.question || item.text || item.pregunta) ? (item.question || item.text || item.pregunta) : (typeof item === 'string' ? item : '')))
            .filter(Boolean)
            .map(s => s.replace(/\s+/g, ' ').trim());
    }

    /**
     * Extract key concepts from questions for semantic comparison
     * Returns an object with questions and their extracted concepts
     */
    async getReinforcementQuestionsWithConcepts(userId, courseId) {
        const questions = await this.getReinforcementQuestionsText(userId, courseId);
        if (!questions.length) return { questions: [], concepts: [] };

        const conceptsSet = new Set();
        const questionConcepts = [];

        questions.forEach(question => {
            // Extract concepts: technical terms, programming keywords, etc.
            const concepts = this.extractConceptsFromQuestion(question);
            questionConcepts.push({
                question,
                concepts
            });
            concepts.forEach(c => conceptsSet.add(c));
        });

        return {
            questions: questionConcepts,
            concepts: Array.from(conceptsSet)
        };
    }

    /**
     * Extract key concepts from a question
     * Identifies programming terms, technical concepts, and topic keywords
     */
    extractConceptsFromQuestion(question) {
        const concepts = [];
        const lower = question.toLowerCase();

        // Programming concepts
        const programmingTerms = [
            'variable', 'función', 'funcion', 'clase', 'objeto', 'método', 'metodo',
            'array', 'lista', 'diccionario', 'bucle', 'loop', 'if', 'else',
            'ciclo', 'iteración', 'iteracion', 'recursión', 'recursion',
            'algoritmo', 'estructura de datos', 'puntero', 'referencia',
            'herencia', 'polimorfismo', 'encapsulación', 'encapsulacion',
            'interfaz', 'clase abstracta', 'constructor', 'destructor',
            'scope', 'ámbito', 'ambito', 'closure', 'callback', 'promesa',
            'async', 'await', 'sincronía', 'asincronia', 'thread', 'hilo',
            'proceso', 'memoria', 'heap', 'stack', 'pila', 'cola', 'queue',
            'árbol', 'arbol', 'grafo', 'hash', 'tabla hash', 'ordenamiento',
            'búsqueda', 'busqueda', 'complejidad', 'big o', 'recursividad',
            'parámetro', 'parametro', 'argumento', 'return', 'retorno',
            'tipo de dato', 'string', 'número', 'numero', 'booleano', 'boolean',
            'null', 'undefined', 'exception', 'excepción', 'error', 'try', 'catch'
        ];

        // Web/Mobile concepts
        const webMobileTerms = [
            'html', 'css', 'javascript', 'react', 'vue', 'angular', 'node',
            'express', 'api', 'rest', 'http', 'endpoint', 'request', 'response',
            'json', 'xml', 'ajax', 'fetch', 'axios', 'dom', 'evento', 'event',
            'componente', 'props', 'state', 'hook', 'lifecycle', 'render',
            'virtual dom', 'spa', 'ssr', 'csr', 'routing', 'enrutamiento',
            'android', 'ios', 'flutter', 'react native', 'kotlin', 'swift',
            'activity', 'fragment', 'view', 'layout', 'intent', 'bundle'
        ];

        // Database concepts
        const databaseTerms = [
            'base de datos', 'database', 'sql', 'query', 'consulta', 'select',
            'insert', 'update', 'delete', 'join', 'tabla', 'table', 'columna',
            'fila', 'row', 'índice', 'indice', 'clave primaria', 'primary key',
            'foreign key', 'clave foránea', 'transacción', 'transaccion',
            'normalización', 'normalizacion', 'relación', 'relacion'
        ];

        const allTerms = [...programmingTerms, ...webMobileTerms, ...databaseTerms];

        // Find matching terms
        allTerms.forEach(term => {
            if (lower.includes(term)) {
                concepts.push(term);
            }
        });

        // Also extract question type indicators
        if (lower.includes('qué es') || lower.includes('que es') || lower.includes('what is')) {
            concepts.push('DEFINICIÓN');
        }
        if (lower.includes('cómo') || lower.includes('como') || lower.includes('how')) {
            concepts.push('PROCEDIMIENTO');
        }
        if (lower.includes('cuál es la diferencia') || lower.includes('diferencia entre')) {
            concepts.push('COMPARACIÓN');
        }
        if (lower.includes('ventaja') || lower.includes('desventaja') || lower.includes('beneficio')) {
            concepts.push('ANÁLISIS');
        }
        if (lower.includes('ejemplo') || lower.includes('example')) {
            concepts.push('EJEMPLO');
        }

        return [...new Set(concepts)];
    }

    /**
     * Save new reinforcement learning questions to history
     * Uses INSERT to support log-based schema (multiple rows per user/course)
     */
    async saveReinforcementHistory(userId, courseId, questions, topicId = null, taskId = null) {
        if (!userId || !courseId || !questions || !questions.length) return false;

        try {
            const payload = {
                user_id: userId,
                course_id: courseId,
                questions: questions,
                created_at: new Date().toISOString()
            };

            if (topicId) payload.topic_id = topicId;
            if (taskId) payload.task_id = taskId;

            const { error } = await this.supabase.client
                .from('reinforcement_question_history')
                .insert(payload);
            
            if (error) throw error;
            return true;
        } catch (error) {
            logger.warn(`Error saving reinforcement history: ${error.message}`);
            return false;
        }
    }

    /**
     * Detect business / marketing intent keywords in the natural language query.
     */
    isBusinessIntent(query) {
        if (!query) {
            return false;
        }

        const keywords = [
            'inteligencia',
            'business intelligence',
            'bi ',
            'kpi',
            'indicador',
            'indicadores',
            'marketing',
            'growth',
            'ventas',
            'retencion',
            'estrategia',
            'funnel',
            'conversion',
            'campana',
            'campaign'
        ];

        const lower = query.toLowerCase();
        return keywords.some(keyword => lower.includes(keyword));
    }

    /**
     * Build a curated data snapshot so the LLM always has real Supabase metrics.
     */
    async generateDataSnapshot(query, options = {}) {
        const {
            isBusinessQuestion = false,
            reason = 'fallback'
        } = options;

        const sqlStatements = [];
        const metrics = {};
        const samples = {};
        const insights = {};
        const summary = [];

        const countConfigs = [
            { key: 'usuarios_total', table: 'usuarios' },
            { key: 'courses_total', table: 'courses' },
            { key: 'videos_total', table: 'videos' },
            { key: 'subscriptions_total', table: 'subscriptions' },
            { key: 'task_submissions_total', table: 'task_submissions' }
        ];

        for (const { key, table } of countConfigs) {
            const sql = `SELECT COUNT(*) AS total FROM ${table}`;
            sqlStatements.push(sql);

            try {
                const { count, error } = await this.supabase.client
                    .from(table)
                    .select('*', { head: true, count: 'exact' });

                if (error) {
                    throw error;
                }

                metrics[key] = (count !== null && count !== undefined) ? count : 0;
            } catch (error) {
                logger.warn(`Count query failed for ${key}: ${error.message}`);
            }
        }

        const tablesToSample = ['usuarios', 'courses', 'videos', 'subscriptions', 'task_submissions', 'content_items'];
        for (const table of tablesToSample) {
            const sql = `SELECT * FROM ${table} LIMIT 5`;
            sqlStatements.push(sql);

            try {
                const { data, error } = await this.supabase.client
                    .from(table)
                    .select('*')
                    .limit(5);

                if (error) {
                    throw error;
                }

                if (data && data.length > 0) {
                    samples[table] = data;

                    // Capture a short preview for the summary (first row key metrics)
                    const preview = Array.isArray(data) && data[0] ? data[0] : null;
                    if (preview) {
                        const previewText = Object.entries(preview)
                            .slice(0, 3)
                            .map(([key, value]) => `${key}: ${value}`)
                            .join(', ');
                        summary.push(`Muestra de ${table}: ${previewText}`);
                    }
                }
            } catch (error) {
                logger.warn(`Sample query failed for ${table}: ${error.message}`);
            }
        }

        if (isBusinessQuestion) {
            const marketingConfigs = [{
                    key: 'top_creators_by_courses',
                    table: 'courses',
                    candidateFields: ['creator_username', 'creatorUsername'],
                    canonicalField: 'creator_username',
                    countField: 'courses_count',
                    sql: 'SELECT creator_username, COUNT(*) AS courses_count FROM courses GROUP BY creator_username ORDER BY courses_count DESC LIMIT 5'
                },
                {
                    key: 'top_creators_by_videos',
                    table: 'videos',
                    candidateFields: ['username', 'creator_username', 'creatorUsername', 'uploader'],
                    canonicalField: 'username',
                    countField: 'videos_count',
                    sql: 'SELECT username, COUNT(*) AS videos_count FROM videos GROUP BY username ORDER BY videos_count DESC LIMIT 5'
                },
                {
                    key: 'subscribers_activity',
                    table: 'subscriptions',
                    candidateFields: ['subscriber_username', 'subscriberUsername'],
                    canonicalField: 'subscriber_username',
                    countField: 'subscriptions_count',
                    sql: 'SELECT subscriber_username, COUNT(*) AS subscriptions_count FROM subscriptions GROUP BY subscriber_username ORDER BY subscriptions_count DESC LIMIT 5'
                }
            ];

            for (const config of marketingConfigs) {
                sqlStatements.push(config.sql);

                try {
                    let dataset = [];
                    let fieldFound = false;

                    for (const column of config.candidateFields) {
                        const { data, error } = await this.supabase.client
                            .from(config.table)
                            .select(column);

                        if (!error) {
                            dataset = Array.isArray(data) ? data : [];
                            fieldFound = true;
                            break;
                        }

                        logger.warn(`Column ${column} not available in ${config.table}: ${error.message}`);
                    }

                    if (!fieldFound) {
                        const { data, error } = await this.supabase.client
                            .from(config.table)
                            .select('*');

                        if (error) {
                            throw error;
                        }

                        dataset = Array.isArray(data) ? data : [];
                    }

                    if (dataset.length > 0) {
                        const aggregated = dataset.reduce((acc, row) => {
                            const value = config.candidateFields
                                .map(column => row[column])
                                .find(columnValue => typeof columnValue === 'string' && columnValue.trim().length > 0);

                            if (!value) {
                                return acc;
                            }

                            acc[value] = (acc[value] || 0) + 1;
                            return acc;
                        }, {});

                        const ranked = Object.entries(aggregated)
                            .map(([name, total]) => ({
                                [config.canonicalField]: name,
                                [config.countField]: total
                            }))
                            .sort((a, b) => b[config.countField] - a[config.countField])
                            .slice(0, 5);

                        if (ranked.length > 0) {
                            insights[config.key] = ranked;

                            const headline = ranked
                                .map(entry => {
                                    const name = entry[config.canonicalField];
                                    const total = entry[config.countField];
                                    return `${name}: ${total}`;
                                })
                                .join(', ');
                            summary.push(`Insight ${config.key}: ${headline}`);
                        }
                    }
                } catch (error) {
                    logger.warn(`Marketing insight query failed for ${config.key}: ${error.message}`);
                }
            }
        }

        // Build headline summary from metrics if available
        if (Object.keys(metrics).length > 0) {
            summary.unshift(
                `Totales — Usuarios: ${metrics.usuarios_total ?? 'N/D'}, Cursos: ${metrics.courses_total ?? 'N/D'}, Videos: ${metrics.videos_total ?? 'N/D'}, Suscripciones: ${metrics.subscriptions_total ?? 'N/D'}, Entregas de tareas: ${metrics.task_submissions_total ?? 'N/D'}`
            );
        }

        const recommendedActions = [];
        if (insights.top_creators_by_courses && insights.top_creators_by_courses.length) {
            recommendedActions.push('Consolidar colaboraciones con los creadores con más cursos publicados para impulsar campañas conjuntas.');
        }
        if (insights.top_creators_by_videos && insights.top_creators_by_videos.length) {
            recommendedActions.push('Reutilizar los videos de mayor volumen para anuncios o secuencias de email nurturing.');
        }
        if (insights.subscribers_activity && insights.subscribers_activity.length) {
            recommendedActions.push('Segmentar comunicaciones personalizadas a los suscriptores más activos para mejorar retención.');
        }

        const snapshot = {
            reason,
            isBusinessQuestion,
            query,
            generated_at: new Date().toISOString(),
            metrics,
            samples,
            insights,
            summary,
            recommended_actions: recommendedActions
        };

        if (!Object.keys(metrics).length && !Object.keys(samples).length && !Object.keys(insights).length) {
            snapshot.note = 'No se pudieron recuperar datos en el snapshot automático. Revise la conexión con Supabase o refine la consulta.';
        }

        return {
            data: snapshot,
            sqlScript: sqlStatements.map(sql => `${sql};`).join('\n')
        };
    }

    /**
     * Process a query and return actual data from Supabase
     */
    async processQuery(query, options = {}) {
        try {
            const {
                includeRAG = true,
                // CHANGED: Always include schema by default to ensure database context
                includeSchema = true
            } = options;

            logger.info(`Processing query: ${query.substring(0, 100)}...`);
            logger.info(`Full query length: ${query.length} characters`);
            logger.info(`Complete query: "${query}"`);

            // MANDATORY: Always get database schema first
            let schemaDetails = null;
            try {
                schemaDetails = await this.getDatabaseSchema();
                logger.info('✅ Database schema loaded for query validation');
            } catch (schemaError) {
                logger.error('Error fetching schema:', schemaError);
            }

            // Validate query is database-related
            if (schemaDetails && !this.isDatabaseRelatedQuery(query, schemaDetails.schema)) {
                logger.warn(`⚠️ Query rejected - not database related: "${query}"`);
                return {
                    error: true,
                    message: 'Consulta fuera de alcance',
                    hint: `Solo puedo responder preguntas relacionadas con la base de datos de YisusCompany. Tablas disponibles: ${Object.keys(schemaDetails.schema || {}).join(', ')}`,
                    reason: 'not-database-related'
                };
            }

            const queryPlan = await this.extractSQLFromQuery(query);
            logger.info('Query plan generated:', JSON.stringify(queryPlan));

            let data = null;
            let sqlScript = null;

            if (queryPlan) {
                try {
                    const execution = await this.executeQuery(queryPlan);
                    data = execution.data;
                    sqlScript = execution.sql;
                } catch (sqlError) {
                    logger.error('SQL execution failed.', sqlError);

                    let hint = "";
                    const msg = sqlError.message || "";

                    if (msg.includes("column") && msg.includes("does not exist")) {
                        hint = "SCHEMA ERROR: A column you requested does not exist. Use `get_database_schema` to check column names.";
                    } else if (msg.includes("relation") && msg.includes("does not exist")) {
                        hint = "SCHEMA ERROR: A table you requested does not exist. Use `get_database_schema` to check table names.";
                    } else if (msg.includes("missing FROM-clause")) {
                        hint = "SQL SYNTAX ERROR: You used an alias without defining it in the FROM clause (e.g. `SELECT t.id FROM table` instead of `FROM table t`).";
                    } else if (msg.includes('syntax error at or near "<"')) {
                        hint = "SQL SYNTAX ERROR: You are using placeholders like `<ID>` or `<CREADOR_ID>`. You MUST use actual values (e.g. `WHERE id = 1`) or standard SQL parameters if supported. Do NOT use angle brackets.";
                    } else {
                        hint = "Complex queries (JOIN, GROUP BY, SUBQUERIES) are NOT supported. You MUST retrieve raw data (e.g., 'SELECT student_id FROM task_submissions') and perform aggregations/joins in your reasoning.";
                    }

                    // Specific hint for the common hallucination about creator_user_id in usuarios
                    if (msg.includes('usuarios.creator_user_id')) {
                        hint = "CRITICAL SCHEMA ERROR: The 'usuarios' table does NOT have a 'creator_user_id' column. That column belongs to 'courses'. To find creators, check 'courses.creator_user_id'.";
                    }

                    // Specific hint for task_submissions.student_username error
                    if (sqlError.message && sqlError.message.includes('task_submissions.student_username')) {
                        hint = "CRITICAL SCHEMA ERROR: The 'task_submissions' table does NOT have a 'student_username' column. It uses 'student_id' (Foreign Key to usuarios.id). Please use 'student_id' instead.";
                    }

                    // Specific hint for grouping error 42803 or general complex query attempts
                    if (sqlError.code === '42803' || (sqlError.message && (sqlError.message.includes('GROUP BY') || sqlError.message.includes('STRICT MODE')))) {
                        hint = "SQL ERROR: You are trying to use aggregations (COUNT, GROUP BY) or SUBQUERIES which are forbidden. STRATEGY: 1) Select all raw IDs (SELECT student_id FROM ...). 2) Count them in your head. 3) Select the user details for the top ID.";
                    }

                    // Return explicit error instead of generic snapshot to avoid confusing the LLM
                    data = {
                        error: true,
                        message: `Error executing SQL: ${sqlError.message}`,
                        hint: hint,
                        query: query,
                        reason: 'execution-error'
                    };
                    sqlScript = "-- Execution failed: " + sqlError.message;
                }
            } else {
                const fallback = await this.generateDataSnapshot(query, {
                    reason: 'no-plan',
                    isBusinessQuestion: this.isBusinessIntent(query)
                });
                data = fallback.data;
                sqlScript = fallback.sqlScript;
            }

            // Schema already loaded at the beginning - no need to fetch again
            // Just log if it will be included
            if (includeSchema && schemaDetails) {
                logger.info('Schema snapshot attached to response');
            }

            return {
                data,
                sqlScript,
                schema: includeSchema ? schemaDetails : null
            };
        } catch (error) {
            logger.error('Error processing query:', error);
            return {
                error: true,
                message: error.message,
                hint: "An unexpected error occurred while processing your request."
            };
        }
    }

    /**
     * Process a natural language query to get raw data (for Excel/Reports)
     * Uses MCP Agent with tools to query the database iteratively.
     * NO RETRY LIMIT - Self-correcting until success.
     */
    async processQueryToData(query, userId = null) {
        logger.info(`📊 Processing query to data (MCP Agent): "${query}" (User: ${userId})`);

        if (!this.llmService || !this.llmService.model) {
            throw new Error("LLM Service not available for SQL generation");
        }

        // Use the MCP Agent approach
        const conversationHistory = [];
        let iteration = 0;
        const MAX_SAFETY_ITERATIONS = 30;
        let lastSuccessfulResult = null;

        const systemMessage = new SystemMessage(`Eres un agente de base de datos. Tu objetivo es obtener datos RAW para exportar a Excel.

**HERRAMIENTAS:**
1. \`get_database_schema\` - Obtiene el esquema de la base de datos
2. \`query_database\` - Ejecuta consultas SQL

**FLUJO:**
1. Usa get_database_schema para conocer las tablas y columnas
2. Ejecuta query_database con SQL válido
3. Si hay error, analízalo y corrige
4. Cuando obtengas datos, responde con: DATOS_LISTOS

**REGLAS:**
- USA SOLO columnas que existan en el esquema
- Incluye LIMIT 1000 para evitar sobrecargar el servidor
- Si la consulta falla, corrige basándote en el error

**FORMATO:**
\`\`\`json
{"tool": "nombre", "arguments": {"query": "SELECT..."}}
\`\`\`

Cuando tengas los datos, responde: DATOS_LISTOS`);

        conversationHistory.push(systemMessage);
        conversationHistory.push(new HumanMessage(`Obtén los datos para: ${query}${userId ? `\nUsuario actual: ${userId}` : ''}`));

        let consecutiveEmptyResponses = 0;
        const MAX_EMPTY_RESPONSES = 2; // Exit after 2 consecutive empty/no-tool responses

        while (iteration < MAX_SAFETY_ITERATIONS) {
            iteration++;
            
            const response = await this.llmService.generateResponse(conversationHistory, []);
            const responseContent = response.content || "";

            // Check if agent signals completion
            if (responseContent.includes('DATOS_LISTOS') && lastSuccessfulResult) {
                logger.info(`✅ Data query completed after ${iteration} iterations`);
                return { 
                    data: lastSuccessfulResult.results || lastSuccessfulResult, 
                    sql: lastSuccessfulResult.query || 'AGENT_QUERY',
                    iterations: iteration 
                };
            }

            const toolCall = this.extractToolCall(responseContent);

            if (toolCall) {
                consecutiveEmptyResponses = 0; // Reset counter on valid tool call
                let toolResult;
                try {
                    toolResult = await this.executeMCPTool(toolCall.tool, toolCall.arguments);
                    
                    // Store successful query results
                    if (toolCall.tool === 'query_database' && toolResult.success) {
                        lastSuccessfulResult = toolResult;
                    }
                } catch (toolError) {
                    toolResult = {
                        error: true,
                        message: toolError.message,
                        hint: this.getErrorHint(toolError.message)
                    };
                }

                conversationHistory.push(new AIMessage(responseContent));
                conversationHistory.push(new HumanMessage(
                    `**Resultado de ${toolCall.tool}:**\n\`\`\`json\n${JSON.stringify(toolResult, null, 2)}\n\`\`\`\n\n${toolResult.success ? 'Los datos están listos. Responde: DATOS_LISTOS' : 'Corrige tu consulta basándote en el error.'}`
                ));
            } else if (lastSuccessfulResult) {
                // No tool call but we have results - return them
                return { 
                    data: lastSuccessfulResult.results || lastSuccessfulResult, 
                    sql: lastSuccessfulResult.query || 'AGENT_QUERY',
                    iterations: iteration 
                };
            } else {
                // No tool call and no results - track empty responses
                consecutiveEmptyResponses++;
                logger.warn(`⚠️ No tool call detected (${consecutiveEmptyResponses}/${MAX_EMPTY_RESPONSES})`);

                if (consecutiveEmptyResponses >= MAX_EMPTY_RESPONSES) {
                    // Try fallback with simple SQL generation
                    logger.info(`🔄 Attempting fallback SQL for query: "${query}"`);
                    const fallbackSql = this.generateSimpleSqlForQuery(query);
                    
                    if (fallbackSql) {
                        try {
                            const fallbackResult = await this.supabase.executeRawSQL(fallbackSql);
                            return {
                                data: fallbackResult,
                                sql: fallbackSql,
                                iterations: iteration,
                                fallback: true
                            };
                        } catch (fallbackError) {
                            logger.error(`❌ Fallback SQL failed: ${fallbackError.message}`);
                        }
                    }
                    
                    // If fallback fails, throw error to exit loop
                    throw new Error(`El LLM no pudo generar una consulta válida después de ${iteration} intentos. Intenta reformular tu pregunta.`);
                }

                // Only add one retry message (not in a loop)
                conversationHistory.push(new AIMessage(responseContent || "(sin respuesta)"));
                conversationHistory.push(new HumanMessage(
                    `Necesito que uses las herramientas. Primero usa get_database_schema para ver las tablas, luego query_database para ejecutar SQL.\n\nFormato requerido:\n\`\`\`json\n{"tool": "get_database_schema", "arguments": {}}\n\`\`\``
                ));
            }
        }

        // Fallback if max iterations reached
        if (lastSuccessfulResult) {
            return { 
                data: lastSuccessfulResult.results || lastSuccessfulResult, 
                sql: lastSuccessfulResult.query || 'AGENT_QUERY',
                iterations: iteration,
                warning: 'Max iterations reached but data was obtained'
            };
        }

        throw new Error(`No se pudieron obtener datos después de ${MAX_SAFETY_ITERATIONS} iteraciones`);
    }

    /**
     * Process a query using the Agent (LLM)
     * @param {string} query Natural language query
     * @returns {Promise<any>} Agent response
     * DEPRECATED: Use the main processQueryWithAgent below with tool calling
     */

    /**
     * Process a query using an LLM Agent with MCP Tools.
     * The LLM uses tools iteratively (get_database_schema, query_database) and self-corrects on errors.
     * NO RETRY LIMIT - The agent continues until it succeeds or decides to stop.
     */
    async processQueryWithAgent(query) {
        logger.info(`🤖 Processing query with MCP Agent: "${query}"`);

        if (!this.llmService || !this.llmService.model) {
            logger.warn("⚠️ LLM Service not available. Returning fallback message.");
            return "Lo siento, el servicio de IA no está disponible en este momento (Falta configuración de API Key). Por favor, intenta consultas SQL directas o verifica la configuración del servidor.";
        }

        try {
            // ============================================================
            // � PRE-LOAD DATABASE SCHEMA
            // Load schema upfront so LLM doesn't need to call get_database_schema
            // This makes the agent more reliable with DeepSeek
            // ============================================================
            const schemaInfo = `
**ESQUEMA DE LA BASE DE DATOS:**
- usuarios: id, username, email, first_name, last_name, is_active, created_at
- courses: id, title, description, price, is_premium, creator_user_id, thumbnail_url, created_at
- videos: id, title, description, course_id, video_url, duration, order_index, created_at
- topics: id, title, description, course_id, order_index, created_at
- tasks: id, title, description, topic_id, due_date, max_grade, created_at
- task_submissions: id, task_id, user_id, file_url, grade, feedback, submitted_at, graded_at
- subscriptions: id, user_id, course_id, status, price, created_at, expires_at
- transactions: id, user_id, amount, status, payment_method, reference, currency, created_at
- notifications: id, user_id, title, message, type, read, created_at`;

            logger.info(`Using hardcoded schema for reliability`);

            // ============================================================
            // 🤖 AGENT LOOP - No limit, self-correcting
            // ============================================================
            const conversationHistory = [];
            let iteration = 0;
            const MAX_SAFETY_ITERATIONS = 50; // Safety limit to prevent infinite loops

            // System message for the agent WITH pre-loaded schema
            const systemMessage = new SystemMessage(`Eres un agente de base de datos inteligente. Tu trabajo es responder preguntas consultando la base de datos.
${schemaInfo}

**INSTRUCCIONES:**
1. Analiza la pregunta del usuario
2. Genera una consulta SQL usando SOLO las tablas y columnas del esquema arriba
3. Responde con el SQL en este formato EXACTO:

\`\`\`json
{"tool": "query_database", "arguments": {"query": "SELECT ... FROM ... WHERE ..."}}
\`\`\`

4. Si recibes resultados, analízalos y presenta un resumen claro al usuario
5. Si hay error, corrige el SQL y vuelve a intentar

**REGLAS:**
- USA SOLO columnas que existan en el esquema
- Para cursos premium/de pago: WHERE price > 0 o WHERE price IS NOT NULL
- Para obtener creadores de cursos: JOIN usuarios ON courses.creator_user_id = usuarios.id
- Siempre incluye LIMIT para evitar resultados muy largos

**IMPORTANTE:** Responde SOLO con el JSON de tool call o con el análisis final. No expliques qué vas a hacer.`);

            conversationHistory.push(systemMessage);
            conversationHistory.push(new HumanMessage(query));

            let consecutiveEmptyResponses = 0;
            const MAX_EMPTY_RESPONSES = 3; // Increased slightly since we have schema pre-loaded
            let lastSuccessfulData = null;

            while (iteration < MAX_SAFETY_ITERATIONS) {
                iteration++;
                logger.info(`🔄 Agent iteration ${iteration}`);

                // Get LLM response (no tools passed - schema is pre-loaded in prompt)
                const response = await this.llmService.generateResponse(conversationHistory, []);
                const responseContent = response.content || "";

                logger.info(`📝 LLM Response (iteration ${iteration}):`, responseContent.substring(0, 500));

                // Check if there are tool calls in the response
                const toolCall = this.extractToolCall(responseContent);

                if (toolCall) {
                    consecutiveEmptyResponses = 0; // Reset on valid tool call
                    logger.info(`🛠️ Tool call detected: ${toolCall.tool}`);
                    logger.info(`📥 Tool arguments:`, JSON.stringify(toolCall.arguments, null, 2));

                    // Execute the tool
                    let toolResult;
                    try {
                        toolResult = await this.executeMCPTool(toolCall.tool, toolCall.arguments);
                        logger.info(`✅ Tool ${toolCall.tool} executed successfully`);
                        
                        // Store successful data
                        if (toolCall.tool === 'query_database' && toolResult.success) {
                            lastSuccessfulData = toolResult;
                        }
                        
                        // Log result summary
                        const resultSummary = typeof toolResult === 'string' 
                            ? toolResult.substring(0, 1000) 
                            : JSON.stringify(toolResult, null, 2).substring(0, 1000);
                        logger.info(`📤 Tool result:`, resultSummary);

                    } catch (toolError) {
                        logger.error(`❌ Tool ${toolCall.tool} failed:`, toolError.message);
                        toolResult = {
                            error: true,
                            message: toolError.message,
                            details: `Error ejecutando ${toolCall.tool}: ${toolError.message}. Por favor analiza el error y corrige tu consulta.`
                        };
                    }

                    // Add the assistant's tool call and the tool result to history
                    conversationHistory.push(new AIMessage(responseContent));
                    
                    // Format tool result for the LLM
                    const toolResultMessage = new HumanMessage(
                        `**Resultado de ${toolCall.tool}:**\n\`\`\`json\n${JSON.stringify(toolResult, null, 2)}\n\`\`\`\n\nAnaliza este resultado y continúa con tu tarea. Si hay un error, corrige tu consulta. Si tienes suficiente información, presenta la respuesta final al usuario.`
                    );
                    conversationHistory.push(toolResultMessage);

                } else {
                    // No tool call - check if it's a final response or empty
                    const trimmedResponse = responseContent.trim();
                    
                    // If we have meaningful content (not just empty), treat as final response
                    if (trimmedResponse.length > 50) {
                        logger.info(`✅ Agent completed after ${iteration} iterations`);
                        
                        // Clean up any residual code blocks that shouldn't be shown
                        let finalResponse = responseContent;
                        finalResponse = finalResponse.replace(/```json\s*\{[\s\S]*?"tool"[\s\S]*?\}\s*```/gi, '');
                        
                        return finalResponse.trim();
                    }
                    
                    // Empty or too short response - track consecutive failures
                    consecutiveEmptyResponses++;
                    logger.warn(`⚠️ Empty/short response (${consecutiveEmptyResponses}/${MAX_EMPTY_RESPONSES})`);
                    
                    if (consecutiveEmptyResponses >= MAX_EMPTY_RESPONSES) {
                        // Return last successful data if available
                        if (lastSuccessfulData) {
                            logger.info(`📊 Returning last successful data after empty responses`);
                            return `Datos obtenidos:\n\`\`\`json\n${JSON.stringify(lastSuccessfulData.results || lastSuccessfulData, null, 2)}\n\`\`\``;
                        }
                        
                        // Try fallback SQL based on query analysis
                        logger.info(`🔄 Attempting intelligent fallback SQL for: "${query}"`);
                        const fallbackSql = this.generateSmartFallbackSQL(query);
                        if (fallbackSql) {
                            try {
                                logger.info(`📊 Executing fallback SQL: ${fallbackSql}`);
                                const fallbackResult = await this.supabase.executeRawSQL(fallbackSql);
                                const resultCount = Array.isArray(fallbackResult) ? fallbackResult.length : 0;
                                logger.info(`✅ Fallback SQL success: ${resultCount} results`);
                                
                                // Format response nicely
                                if (resultCount === 0) {
                                    return "No se encontraron resultados para tu consulta.";
                                } else if (resultCount === 1 && fallbackResult[0].total !== undefined) {
                                    return `**Resultado:** ${fallbackResult[0].total}`;
                                } else {
                                    return `**Resultados encontrados (${resultCount}):**\n\`\`\`json\n${JSON.stringify(fallbackResult, null, 2)}\n\`\`\``;
                                }
                            } catch (e) {
                                logger.error(`❌ Fallback SQL failed: ${e.message}`);
                            }
                        }
                        
                        return "No se pudo generar una respuesta. Por favor intenta reformular tu pregunta con más detalle o usa una consulta SQL directa.";
                    }
                    
                    // Add retry message with example specific to the query
                    conversationHistory.push(new AIMessage(responseContent || "(sin respuesta)"));
                    conversationHistory.push(new HumanMessage(
                        `Genera una consulta SQL para responder la pregunta. Formato requerido:\n\`\`\`json\n{"tool": "query_database", "arguments": {"query": "SELECT ... FROM ... LIMIT 50"}}\n\`\`\`\n\nRecuerda usar SOLO las columnas del esquema proporcionado.`
                    ));
                }
            }

            // Safety limit reached
            logger.warn(`⚠️ Agent reached safety limit of ${MAX_SAFETY_ITERATIONS} iterations`);
            return `El agente alcanzó el límite de iteraciones. Por favor intenta una pregunta más específica.`;

        } catch (error) {
            logger.error(`❌ Agent error: ${error.message}`, error.stack);
            return `Error procesando la consulta: ${error.message}\n\nIntenta reformular tu pregunta.`;
        }
    }

    /**
     * Extract tool call from LLM response
     * Looks for JSON blocks with tool calls
     */
    extractToolCall(responseContent) {
        if (!responseContent) return null;

        // Try to find JSON tool call in code block
        const jsonBlockMatch = responseContent.match(/```json\s*\n?([\s\S]*?)\n?```/);
        if (jsonBlockMatch) {
            try {
                const parsed = JSON.parse(jsonBlockMatch[1].trim());
                if (parsed.tool) {
                    return {
                        tool: parsed.tool,
                        arguments: parsed.arguments || {}
                    };
                }
            } catch (e) {
                logger.warn(`Failed to parse JSON tool call: ${e.message}`);
            }
        }

        // Try to find inline JSON tool call
        const inlineMatch = responseContent.match(/\{"tool"\s*:\s*"([^"]+)"[^}]*\}/);
        if (inlineMatch) {
            try {
                const parsed = JSON.parse(inlineMatch[0]);
                if (parsed.tool) {
                    return {
                        tool: parsed.tool,
                        arguments: parsed.arguments || {}
                    };
                }
            } catch (e) {
                logger.warn(`Failed to parse inline tool call: ${e.message}`);
            }
        }

        return null;
    }

    /**
     * Execute an MCP tool
     */
    async executeMCPTool(toolName, args) {
        logger.info(`🔧 Executing MCP tool: ${toolName}`);

        switch (toolName) {
            case 'get_database_schema':
                const schema = await this.getDatabaseSchema();
                return schema;

            case 'query_database':
                if (!args.query) {
                    throw new Error("El parámetro 'query' es requerido para query_database");
                }
                
                logger.info(`📊 Executing SQL: ${args.query}`);
                
                try {
                    const result = await this.supabase.executeRawSQL(args.query);
                    return {
                        success: true,
                        query: args.query,
                        results: result,
                        rowCount: result?.length || 0
                    };
                } catch (sqlError) {
                    // Return detailed error for self-correction
                    return {
                        success: false,
                        query: args.query,
                        error: sqlError.message,
                        errorType: this.classifyError(sqlError.message),
                        hint: this.getErrorHint(sqlError.message)
                    };
                }

            default:
                throw new Error(`Herramienta desconocida: ${toolName}`);
        }
    }

    /**
     * Get helpful hint for SQL errors
     */
    getErrorHint(errorMessage) {
        const lower = errorMessage.toLowerCase();
        
        if (lower.includes('column') && lower.includes('does not exist')) {
            return "La columna no existe. Usa get_database_schema para ver las columnas correctas de la tabla.";
        }
        if (lower.includes('relation') && lower.includes('does not exist')) {
            return "La tabla no existe. Usa get_database_schema para ver las tablas disponibles.";
        }
        if (lower.includes('syntax error')) {
            return "Error de sintaxis SQL. Revisa la estructura de tu consulta.";
        }
        if (lower.includes('permission denied')) {
            return "Sin permisos para esta operación. Intenta solo consultas SELECT.";
        }
        if (lower.includes('ambiguous')) {
            return "Columna ambigua. Especifica la tabla (ej: tabla.columna) en JOINs.";
        }
        
        return "Revisa tu consulta SQL y los nombres de tablas/columnas.";
    }

    /**
     * Generate a simple SQL query for common query patterns
     */
    generateSimpleSqlForQuery(query) {
        const lower = query.toLowerCase().trim();

        // COUNT queries (cuantos, how many)
        if (lower.match(/cuántos?|cuantos?\s+(usuarios?|users?)/)) {
            return 'SELECT COUNT(*) as total FROM usuarios';
        }
        if (lower.match(/cuántos?|cuantos?\s+(cursos?|courses?)/)) {
            return 'SELECT COUNT(*) as total FROM courses';
        }
        if (lower.match(/cuántos?|cuantos?\s+(videos?)/)) {
            return 'SELECT COUNT(*) as total FROM videos';
        }
        if (lower.match(/cuántos?|cuantos?\s+(tareas?|tasks?)/)) {
            return 'SELECT COUNT(*) as total FROM tasks';
        }
        if (lower.match(/cuántos?|cuantos?\s+(subscri|suscri)/)) {
            return 'SELECT COUNT(*) as total FROM subscriptions';
        }

        // LIST queries
        if (lower.includes('usuario') || lower.includes('user')) {
            return 'SELECT id, username as usuario, email FROM usuarios LIMIT 20';
        }
        if (lower.includes('curso') || lower.includes('course')) {
            return 'SELECT id, title, creator_user_id FROM courses LIMIT 20';
        }
        if (lower.includes('video')) {
            return 'SELECT id, title, course_id FROM videos LIMIT 20';
        }
        if (lower.includes('tarea') || lower.includes('task')) {
            return 'SELECT id, title, topic_id FROM tasks LIMIT 20';
        }

        return null;
    }

    /**
     * Generate smart fallback SQL based on query analysis
     * More intelligent than generateSimpleSqlForQuery - handles complex queries
     */
    generateSmartFallbackSQL(query) {
        const lower = query.toLowerCase().trim();
        
        // Premium courses query (price > 0)
        if ((lower.includes('premium') || lower.includes('pago') || lower.includes('precio')) && 
            (lower.includes('curso') || lower.includes('course'))) {
            
            // If asking for creators/users
            if (lower.includes('usuario') || lower.includes('username') || lower.includes('creador') || 
                lower.includes('nombre') || lower.includes('persona')) {
                return `SELECT c.id, c.title, c.price, u.username, u.first_name, u.last_name 
                        FROM courses c 
                        LEFT JOIN usuarios u ON c.creator_user_id = u.id 
                        WHERE c.price > 0 
                        ORDER BY c.price DESC 
                        LIMIT 50`;
            }
            
            // Just count
            if (lower.includes('cuanto') || lower.includes('cuánto')) {
                return `SELECT COUNT(*) as total FROM courses WHERE price > 0`;
            }
            
            // Default: list premium courses
            return `SELECT id, title, price, creator_user_id FROM courses WHERE price > 0 ORDER BY price DESC LIMIT 50`;
        }
        
        // Transactions/payments
        if (lower.includes('transac') || lower.includes('pago') || lower.includes('dinero') || 
            lower.includes('ingreso') || lower.includes('revenue')) {
            if (lower.includes('cuanto') || lower.includes('cuánto') || lower.includes('total')) {
                return `SELECT SUM(amount) as total_ingresos, COUNT(*) as num_transacciones 
                        FROM transactions 
                        WHERE status = 'APPROVED'`;
            }
            return `SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50`;
        }
        
        // Subscriptions
        if (lower.includes('subscri') || lower.includes('suscri')) {
            if (lower.includes('activ')) {
                return `SELECT s.*, u.username, c.title as course_title 
                        FROM subscriptions s 
                        LEFT JOIN usuarios u ON s.user_id = u.id 
                        LEFT JOIN courses c ON s.course_id = c.id 
                        WHERE s.status = 'active' 
                        LIMIT 50`;
            }
            return `SELECT * FROM subscriptions ORDER BY created_at DESC LIMIT 50`;
        }
        
        // Users with specific filters
        if (lower.includes('usuario') || lower.includes('user')) {
            if (lower.includes('activ')) {
                return `SELECT id, username, email, first_name, last_name, created_at 
                        FROM usuarios 
                        WHERE is_active = true 
                        ORDER BY created_at DESC 
                        LIMIT 50`;
            }
            if (lower.includes('creador') || lower.includes('creator')) {
                return `SELECT DISTINCT u.id, u.username, u.email, u.first_name, u.last_name 
                        FROM usuarios u 
                        INNER JOIN courses c ON c.creator_user_id = u.id 
                        LIMIT 50`;
            }
            return `SELECT id, username, email, first_name, last_name FROM usuarios LIMIT 50`;
        }
        
        // Courses with details
        if (lower.includes('curso') || lower.includes('course')) {
            return `SELECT c.id, c.title, c.price, c.is_premium, u.username as creator 
                    FROM courses c 
                    LEFT JOIN usuarios u ON c.creator_user_id = u.id 
                    ORDER BY c.created_at DESC 
                    LIMIT 50`;
        }
        
        // Videos
        if (lower.includes('video')) {
            return `SELECT v.id, v.title, c.title as course_title 
                    FROM videos v 
                    LEFT JOIN courses c ON v.course_id = c.id 
                    LIMIT 50`;
        }
        
        // Task submissions
        if (lower.includes('entrega') || lower.includes('submission') || lower.includes('tarea')) {
            return `SELECT ts.id, ts.grade, ts.feedback, u.username, t.title as task_title 
                    FROM task_submissions ts 
                    LEFT JOIN usuarios u ON ts.user_id = u.id 
                    LEFT JOIN tasks t ON ts.task_id = t.id 
                    ORDER BY ts.submitted_at DESC 
                    LIMIT 50`;
        }
        
        // Fall back to simple query generator
        return this.generateSimpleSqlForQuery(query);
    }

    /**
     * @deprecated No longer used - ALL queries now execute SQL
     * Detect if the query likely requires fetching data from the database.
     */
    detectIfQueryRequiresData(query) {
        // DEPRECATED: Now we ALWAYS execute SQL queries
        return true;
    }

    /**
     * @deprecated No longer used - ALL queries are processed as database queries
     * Check if a query is related to the database context.
     */
    isDatabaseRelatedQuery(query, schema) {
        // DEPRECATED: Now we ALWAYS treat queries as database-related
        return true;
    }

    /**
     * Extract SQL query from natural language
     * SIMPLIFIED: Only detects raw SQL. No regex-based intent detection.
     */
    async extractSQLFromQuery(query) {
        const lowerQuery = query.toLowerCase().trim();
        logger.info(`🔍 Analyzing query: "${lowerQuery}"`);

        // FIRST: Check if it's a direct SQL query (SELECT, INSERT, UPDATE, DELETE)
        if (lowerQuery.startsWith('select ') ||
            lowerQuery.startsWith('insert ') ||
            lowerQuery.startsWith('update ') ||
            lowerQuery.startsWith('delete ') ||
            lowerQuery.startsWith('with ')) {

            logger.info('✅ Matched: raw_sql');
            return { operation: 'raw_sql', sql: query };
        }

        logger.warn(`⚠️ No SQL pattern matched for query: "${lowerQuery}"`);
        return null;
    }

    /**
     * Execute query based on the query plan
     */
    async executeQuery(queryPlan) {
        try {
            const { table, operation, id, limit, sql } = queryPlan;

            if (operation === 'raw_sql') {
                // Execute raw SQL query directly
                try {
                    const result = await this.supabase.executeRawSQL(sql);
                    return {
                        data: result,
                        sql: sql
                    };
                } catch (error) {
                    logger.error('Raw SQL execution failed:', error);
                    throw error;
                }
            }

            throw new Error(`Unknown or unsupported operation: ${operation}`);
        } catch (error) {
            logger.error('Error executing query:', error);
            throw error;
        }
    }

    /**
     * Get database schema
     */
    async getDatabaseSchema() {
        try {
            const schema = await this.supabase.getDatabaseSchema();

            return {
                schema,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            logger.error('Error getting schema:', error);
            throw error;
        }
    }

    /**
     * Get database statistics
     */
    async getDatabaseStats() {
        try {
            const schema = await this.ragService.supabase.getDatabaseSchema();

            const stats = {
                totalTables: Object.keys(schema).length,
                tables: schema,
                totalRecords: Object.values(schema).reduce((sum, t) => sum + (t.count || 0), 0),
                timestamp: new Date().toISOString()
            };

            return stats;
        } catch (error) {
            logger.error('Error getting database stats:', error);
            throw error;
        }
    }

    /**
     * Get table data with pagination
     */
    async getTableData(tableName, page = 1, pageSize = 50) {
        try {
            const result = await this.ragService.supabase.getTableData(tableName, page, pageSize);

            return result;
        } catch (error) {
            logger.error(`Error getting ${tableName} data:`, error);
            throw error;
        }
    }

    /**
     * Search knowledge base
     */
    async searchKnowledge(query, topK = 5) {
        try {
            const results = await this.ragService.search(query, { topK });

            return {
                query,
                results,
                count: results.length,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            logger.error('Error searching knowledge:', error);
            throw error;
        }
    }

    /**
     * Add knowledge to base
     */
    async addKnowledge(content, metadata = {}) {
        try {
            const result = await this.ragService.addKnowledge(content, metadata);

            return result;
        } catch (error) {
            logger.error('Error adding knowledge:', error);
            throw error;
        }
    }

    /**
     * Analyze and grade a GitHub repository using LLM
     * @param {string} repoUrl - GitHub repository URL
     * @param {Object} options - Analysis options
     * @param {string} options.criteria - Evaluation criteria
     * @param {string[]} options.fileTypes - File extensions to analyze
     * @param {string} options.taskDescription - Task description for context
     * @returns {Promise<Object>} Analysis result with grade and feedback
     */
    async analyzeGitHubRepo(repoUrl, options = {}) {
        const {
            criteria = '',
            fileTypes = null,
            taskDescription = '',
            maxFiles = 20
        } = options;

        logger.info(`🔍 Starting GitHub repository analysis: ${repoUrl}`);

        try {
            // Step 1: Analyze repository and extract content
            const analysis = await this.githubService.analyzeRepository(repoUrl, {
                criteria: criteria || taskDescription,
                fileTypes: fileTypes || undefined, // Pass undefined to use default
                maxFiles
            });

            logger.info(`✅ Repository analyzed: ${analysis.files.length} files extracted`);

            // Step 2: Format content for LLM
            const formattedContent = this.githubService.formatForLLM(analysis);

            // Step 3: Build grading prompt
            const gradingPrompt = this.buildGitHubGradingPrompt(analysis, taskDescription, criteria);

            // Step 4: Send to LLM for analysis
            if (!this.llmService || !this.llmService.model) {
                logger.warn("⚠️ LLM Service not available");
                return {
                    success: false,
                    error: 'LLM Service not available',
                    repository: analysis.repository,
                    files: analysis.files.map(f => f.path)
                };
            }

            const messages = [
                new SystemMessage(gradingPrompt.system),
                new HumanMessage(gradingPrompt.user + '\n\n' + formattedContent)
            ];

            logger.info('📤 Sending to LLM for grading...');
            const response = await this.llmService.generateResponse(messages, []);
            const llmResponse = response.content || '';

            logger.info('✅ LLM grading complete');

            // Step 5: Parse LLM response
            const gradingResult = this.parseGitHubGradingResponse(llmResponse);

            return {
                success: true,
                repository: analysis.repository,
                statistics: analysis.statistics,
                filesAnalyzed: analysis.files.map(f => f.path),
                grade: gradingResult.grade,
                feedback: gradingResult.feedback,
                strengths: gradingResult.strengths,
                improvements: gradingResult.improvements,
                detailedAnalysis: gradingResult.detailedAnalysis,
                rawResponse: llmResponse
            };

        } catch (error) {
            logger.error(`❌ GitHub analysis failed: ${error.message}`);
            return {
                success: false,
                error: error.message,
                hint: this.getGitHubErrorHint(error.message)
            };
        }
    }

    /**
     * Build grading prompt for GitHub repository analysis
     */
    buildGitHubGradingPrompt(analysis, taskDescription, criteria) {
        const systemPrompt = `Eres un profesor experto en programación evaluando un proyecto de GitHub.

Tu tarea es analizar el código del repositorio y proporcionar:
1. **NOTA** (0-100): Calificación numérica justificada
2. **FORTALEZAS**: Lo que está bien hecho (mínimo 3 puntos)
3. **ÁREAS DE MEJORA**: Sugerencias constructivas (mínimo 3 puntos)
4. **FEEDBACK DETALLADO**: Análisis técnico completo

CRITERIOS DE EVALUACIÓN:
${criteria || `
- Estructura del proyecto (20%): Organización de carpetas, separación de concerns
- Calidad del código (25%): Legibilidad, naming conventions, modularidad
- Documentación (15%): README, comentarios, docstrings
- Buenas prácticas (20%): Git workflow, .gitignore, configuración
- Funcionalidad (20%): Completitud, manejo de errores, tests
`}

INFORMACIÓN DE LA TAREA:
${taskDescription || 'No se especificó descripción de la tarea. Evaluar según buenas prácticas generales.'}

FORMATO DE RESPUESTA OBLIGATORIO:

## 📊 CALIFICACIÓN

**NOTA FINAL: XX/100**

## ✅ FORTALEZAS
1. [Fortaleza 1]
2. [Fortaleza 2]
3. [Fortaleza 3]

## 📈 ÁREAS DE MEJORA
1. [Mejora 1]
2. [Mejora 2]
3. [Mejora 3]

## 📝 ANÁLISIS DETALLADO

[Análisis técnico del código, estructura, y decisiones de diseño]

## 🎯 RECOMENDACIONES

[Próximos pasos sugeridos para mejorar el proyecto]`;

        const userPrompt = `Analiza y califica el siguiente repositorio de GitHub:

**Repositorio:** ${analysis.repository.fullName}
**Lenguaje principal:** ${analysis.repository.language}
**Descripción:** ${analysis.repository.description}

A continuación se muestra el contenido del repositorio para análisis:`;

        return {
            system: systemPrompt,
            user: userPrompt
        };
    }

    /**
     * Parse LLM grading response
     */
    parseGitHubGradingResponse(response) {
        const result = {
            grade: null,
            feedback: response,
            strengths: [],
            improvements: [],
            detailedAnalysis: ''
        };

        // Extract grade (look for patterns like "NOTA: 85/100", "85/100", "Nota Final: 85")
        const gradePatterns = [
            /NOTA\s*(?:FINAL)?[:\s]*(\d{1,3})\s*(?:\/\s*100)?/i,
            /(\d{1,3})\s*\/\s*100/,
            /calificaci[oó]n[:\s]*(\d{1,3})/i,
            /puntuaci[oó]n[:\s]*(\d{1,3})/i
        ];

        for (const pattern of gradePatterns) {
            const match = response.match(pattern);
            if (match) {
                const grade = parseInt(match[1]);
                if (grade >= 0 && grade <= 100) {
                    result.grade = grade;
                    break;
                }
            }
        }

        // Extract strengths (look for numbered list after "FORTALEZAS" or "✅")
        const strengthsMatch = response.match(/(?:FORTALEZAS|✅[^]*?)\n((?:\d+\.[^\n]+\n?)+)/i);
        if (strengthsMatch) {
            result.strengths = strengthsMatch[1]
                .split('\n')
                .filter(line => /^\d+\./.test(line.trim()))
                .map(line => line.replace(/^\d+\.\s*/, '').trim())
                .filter(s => s.length > 0);
        }

        // Extract improvements
        const improvementsMatch = response.match(/(?:MEJORA|📈|SUGERENCIAS)[^]*?\n((?:\d+\.[^\n]+\n?)+)/i);
        if (improvementsMatch) {
            result.improvements = improvementsMatch[1]
                .split('\n')
                .filter(line => /^\d+\./.test(line.trim()))
                .map(line => line.replace(/^\d+\.\s*/, '').trim())
                .filter(s => s.length > 0);
        }

        // Extract detailed analysis
        const analysisMatch = response.match(/(?:ANÁLISIS DETALLADO|📝)[^]*?\n([\s\S]+?)(?=##|🎯|$)/i);
        if (analysisMatch) {
            result.detailedAnalysis = analysisMatch[1].trim();
        }

        return result;
    }

    /**
     * Get helpful error hint for GitHub errors
     */
    getGitHubErrorHint(errorMessage) {
        if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
            return 'El repositorio no existe o es privado. Verifica la URL y que el repositorio sea público.';
        }
        if (errorMessage.includes('403') || errorMessage.includes('rate limit')) {
            return 'Límite de peticiones a GitHub alcanzado. Configura un GITHUB_TOKEN en las variables de entorno.';
        }
        if (errorMessage.includes('Invalid GitHub URL')) {
            return 'URL de GitHub inválida. Usa el formato: https://github.com/usuario/repositorio';
        }
        return 'Error al acceder al repositorio. Verifica que la URL sea correcta y el repositorio sea público.';
    }

    /**
     * Build a narrative marketing summary from snapshot data
     * Enhanced to provide VS Code-style comprehensive analysis
     */
    buildMarketingSummary(snapshot) {
        const lines = [];

        lines.push('# 📊 Análisis Completo de Marketing e Inteligencia de Negocio - YisusCompany\n');
        lines.push(`**Fecha de análisis:** ${new Date(snapshot.generated_at).toLocaleString('es-ES')}`);
        lines.push(`**Pregunta original:** ${snapshot.query}`);
        lines.push(`**Fuente de datos:** Supabase (real-time)\n`);

        // Executive summary with business context
        lines.push('## 📋 Resumen Ejecutivo — Objetivo y Contexto\n');
        if (snapshot.summary && snapshot.summary.length > 0) {
            snapshot.summary.forEach(item => lines.push(`- ${item}`));
        } else {
            lines.push('- Análisis de datos del sistema YisusCompany para fundamentar estrategia de marketing');
            lines.push('- Objetivo: Identificar oportunidades de crecimiento, engagement y monetización');
        }
        lines.push('- **Resultado esperado:** Dashboard ejecutivo con KPIs clave y plan de acción accionable\n');

        // Key metrics section (quantitative)
        if (snapshot.metrics && Object.keys(snapshot.metrics).length > 0) {
            lines.push('## 🎯 Métricas Clave del Sistema\n');
            lines.push('### Población de Usuarios y Contenido');
            lines.push(`- **Usuarios totales:** ${snapshot.metrics.usuarios_total ?? 0}`);
            lines.push(`- **Cursos publicados:** ${snapshot.metrics.courses_total ?? 0}`);
            lines.push(`- **Videos disponibles:** ${snapshot.metrics.videos_total ?? 0}`);
            lines.push(`- **Suscripciones activas:** ${snapshot.metrics.subscriptions_total ?? 0}`);
            lines.push(`- **Tareas entregadas:** ${snapshot.metrics.task_submissions_total ?? 0}\n`);
        }

        // Insights section with actionable intelligence
        if (snapshot.insights && Object.keys(snapshot.insights).length > 0) {
            lines.push('## 💡 Insights de Negocio (Top Performers)\n');

            if (snapshot.insights.top_creators_by_courses && snapshot.insights.top_creators_by_courses.length > 0) {
                lines.push('### Top Creadores por Cursos');
                snapshot.insights.top_creators_by_courses.slice(0, 5).forEach((creator, idx) => {
                    lines.push(`${idx + 1}. **${creator.creator_username}** — ${creator.courses_count} cursos`);
                });
                lines.push('');
            }

            if (snapshot.insights.top_creators_by_videos && snapshot.insights.top_creators_by_videos.length > 0) {
                lines.push('### Top Creadores por Videos');
                snapshot.insights.top_creators_by_videos.slice(0, 5).forEach((creator, idx) => {
                    lines.push(`${idx + 1}. **${creator.username}** — ${creator.videos_count} videos`);
                });
                lines.push('');
            }

            if (snapshot.insights.subscribers_activity && snapshot.insights.subscribers_activity.length > 0) {
                lines.push('### Suscriptores Más Activos');
                snapshot.insights.subscribers_activity.slice(0, 5).forEach((sub, idx) => {
                    lines.push(`${idx + 1}. **${sub.subscriber_username}** — ${sub.subscriptions_count} suscripciones`);
                });
                lines.push('');
            }
        }

        // Critical decisions and priorities
        lines.push('## 🚨 Decisiones Críticas a Tomar Ahora\n');
        lines.push('### 1. Segmentación y Personalización');
        lines.push('   - Crear segmentos: power users, activos, inactivos, nuevos');
        lines.push('   - Configurar campañas personalizadas por segmento');
        lines.push('   - **Owner:** Marketing Lead | **Timeline:** Semana 1-2\n');
        lines.push('### 2. Monetización y Pricing');
        lines.push('   - Validar modelo actual (suscripciones vs. pago por curso)');
        lines.push('   - Implementar A/B testing en precios para 2 cohortes');
        lines.push('   - **Owner:** Product/Growth | **Timeline:** Semana 2-3\n');
        lines.push('### 3. Retención y Engagement');
        lines.push('   - Mejorar onboarding (primer video, primer task)');
        lines.push('   - Implementar notificaciones y email nurturing');
        lines.push('   - **Owner:** Product + CS | **Timeline:** Semana 3-4\n');
        lines.push('### 4. Content Strategy');
        lines.push('   - Promover top cursos/videos (los que generan más engagement)');
        lines.push('   - Incentivar a top creadores con programa de afiliados');
        lines.push('   - **Owner:** Content Team | **Timeline:** Ongoing\n');
        lines.push('### 5. Data Infrastructure y BI');
        lines.push('   - Construir dashboard ejecutivo (MRR, DAU/MAU, churn, conversión)');
        lines.push('   - Automatizar ETL diario para KPIs críticos');
        lines.push('   - **Owner:** Data/Engineering | **Timeline:** Mes 1\n');

        // Recommended actions (tactical)
        if (snapshot.recommended_actions && snapshot.recommended_actions.length > 0) {
            lines.push('## ✅ Acciones Recomendadas (Tácticas Concretas)\n');
            snapshot.recommended_actions.forEach((action, idx) => {
                lines.push(`${idx + 1}. ${action}`);
            });
            lines.push('');
        }

        // KPIs prioritized (what to measure)
        lines.push('## 📈 KPIs Priorizados (Top 6)\n');
        lines.push('1. **MRR (Monthly Recurring Revenue)**: Ingresos recurrentes mensuales de suscripciones');
        lines.push('   - Fórmula: SUM(subscriptions.price WHERE status=active)');
        lines.push('   - Target: Crecimiento 15-20% mes a mes\n');
        lines.push('2. **DAU/MAU Ratio**: Engagement de usuarios activos');
        lines.push('   - Fórmula: COUNT(DISTINCT usuarios activos hoy) / COUNT(DISTINCT usuarios activos este mes)');
        lines.push('   - Target: >20% (indica alta retención)\n');
        lines.push('3. **Conversion Rate (Free → Pay)**: Tasa de conversión a pago');
        lines.push('   - Fórmula: COUNT(nuevos suscriptores) / COUNT(nuevos usuarios registrados) * 100');
        lines.push('   - Target: >5% en primeros 30 días\n');
        lines.push('4. **Churn Rate**: Tasa de cancelación mensual');
        lines.push('   - Fórmula: COUNT(suscripciones canceladas este mes) / COUNT(suscripciones activas inicio mes) * 100');
        lines.push('   - Target: <5% mensual\n');
        lines.push('5. **ARPU (Average Revenue Per User)**: Ingreso promedio por usuario');
        lines.push('   - Fórmula: Total revenue / Total active users');
        lines.push('   - Benchmark: Varía por mercado (curso online ~$15-50/mes)\n');
        lines.push('6. **Content Engagement Rate**: Engagement con contenido');
        lines.push('   - Fórmula: (Video views + Task submissions) / Total usuarios activos');
        lines.push('   - Target: >3 interacciones por usuario/semana\n');

        // BI Architecture suggestion
        lines.push('## 🏗️ Arquitectura BI Sugerida (MVP — 4 semanas)\n');
        lines.push('### Ingest');
        lines.push('- **Source:** Supabase (Postgres) con Change Data Capture (CDC)');
        lines.push('- **Events:** Instrumentar login, video_play, course_enroll, purchase, subscription_cancel\n');
        lines.push('### Storage/Transformation');
        lines.push('- **Raw Layer:** Tablas originales en Supabase');
        lines.push('- **Analytics Layer:** Vistas materializadas o tablas agregadas:');
        lines.push('  - `daily_users_agg` (DAU, MAU, new users)');
        lines.push('  - `monthly_revenue_agg` (MRR, ARPU, churn)');
        lines.push('  - `content_performance_agg` (views, completions, ratings por curso/video)');
        lines.push('  - `cohort_retention_agg` (retención 1/7/30/90 días)\n');
        lines.push('### Orchestration');
        lines.push('- **Tool:** Cron jobs (simple) o Airflow (escalable)');
        lines.push('- **Schedule:** Refresh diario a las 2 AM para KPIs críticos\n');
        lines.push('### Visualization');
        lines.push('- **Tool:** Metabase (open-source, fácil) o Looker/PowerBI (enterprise)');
        lines.push('- **Dashboards:**');
        lines.push('  - Executive Dashboard (MRR, nuevos suscriptores, churn, ARPU)');
        lines.push('  - Growth Dashboard (CAC, conversion funnel, cohort retention)');
        lines.push('  - Content Performance (top cursos/videos, engagement)\n');
        lines.push('### Access');
        lines.push('- **Users:** Exec team (solo lectura), Growth/Marketing (interactivo)');
        lines.push('- **API:** REST endpoints para integrar KPIs en producto\n');

        // SQL queries (actionable)
        lines.push('## 💻 Ejemplos de SQL para Ejecutar Ahora\n');
        lines.push('```sql');
        lines.push('-- 1. Ingresos por mes (últimos 12 meses)');
        lines.push('SELECT date_trunc(\'month\', created_at) AS mes,');
        lines.push('       SUM(price) AS ingresos,');
        lines.push('       COUNT(*) AS num_subscriptions');
        lines.push('FROM subscriptions');
        lines.push('WHERE status IN (\'active\', \'paid\')');
        lines.push('GROUP BY 1 ORDER BY 1 DESC LIMIT 12;');
        lines.push('');
        lines.push('-- 2. Top 10 cursos por número de videos');
        lines.push('SELECT c.id, c.title, c.creator_username,');
        lines.push('       COUNT(v.id) AS num_videos');
        lines.push('FROM courses c');
        lines.push('LEFT JOIN videos v ON v.course_id = c.id');
        lines.push('GROUP BY c.id, c.title, c.creator_username');
        lines.push('ORDER BY num_videos DESC LIMIT 10;');
        lines.push('');
        lines.push('-- 3. Usuarios sin actividad reciente (inactivos >30 días)');
        lines.push('SELECT u.id, u.usuario, u.created_at,');
        lines.push('       MAX(COALESCE(cm.created_at, ts.submitted_at)) AS last_activity');
        lines.push('FROM usuarios u');
        lines.push('LEFT JOIN chat_messages cm ON cm.user_id = u.id');
        lines.push('LEFT JOIN task_submissions ts ON ts.user_id = u.id');
        lines.push('GROUP BY u.id, u.usuario, u.created_at');
        lines.push('HAVING MAX(COALESCE(cm.created_at, ts.submitted_at)) < NOW() - INTERVAL \'30 days\'');
        lines.push('   OR MAX(COALESCE(cm.created_at, ts.submitted_at)) IS NULL;');
        lines.push('');
        lines.push('-- 4. Cohort retention simple (mes de registro vs. mes de actividad)');
        lines.push('WITH cohorts AS (');
        lines.push('  SELECT id, date_trunc(\'month\', created_at) AS cohort_month');
        lines.push('  FROM usuarios');
        lines.push(')');
        lines.push('SELECT cohort_month,');
        lines.push('       date_trunc(\'month\', cm.created_at) AS activity_month,');
        lines.push('       COUNT(DISTINCT u.id) AS active_users');
        lines.push('FROM usuarios u');
        lines.push('JOIN cohorts c ON u.id = c.id');
        lines.push('LEFT JOIN chat_messages cm ON cm.user_id = u.id');
        lines.push('GROUP BY cohort_month, activity_month');
        lines.push('ORDER BY cohort_month, activity_month;');
        lines.push('');
        lines.push('-- 5. Engagement rate (interacciones por usuario)');
        lines.push('SELECT u.id, u.usuario,');
        lines.push('       COUNT(DISTINCT cm.id) AS num_messages,');
        lines.push('       COUNT(DISTINCT ts.id) AS num_task_submissions,');
        lines.push('       COUNT(DISTINCT cm.id) + COUNT(DISTINCT ts.id) AS total_interactions');
        lines.push('FROM usuarios u');
        lines.push('LEFT JOIN chat_messages cm ON cm.user_id = u.id');
        lines.push('LEFT JOIN task_submissions ts ON ts.user_id = u.id');
        lines.push('GROUP BY u.id, u.usuario');
        lines.push('ORDER BY total_interactions DESC LIMIT 20;');
        lines.push('```\n');

        // Marketing strategies
        lines.push('## 🚀 Estrategias de Marketing Sugeridas (90 días)\n');
        lines.push('### Semana 1-2: Fundación y Segmentación');
        lines.push('- [ ] Auditar datos actuales y confirmar calidad (verificar contraseñas hasheadas, etc.)');
        lines.push('- [ ] Crear segmentos de usuarios: power users, activos, inactivos, nuevos');
        lines.push('- [ ] Definir KPIs críticos y configurar tracking de eventos\n');
        lines.push('### Semana 3-4: Activación y Re-engagement');
        lines.push('- [ ] Lanzar campaña de re-engagement por email para usuarios inactivos (>30 días)');
        lines.push('- [ ] Implementar onboarding mejorado (primer video guiado, primer task con recompensa)');
        lines.push('- [ ] A/B test en copy de landing page para mejorar conversión free→trial\n');
        lines.push('### Mes 2: Monetización y Growth');
        lines.push('- [ ] A/B test de pricing en 2 cohortes (ej. $9.99 vs. $14.99/mes)');
        lines.push('- [ ] Lanzar programa de afiliados para top creadores (comisión por referidos)');
        lines.push('- [ ] Crear bundles de cursos populares con descuento para aumentar ticket promedio\n');
        lines.push('### Mes 3: Optimización y Scale');
        lines.push('- [ ] Automatizar ETL y dashboards de KPIs críticos (refresh diario)');
        lines.push('- [ ] Analizar cohort retention y ajustar estrategias por cohorte');
        lines.push('- [ ] Lanzar campañas de paid acquisition en canales con mejor LTV/CAC\n');

        // Risks and mitigations
        lines.push('## ⚠️ Riesgos y Mitigaciones\n');
        lines.push('### Riesgo 1: Datos incompletos o de mala calidad');
        lines.push('- **Mitigación:** Auditar datos ahora, configurar validaciones y tests de calidad\n');
        lines.push('### Riesgo 2: Baja población de usuarios (dataset pequeño)');
        lines.push('- **Mitigación:** Si es entorno de prueba, poblar con datos sintéticos realistas para validar dashboards\n');
        lines.push('### Riesgo 3: Falta de eventos de actividad (login, video_play, etc.)');
        lines.push('- **Mitigación:** Instrumentar eventos clave en la app lo antes posible\n');
        lines.push('### Riesgo 4: Churn alto o conversión baja');
        lines.push('- **Mitigación:** Implementar análisis de cohortes, encuestas de salida, mejorar producto\n');

        // Immediate action
        lines.push('## 🎯 Acción Inmediata Sugerida\n');
        lines.push('**Ejecutar las 5 consultas SQL de arriba** para:');
        lines.push('1. Validar si hay datos suficientes de ingresos, actividad, cohorts');
        lines.push('2. Identificar vacíos críticos (ej. tabla de payments faltante)');
        lines.push('3. Confirmar top creadores/cursos y usuarios power\n');
        lines.push('Una vez confirmados los datos, **crear un dashboard MVP en Metabase** con:');
        lines.push('- MRR actual y tendencia (últimos 6 meses)');
        lines.push('- DAU/MAU ratio');
        lines.push('- Top 10 cursos por engagement');
        lines.push('- Cohort retention (simple)\n');
        lines.push('---\n');
        lines.push('💬 **¿Necesitas más detalles?** Pregunta:');
        lines.push('- "Ejecuta las consultas SQL sugeridas y muéstrame los resultados"');
        lines.push('- "Dame el plan detallado de implementación del dashboard BI"');
        lines.push('- "¿Cómo configuro el tracking de eventos en mi app?"');

        return lines.join('\n');
    }

    // ============================================================
    // 🔄 ERROR FEEDBACK SYSTEM - Self-correcting SQL generation
    // ============================================================

    /**
     * Classify SQL error type for better feedback
     * @param {string} errorMessage - The error message from SQL execution
     * @returns {string} - Error classification
     */
    classifyError(errorMessage) {
        const lower = errorMessage.toLowerCase();
        
        // Timeout errors
        if (lower.includes('timeout') || lower.includes('statement timeout') || lower.includes('canceling statement')) {
            return 'TIMEOUT';
        }
        
        // UNION/INTERSECT/EXCEPT errors
        if (lower.includes('union') || lower.includes('intersect') || lower.includes('except')) {
            return 'UNION_ERROR';
        }
        
        // Column not found
        if (lower.includes('column') && (lower.includes('not exist') || lower.includes('does not exist') || lower.includes('unknown'))) {
            return 'COLUMN_NOT_FOUND';
        }
        
        // Table not found
        if (lower.includes('relation') && (lower.includes('not exist') || lower.includes('does not exist'))) {
            return 'TABLE_NOT_FOUND';
        }
        
        // Syntax error
        if (lower.includes('syntax error') || lower.includes('parse error')) {
            return 'SYNTAX_ERROR';
        }
        
        // Ambiguous column
        if (lower.includes('ambiguous')) {
            return 'AMBIGUOUS_COLUMN';
        }
        
        // Permission/access error
        if (lower.includes('permission') || lower.includes('denied') || lower.includes('access')) {
            return 'PERMISSION_ERROR';
        }
        
        // GROUP BY errors
        if (lower.includes('group by') || lower.includes('aggregate')) {
            return 'GROUP_BY_ERROR';
        }
        
        // ORDER BY errors
        if (lower.includes('order by')) {
            return 'ORDER_BY_ERROR';
        }
        
        // JOIN errors
        if (lower.includes('join') || lower.includes('foreign key')) {
            return 'JOIN_ERROR';
        }
        
        return 'UNKNOWN';
    }

    /**
     * Build comprehensive error feedback for LLM retry
     * @param {string} lastError - The last error message
     * @param {string} lastSQL - The SQL that caused the error
     * @param {Array} errorHistory - History of all errors
     * @returns {Object} - Feedback object with analysis, suggestion, and rules
     */
    buildErrorFeedback(lastError, lastSQL, errorHistory) {
        const errorType = this.classifyError(lastError);
        
        const feedback = {
            analysis: '',
            suggestion: '',
            rules: []
        };
        
        switch (errorType) {
            case 'TIMEOUT':
                feedback.analysis = `La consulta tardó demasiado tiempo en ejecutarse. Esto generalmente ocurre con:
                - Queries con muchos JOINs sin índices
                - Queries que escanean tablas muy grandes sin LIMIT
                - Queries con subconsultas complejas anidadas
                - UNION/INTERSECT sin optimización`;
                feedback.suggestion = `SIMPLIFICA la query:
                1. Agrega LIMIT (máximo 50 filas)
                2. Evita múltiples JOINs - haz queries separadas si es necesario
                3. Evita UNION - usa una sola tabla con WHERE
                4. No uses subconsultas - usa JOINs simples`;
                feedback.rules = [
                    'SIEMPRE agrega LIMIT 1000 al final',
                    'NO uses UNION, INTERSECT o EXCEPT - simplifica la lógica',
                    'Máximo 1 JOIN por query',
                    'NO uses subconsultas (SELECT dentro de SELECT)',
                    'Usa filtros WHERE específicos para reducir datos'
                ];
                break;
                
            case 'UNION_ERROR':
                feedback.analysis = `Error con UNION/INTERSECT/EXCEPT. Problemas comunes:
                - ORDER BY solo puede ir al final de todo el UNION, no en las subqueries
                - Todas las subqueries deben tener el mismo número de columnas
                - Los tipos de datos deben coincidir entre las subqueries`;
                feedback.suggestion = `EVITA UNION completamente. Alternativas:
                1. Usa una sola query con CASE WHEN
                2. Haz queries separadas
                3. Si necesitas ORDER BY, ponlo solo al final después del último UNION`;
                feedback.rules = [
                    'NO uses UNION/INTERSECT/EXCEPT - busca alternativas más simples',
                    'Si absolutamente necesitas UNION, el ORDER BY va SOLO al final',
                    'Ejemplo correcto: (SELECT ...) UNION (SELECT ...) ORDER BY col',
                    'Mejor: usa una sola tabla con WHERE y CASE WHEN'
                ];
                break;
                
            case 'COLUMN_NOT_FOUND':
                feedback.analysis = `La columna referenciada no existe en la tabla. Verifica:
                - El nombre exacto de la columna en el schema
                - Que estés usando el alias correcto de la tabla
                - Que la columna pertenece a la tabla que estás consultando`;
                feedback.suggestion = `Revisa el schema y usa los nombres EXACTOS de las columnas. 
                Nota: username en usuarios, title en courses, etc.`;
                feedback.rules = [
                    'Verifica el nombre exacto de la columna en el schema proporcionado',
                    'Si usas alias (ej: FROM usuarios u), usa u.columna',
                    'NO inventes columnas - usa solo las del schema'
                ];
                break;
                
            case 'TABLE_NOT_FOUND':
                feedback.analysis = `La tabla referenciada no existe. Tablas disponibles:
                usuarios, courses, videos, tasks, task_submissions, subscriptions, notifications, chat_messages, topics, content_items`;
                feedback.suggestion = `Usa solo tablas del schema. Tablas principales:
                - usuarios (NO users)
                - courses (NO cursos)
                - task_submissions (NO submissions)`;
                feedback.rules = [
                    'Usa SOLO tablas que existen en el schema',
                    'Tabla de usuarios es "usuarios" (NO "users")',
                    'Tabla de cursos es "courses" (NO "cursos")'
                ];
                break;
                
            case 'AMBIGUOUS_COLUMN':
                feedback.analysis = `Una columna se usa sin especificar de qué tabla proviene cuando hay múltiples tablas con esa columna.`;
                feedback.suggestion = `SIEMPRE usa prefijos de tabla: tabla.columna o alias.columna`;
                feedback.rules = [
                    'SIEMPRE usa alias de tabla (FROM usuarios u)',
                    'SIEMPRE referencia columnas con el alias (u.id, NOT id)',
                    'Cada columna debe tener prefijo de tabla'
                ];
                break;
                
            case 'GROUP_BY_ERROR':
                feedback.analysis = `Error con GROUP BY. Reglas de PostgreSQL:
                - Todas las columnas en SELECT que no son agregadas deben estar en GROUP BY
                - No puedes usar alias del SELECT en GROUP BY`;
                feedback.suggestion = `Incluye TODAS las columnas no-agregadas en GROUP BY`;
                feedback.rules = [
                    'Cada columna en SELECT que NO es COUNT/SUM/AVG debe estar en GROUP BY',
                    'Usa números en GROUP BY: GROUP BY 1, 2 (refiere a posiciones del SELECT)',
                    'No uses alias del SELECT en GROUP BY'
                ];
                break;
                
            case 'ORDER_BY_ERROR':
                feedback.analysis = `Error con ORDER BY. Problemas comunes:
                - En UNION, ORDER BY solo va al final
                - La columna debe existir en el SELECT o ser válida`;
                feedback.suggestion = `Verifica que ORDER BY usa columnas válidas`;
                feedback.rules = [
                    'ORDER BY debe usar columnas del SELECT o alias válidos',
                    'En UNION: ORDER BY va SOLO al final, después de todas las subqueries',
                    'Puedes usar números: ORDER BY 1 DESC'
                ];
                break;
                
            case 'SYNTAX_ERROR':
                feedback.analysis = `Error de sintaxis SQL. Revisa:
                - Comas entre columnas
                - Paréntesis balanceados
                - Palabras clave correctas`;
                feedback.suggestion = `Simplifica la query y verifica la sintaxis básica`;
                feedback.rules = [
                    'Verifica que hay comas entre columnas en SELECT',
                    'Verifica paréntesis balanceados',
                    'Verifica que no hay errores de tipeo en palabras clave'
                ];
                break;
                
            default:
                feedback.analysis = `Error no clasificado: ${lastError}`;
                feedback.suggestion = `Simplifica la query al máximo y usa solo las estructuras más básicas`;
                feedback.rules = [
                    'Usa queries simples: SELECT col1, col2 FROM tabla LIMIT 20',
                    'Evita JOINs, UNIONs y subconsultas',
                    'Verifica nombres de tablas y columnas en el schema'
                ];
        }
        
        // Add history context if there are multiple errors
        if (errorHistory.length > 1) {
            const previousErrors = errorHistory.slice(0, -1).map(e => 
                `- Intento ${e.attempt}: ${e.errorType} - ${e.error.substring(0, 100)}`
            ).join('\n');
            feedback.analysis += `\n\n**Errores anteriores en esta sesión:**\n${previousErrors}`;
            feedback.rules.push('NO repitas los mismos errores - genera una query DIFERENTE');
        }
        
        return feedback;
    }

    /**
     * Generate a comprehensive error report when all retries fail
     * @param {Array} errorHistory - History of all errors
     * @param {string} originalQuery - The original user query
     * @returns {string} - Formatted error report
     */
    generateErrorReport(errorHistory, originalQuery) {
        const lines = [];
        
        lines.push(`## ❌ No se pudo ejecutar la consulta después de ${errorHistory.length} intentos\n`);
        lines.push(`**Tu pregunta:** "${originalQuery}"\n`);
        
        lines.push('### 📋 Historial de errores:\n');
        
        for (const entry of errorHistory) {
            lines.push(`#### Intento ${entry.attempt}:`);
            lines.push('```sql');
            lines.push(entry.sql || 'N/A');
            lines.push('```');
            lines.push(`**Error (${entry.errorType}):** ${entry.error}\n`);
        }
        
        // Analyze patterns
        const errorTypes = errorHistory.map(e => e.errorType);
        const hasTimeout = errorTypes.includes('TIMEOUT');
        const hasUnion = errorTypes.includes('UNION_ERROR');
        
        lines.push('### 💡 Sugerencias:\n');
        
        if (hasTimeout) {
            lines.push('- **Timeout detectado:** Tu consulta es muy compleja. Intenta preguntar algo más específico.');
            lines.push('  - En lugar de "dame todos los mensajes", prueba "dame los últimos 10 mensajes"');
        }
        
        if (hasUnion) {
            lines.push('- **Error de UNION:** La consulta intentó combinar datos de múltiples fuentes.');
            lines.push('  - Intenta preguntar por una sola tabla a la vez');
        }
        
        lines.push('\n### 🔄 Alternativas:\n');
        lines.push('1. **Reformula tu pregunta** de manera más específica');
        lines.push('2. **Pregunta por una tabla a la vez** (ej: "¿cuántos usuarios hay?")');
        lines.push('3. **Usa límites explícitos** (ej: "dame los últimos 10 cursos")');
        lines.push('4. **Pregunta consultas simples** como conteos o listas cortas.\n');
        
        lines.push('### 📊 Consultas que funcionan bien:\n');
        lines.push('- "¿Cuántos usuarios hay?"');
        lines.push('- "Dame los últimos 10 cursos"');
        lines.push('- "Lista los usuarios registrados"');
        lines.push('- "¿Cuántas tareas hay?"');
        
        return lines.join('\n');
    }
}