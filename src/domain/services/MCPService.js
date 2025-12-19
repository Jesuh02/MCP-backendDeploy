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
     */
    async getReinforcementHistory(userId, courseId) {
        if (!userId || !courseId) return [];
        
        console.log(`📚 MCPService: Fetching reinforcement history for user ${userId}, course ${courseId}`);
        
        try {
            const { data: existingRows, error } = await this.supabase.client
                .from('reinforcement_question_history')
                .select('questions')
                .eq('user_id', userId)
                .eq('course_id', courseId);
            
            if (error) throw error;

            let history = [];
            if (existingRows && Array.isArray(existingRows)) {
                existingRows.forEach(row => {
                    if (row.questions && Array.isArray(row.questions)) {
                        history = history.concat(row.questions);
                    }
                });
            }
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
     * Save new reinforcement learning questions to history
     * Uses INSERT to support log-based schema (multiple rows per user/course)
     */
    async saveReinforcementHistory(userId, courseId, questions) {
        if (!userId || !courseId || !questions || !questions.length) return false;

        try {
            const { error } = await this.supabase.client
                .from('reinforcement_question_history')
                .insert({
                    user_id: userId,
                    course_id: courseId,
                    questions: questions,
                    created_at: new Date().toISOString()
                });
            
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
                    includeSchema = false
            } = options;

            logger.info(`Processing query: ${query.substring(0, 100)}...`);
            logger.info(`Full query length: ${query.length} characters`);
            logger.info(`Complete query: "${query}"`);

            const queryPlan = await this.extractSQLFromQuery(query);
            logger.info('Query plan generated:', JSON.stringify(queryPlan));

            let data = null;
            let sqlScript = null;
            let schemaDetails = null;

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

            if (includeSchema) {
                try {
                    schemaDetails = await this.getDatabaseSchema();
                    logger.info('Schema snapshot attached to response');
                } catch (schemaError) {
                    logger.error('Error fetching schema for response:', schemaError);
                }
            }

            return {
                data,
                sqlScript,
                schema: schemaDetails
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
     * Process a query using the Agent (LLM)
     * @param {string} query Natural language query
     * @returns {Promise<any>} Agent response
     * DEPRECATED: Use the main processQueryWithAgent below with tool calling
     */

    /**
     * Process a query using an LLM Agent that can call tools.
     */
    async processQueryWithAgent(query) {
            logger.info(`🤖 Processing query with Agent: "${query}"`);

            if (!this.llmService || !this.llmService.model) {
                logger.warn("⚠️ LLM Service not available. Returning fallback message.");
                return "Lo siento, el servicio de IA no está disponible en este momento (Falta configuración de API Key). Por favor, intenta consultas SQL directas o verifica la configuración del servidor.";
            }

            try {
                // Check if query requires data
                const requiresData = this.detectIfQueryRequiresData(query);

                if (!requiresData) {
                    // Simple conversational query - no SQL needed
                    const messages = [
                        new SystemMessage(`You are a helpful assistant for TareaMov platform. Answer in Spanish.`),
                        new HumanMessage(query)
                    ];
                    const response = await this.llmService.generateResponse(messages, []);
                    return response.content || "Lo siento, no pude generar una respuesta.";
                }

                // STEP 1: Get fresh schema FIRST
                logger.info("📋 Step 1: Fetching database schema...");
                const freshSchema = await this.getDatabaseSchema();
                const schemaText = JSON.stringify(freshSchema.schema, null, 2);
                logger.info("✅ Schema fetched");

                // STEP 2: Generate SQL (with retry logic for errors)
                const maxRetries = 3; // Increased from 2 to 3 for better error recovery
                let attempt = 0;
                let lastError = null;
                let lastSQL = null; // Track the SQL that failed
                let errorHistory = []; // Track all errors for comprehensive feedback
                let result = null;
                let finalSQL = null;

                while (attempt < maxRetries) {
                    attempt++;
                    logger.info(`🔄 Attempt ${attempt}/${maxRetries} to generate and execute SQL`);

                    // Build prompt based on whether this is a retry
                    let sqlGenMessages;
                    if (attempt === 1) {
                        // First attempt - clean prompt
                        sqlGenMessages = [
                            new SystemMessage(`Generate PostgreSQL query using this schema:

${schemaText}

RULES:
- Use ONLY columns from schema above
- ALWAYS use table aliases (e.g., FROM usuarios u)
- If using alias, reference it in SELECT (e.g., u.username NOT t.username)
- For JOINs, verify foreign keys exist
- For LIST queries (dame usuarios, lista de cursos, etc.), select ALL relevant columns

Output ONLY SQL in code block:
\`\`\`sql
SELECT ...
\`\`\``),
                            new HumanMessage(`SQL for: ${query}`)
                        ];
                    } else {
                        // Retry - include comprehensive error feedback
                        const errorFeedback = this.buildErrorFeedback(lastError, lastSQL, errorHistory);
                        sqlGenMessages = [
                            new SystemMessage(`🚨 **SQL CORRECTION REQUIRED** 🚨

**FAILED SQL:**
\`\`\`sql
${lastSQL || 'N/A'}
\`\`\`

**ERROR MESSAGE:**
${lastError}

**ERROR ANALYSIS:**
${errorFeedback.analysis}

**SUGGESTED FIX:**
${errorFeedback.suggestion}

**Database Schema (verified):**
${schemaText}

**CRITICAL RULES FOR CORRECTION:**
1. ${errorFeedback.rules.join('\n2. ')}

**IMPORTANT:** Generate a SIMPLER, more direct SQL query. Avoid complex JOINs, UNIONs, or subqueries unless absolutely necessary.

Generate CORRECTED SQL (must be different from previous attempt):
\`\`\`sql
SELECT ...
\`\`\``),
                            new HumanMessage(`CORRIGE el SQL para esta consulta: ${query}\n\nIntento ${attempt} de ${maxRetries}. El SQL anterior falló, genera una versión DIFERENTE y más SIMPLE.`)
                        ];
                    }

                    // Generate SQL
                    logger.info(`📊 Requesting SQL from LLM...`);
                    const sqlResponse = await this.llmService.generateResponse(sqlGenMessages, []);
                    const sqlText = sqlResponse.content || "";

                    // Parse SQL from response
                    let sqlMatch = sqlText.match(/```sql\s*\n([\s\S]+?)\n```/) ||
                        sqlText.match(/(SELECT[\s\S]+?(?:;|\n\n|$))/i);

                    if (!sqlMatch) {
                        logger.error("❌ Could not extract SQL from LLM response");
                        if (attempt === maxRetries) {
                            return `No pude generar SQL válido para tu consulta. Intenta reformular la pregunta.\n\nRespuesta del LLM:\n${sqlText}`;
                        }
                        lastError = "No SQL code block found in response";
                        continue;
                    }

                    finalSQL = sqlMatch[1].trim().replace(/;$/, '');
                    logger.info(`✅ SQL extracted (attempt ${attempt})`);
                    
                    // Log INPUT: the query being sent
                    logger.info('📥 SQL INPUT:', JSON.stringify({ query: finalSQL }, null, 2));

                    // Execute SQL
                    try {
                        result = await this.supabase.executeRawSQL(finalSQL);
                        
                        // Log OUTPUT: query + results
                        const outputLog = {
                            query: finalSQL,
                            results: result,
                            rowCount: result?.length || 0
                        };
                        logger.info('📤 SQL OUTPUT:', JSON.stringify(outputLog, null, 2));
                        logger.info(`✅ SQL executed successfully! Returned ${result?.length || 0} rows`);
                        break; // Success - exit retry loop
                    } catch (sqlError) {
                        logger.error(`❌ SQL execution failed (attempt ${attempt}):`, sqlError.message);
                        
                        // Store error details for comprehensive feedback
                        lastError = sqlError.message;
                        lastSQL = finalSQL;
                        errorHistory.push({
                            attempt,
                            sql: finalSQL,
                            error: sqlError.message,
                            errorType: this.classifyError(sqlError.message)
                        });

                        if (attempt === maxRetries) {
                            // Final attempt failed - return detailed error report
                            const errorReport = this.generateErrorReport(errorHistory, query);
                            return errorReport;
                        }

                        // Continue to retry with feedback
                        logger.warn(`🔄 Will retry with error feedback (attempt ${attempt + 1}/${maxRetries})...`);
                        logger.info(`📝 Error history: ${errorHistory.length} errors tracked for feedback`);
                    }
                }

                // If we have results, ask LLM to analyze them
                if (result !== null) {
                    logger.info("📈 Step 3: Requesting analysis from LLM...");

                    // Detect if this is a LIST query (usuarios, cursos, tareas, etc.)
                    const isListQuery = /dame|lista|listar|muestra|mostrar|todos|todas/i.test(query) &&
                        /usuarios?|cursos?|tareas?|videos?|subscri|estudiantes?/i.test(query);

                    const analysisMessages = [
                            new SystemMessage(`Analyze SQL results in Spanish. Be conversational and insightful.

GUIDELINES:
1. Start with summary (e.g., "Encontré X resultados...")
2. ${isListQuery ? '**PRESENT DATA AS AESTHETIC TABLE**' : 'Explain key findings'}
3. Provide context and insights
4. Add recommendations if relevant
5. NEVER return raw JSON

${isListQuery ? `**FORMATO DE TABLA ESTÉTICA (OBLIGATORIO):**
Presenta los datos en una tabla con el siguiente estilo EXACTO:

| **Columna 1** | **Columna 2** | **Columna 3** | **Columna 4** |
| :--- | :--- | :--- | :--- |
| valor1 | valor2 | valor3 | valor4 |

REGLAS DE FORMATO:
1. Headers en **negrita** entre asteriscos dobles
2. Usar nombres de columna DESCRIPTIVOS en español (ej: "Nombre Usuario" en lugar de "usuario")
3. Alineación a la izquierda con :---
4. Sin espacios extra dentro de las celdas
5. Incluir TODAS las columnas relevantes de los datos
6. Máximo 20 filas, si hay más indicar "... y X más"

EJEMPLO PARA USUARIOS:
| **ID** | **Nombre Usuario** | **Email** | **Rol** |
| :--- | :--- | :--- | :--- |
| 1 | admin | admin@example.com | Administrador |
| 2 | prueba | test@test.com | Usuario |

Después de la tabla, añade un breve análisis.
` : `**ANALYSIS EXAMPLE:**
"Encontré 11 usuarios registrados. De estos, 9 (82%) usan emails temporales, indicando cuentas de prueba. Solo 2 tienen emails reales. **Recomendación**: Implementar verificación de email obligatoria."`}
`),
                    new HumanMessage(`Pregunta: "${query}"\n\nSQL:\n\`\`\`sql\n${finalSQL}\n\`\`\`\n\nResultados (${result?.length || 0} filas):\n${JSON.stringify(result, null, 2)}\n\n${isListQuery ? 'OBLIGATORIO: Presenta los datos en TABLA MARKDOWN con headers en **negrita**, alineación izquierda (:---), y nombres de columna descriptivos en español. Luego añade análisis breve.' : 'Analiza estos resultados de forma argumentada.'}`)
                ];

                const analysisResponse = await this.llmService.generateResponse(analysisMessages, []);
                const analysis = analysisResponse.content || "Análisis no disponible";
                logger.info("✅ Analysis complete");
                return analysis;
            }

            // Should never reach here, but just in case
            return `No se pudieron obtener resultados después de ${maxRetries} intentos.`;

        } catch (error) {
            logger.error(`❌ Agent error: ${error.message}`);
            return `Error procesando la consulta: ${error.message}`;
        }
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
     * Detect if the query likely requires fetching data from the database.
     */
    detectIfQueryRequiresData(query) {
        if (!query) return false;
        const lower = query.toLowerCase();
        // Keywords that imply data retrieval
        const dataKeywords = [
            'dame', 'muestrame', 'listar', 'buscar', 'encontrar', 'ver',
            'quien', 'cual', 'cuales', 'cuantos', 'cuando', 'donde',
            'curso', 'estudiante', 'certificado', 'usuario', 'video', 'tarea',
            'suscripcion', 'progreso', 'nota', 'calificacion', 'examen',
            'show', 'list', 'find', 'get', 'who', 'what', 'how many', 'when'
        ];
        return dataKeywords.some(k => lower.includes(k));
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

        lines.push('# 📊 Análisis Completo de Marketing e Inteligencia de Negocio - TareaMov\n');
        lines.push(`**Fecha de análisis:** ${new Date(snapshot.generated_at).toLocaleString('es-ES')}`);
        lines.push(`**Pregunta original:** ${snapshot.query}`);
        lines.push(`**Fuente de datos:** Supabase (real-time)\n`);

        // Executive summary with business context
        lines.push('## 📋 Resumen Ejecutivo — Objetivo y Contexto\n');
        if (snapshot.summary && snapshot.summary.length > 0) {
            snapshot.summary.forEach(item => lines.push(`- ${item}`));
        } else {
            lines.push('- Análisis de datos del sistema TareaMov para fundamentar estrategia de marketing');
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
                    'SIEMPRE agrega LIMIT 20 o LIMIT 50 al final',
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
        lines.push('4. **Pregunta consultas simples** como conteos o listas cortas\n');
        
        lines.push('### 📊 Consultas que funcionan bien:\n');
        lines.push('- "¿Cuántos usuarios hay?"');
        lines.push('- "Dame los últimos 10 cursos"');
        lines.push('- "Lista los usuarios registrados"');
        lines.push('- "¿Cuántas tareas hay?"');
        
        return lines.join('\n');
    }
}