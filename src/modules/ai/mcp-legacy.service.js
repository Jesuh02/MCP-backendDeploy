/**
 * MCP Service - Model Context Protocol
 * Handles prompt processing and context management
 */

import { RAGService } from './rag-legacy.service.js';
import { SupabaseService } from '../../shared/database/SupabaseService.js';
import { getCurrentTenantClient, getCurrentTenantId } from '../../config/tenantRegistry.js';
import { logger } from '../../shared/logging/Logger.js';
import { LLMService } from './infrastructure/llm.service.js';
import { getGitHubService } from '../../shared/github/GitHubService.js';
import { HumanMessage, SystemMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import crypto from 'crypto';

export class MCPService {
    constructor() {
        this.ragService = new RAGService();
        this.supabase = SupabaseService.getInstance();
        this.llmService = LLMService.getInstance();
        this.githubService = getGitHubService();

        // Schema cache - auto-refreshes every 5 minutes
        this._schemaCache = null;
        this._schemaCacheTime = 0;
        this._schemaCacheTTL = 5 * 60 * 1000; // 5 minutes
        // Per-tenant schema cache (keyed by tenantId)
        this._tenantSchemaCaches = new Map();
    }

    /**
     * Returns the active tenant's Supabase client, falling back to the singleton.
     * Works because MCPService methods are called inside runInTenantContext().
     */
    get _tenantClient() {
        return getCurrentTenantClient() || this.supabase.client;
    }

    /**
     * Executes a raw SQL query on the active tenant's Supabase project
     * via the `execute_sql` RPC function.
     *
     * If the RPC doesn't exist (e.g. new tenant DB), attempts to auto-create it
     * via a direct Postgres connection (TENANT_<ID>_DATABASE_URL) and retry.
     */
    async _executeRawSQL(sqlQuery) {
        const client = this._tenantClient;
        if (sqlQuery.trim().endsWith(';')) sqlQuery = sqlQuery.trim().slice(0, -1);
        const tenantId = getCurrentTenantId() || 'default';
        logger.info('🔍 [MCPService._executeRawSQL] Executing on tenant:', tenantId);
        const { data, error } = await client.rpc('execute_sql', { query: sqlQuery });
        if (error) {
            // Surface SQL errors directly so the LLM can self-correct
            if (error.code !== 'PGRST202' && !error.message?.includes('not found') && !error.message?.includes('schema cache')) {
                throw new Error(`SQL Error: ${error.message}`);
            }

            // execute_sql function doesn't exist — try to auto-create it
            logger.warn(`[MCPService] execute_sql not found on tenant '${tenantId}', attempting auto-provision...`);
            const provisioned = await this._autoProvisionExecuteSql(tenantId);
            if (provisioned) {
                // Retry after provisioning
                const retry = await client.rpc('execute_sql', { query: sqlQuery });
                if (!retry.error) return retry.data;
                throw new Error(`SQL Error after auto-provision: ${retry.error.message}`);
            }
            throw new Error(`RPC execute_sql unavailable on tenant '${tenantId}': ${error.message}. Run scripts/migration_execute_sql_function.sql on this tenant's Supabase SQL Editor, or set TENANT_${tenantId.toUpperCase()}_DATABASE_URL for auto-provisioning.`);
        }
        return data;
    }

    /**
     * Attempts to create the execute_sql function on a tenant DB via direct Postgres connection.
     * Looks for TENANT_<ID>_DATABASE_URL or DATABASE_URL (for primary) env vars.
     * @private
     * @param {string} tenantId
     * @returns {Promise<boolean>} true if the function was created successfully
     */
    async _autoProvisionExecuteSql(tenantId) {
        // Already attempted? Don't retry during this process lifecycle
        if (!this._provisionAttempts) this._provisionAttempts = new Set();
        if (this._provisionAttempts.has(tenantId)) return false;
        this._provisionAttempts.add(tenantId);

        // Find the DATABASE_URL for this tenant
        const envKey = `TENANT_${tenantId.toUpperCase().replace(/-/g, '_')}_DATABASE_URL`;
        const dbUrl = process.env[envKey] || (tenantId === 'qa-develop' ? process.env.DATABASE_URL : null);

        if (!dbUrl) {
            logger.warn(`[MCPService] No ${envKey} configured — cannot auto-provision execute_sql. Set it in Railway environment variables.`);
            return false;
        }

        let pgClient;
        try {
            const { default: pkg } = await import('pg');
            const { Client } = pkg;
            pgClient = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
            await pgClient.connect();

            await pgClient.query(`
                CREATE OR REPLACE FUNCTION public.execute_sql(query text)
                RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
                DECLARE result json;
                BEGIN
                    EXECUTE format('SELECT COALESCE(json_agg(t), ''[]''::json) FROM (%s) t', query) INTO result;
                    RETURN COALESCE(result, '[]'::json);
                END; $$;
            `);
            await pgClient.query(`GRANT EXECUTE ON FUNCTION public.execute_sql(text) TO authenticated;`);
            await pgClient.query(`GRANT EXECUTE ON FUNCTION public.execute_sql(text) TO service_role;`);

            logger.info(`✅ [MCPService] Auto-provisioned execute_sql on tenant '${tenantId}'`);
            return true;
        } catch (err) {
            logger.error(`❌ [MCPService] Auto-provision execute_sql failed on '${tenantId}': ${err.message}`);
            return false;
        } finally {
            if (pgClient) { try { await pgClient.end(); } catch (_) { /* ignore */ } }
        }
    }

    /**
     * Returns the DB schema for the active tenant (per-tenant cached).
     * Falls back to the singleton SupabaseService schema when no tenant override is active.
     */
    async _getDatabaseSchema() {
        const tenantId = getCurrentTenantId();
        if (!tenantId) return this.supabase.getDatabaseSchema();

        const cached = this._tenantSchemaCaches.get(tenantId);
        if (cached && (Date.now() - cached.time < this._schemaCacheTTL)) return cached.schema;

        // Reuse the singleton's implementation but bind it to the tenant client
        const svc = this.supabase;
        const schema = await svc.getDatabaseSchema.call({ client: this._tenantClient, executeRawSQL: (sql) => this._executeRawSQL(sql), schemaCache: null, schemaCacheTime: null });
        this._tenantSchemaCaches.set(tenantId, { schema, time: Date.now() });
        return schema;
    }

    /**
     * Get database schema dynamically from Supabase
     * Caches the result for efficiency, auto-refreshes every 5 minutes
     * @returns {Promise<string>} Formatted schema string for LLM
     */
    async getDynamicSchema() {
        const now = Date.now();
        const tenantId = getCurrentTenantId() || 'default';

        // Per-tenant schema caching
        const tenantCache = this._tenantSchemaCaches.get(tenantId);
        if (tenantCache && (now - tenantCache.time) < this._schemaCacheTTL) {
            logger.info(`📋 Using cached database schema for tenant '${tenantId}'`);
            return tenantCache.schema;
        }

        logger.info(`🔄 Fetching fresh database schema from Supabase (tenant: ${tenantId})...`);

        try {
            // New query requested by user to get full DDL details
            const schemaSQL = `
                SELECT
                    table_name,
                    column_name,
                    data_type,
                    is_nullable,
                    column_default
                FROM information_schema.columns
                WHERE table_schema = 'public'
                ORDER BY table_name, ordinal_position;
            `;

            const result = await this._executeRawSQL(schemaSQL);

            if (!result || !Array.isArray(result) || result.length === 0) {
                logger.warn('⚠️ Could not fetch schema, using fallback');
                return this._getFallbackSchema();
            }

            // Format schema for LLM consumption by grouping flat rows
            let schemaText = '**ESQUEMA DE LA BASE DE DATOS (Actualizado automáticamente):**\n\n';

            // Group by table_name
            const tables = {};
            for (const row of result) {
                if (!tables[row.table_name]) {
                    tables[row.table_name] = [];
                }

                let colDesc = `${row.column_name} (${row.data_type}`;
                if (row.is_nullable === 'NO') colDesc += ', NOT NULL';
                if (row.column_default) colDesc += ', default';
                colDesc += ')';

                tables[row.table_name].push(colDesc);
            }

            // Generate text
            for (const [tableName, columns] of Object.entries(tables)) {
                // Also create a simplified list of columns for quick reference
                const simpleCols = result
                    .filter(r => r.table_name === tableName)
                    .map(r => r.column_name)
                    .join(', ');

                schemaText += `- **${tableName}**: ${simpleCols}\n`;
                // Detailed view (commented out to preserve brevity unless needed, 
                // but user asked for "Todo el DDL", so maybe we should be more verbose? 
                // Sticking to format similar to previous but using the new data source)
            }

            // Add relationships hint
            schemaText += `\n**RELACIONES (Foreign Keys):**\n`;
            schemaText += `- courses.creator_user_id → usuarios.id (creador del curso)\n`;
            schemaText += `- subjects.course_id → courses.id\n`;
            schemaText += `- topics.materia_id → subjects.id (⚠️ topics NO tiene course_id, usa materia_id → subjects → courses)\n`;
            schemaText += `- tasks.topic_id → topics.id\n`;
            schemaText += `- task_submissions.task_id → tasks.id\n`;
            schemaText += `- task_submissions.user_id → usuarios.id\n`;
            schemaText += `- subscriptions.creator_id → usuarios.id (⚠️ NO course_id!)\n`;
            schemaText += `- subscriptions.subscriber_id → usuarios.id\n`;
            schemaText += `- transactions.user_id → usuarios.id\n`;
            schemaText += `- notifications.user_id → usuarios.id\n`;
            schemaText += `- videos.course_id → courses.id\n`;
            schemaText += `\n**⚠️ CADENA CORRECTA PARA TAREAS→CURSOS:** tasks.topic_id → topics.materia_id → subjects.id → subjects.course_id → courses.id\n`;
            schemaText += `\n**⚠️ COLUMNAS DE FECHA — IMPORTANTE:**\n`;
            schemaText += `- En la tabla \`courses\`, la columna \`creation_date\` es de tipo TEXT (no timestamp). NUNCA uses EXTRACT() ni funciones de fecha directamente sobre \`creation_date\`.\n`;
            schemaText += `- Para filtrar cursos por fecha de creación, USA SIEMPRE la columna \`created_at\` (timestamp) en lugar de \`creation_date\`.\n`;
            schemaText += `- Ejemplo CORRECTO para "cursos de diciembre 2025": WHERE c.created_at >= '2025-12-01' AND c.created_at < '2026-01-01'\n`;
            schemaText += `- Ejemplo PROHIBIDO: EXTRACT(YEAR FROM c.creation_date) — falla porque creation_date es texto.\n`;
            schemaText += `- Si necesitas EXTRACT sobre una columna text, primero conviértela: EXTRACT(YEAR FROM (c.columna)::timestamp). Pero PREFIERE usar columnas timestamp nativas (created_at, updated_at, last_modified_date).\n`;

            // Cache the result per-tenant
            this._tenantSchemaCaches.set(tenantId, { schema: schemaText, time: now });

            logger.info(`✅ Schema loaded for tenant '${tenantId}': ${result.length} columns found`);
            return schemaText;

        } catch (error) {
            logger.error(`❌ Error fetching schema: ${error.message}`);
            return this._getFallbackSchema();
        }
    }

    /**
     * Fallback schema if dynamic loading fails
     * IMPORTANT: Keep this in sync with actual database schema!
     */
    _getFallbackSchema() {
        return `**ESQUEMA DE LA BASE DE DATOS:**

**TABLAS Y COLUMNAS EXACTAS:**
- **usuarios**: id, username, email, first_name, last_name, is_active, created_at
- **courses**: id, title, description, price, is_premium, creator_user_id, thumbnail_url, created_at
- **videos**: id, title, description, course_id, video_url, duration, order_index, created_at
- **subjects**: id, course_id, name, description, order_index, is_active, created_at
- **topics**: id, name, description, materia_id (FK→subjects.id), subject_id (FK→subjects.id), order_index, created_at (⚠️ NO tiene course_id)
- **tasks**: id, title, description, topic_id, due_date, max_grade, created_at
- **task_submissions**: id, task_id, user_id, file_url, grade, feedback, submitted_at, graded_at
- **subscriptions**: id, creator_id, subscriber_id, subscription_date, created_at (⚠️ NO tiene course_id!)
- **transactions**: id, user_id, amount, status, payment_method, reference, currency, created_at
- **notifications**: id, user_id, title, message, type, read, created_at
- **whatsapp_sessions**: id, user_id (FK→usuarios.id), phone_number, wa_id, is_active, linked_at, last_message_at, otp_code, otp_expires_at, created_at

**⚠️ ADVERTENCIAS CRÍTICAS:**
- subscriptions.creator_id = usuarios.id (el creador del curso)
- subscriptions.subscriber_id = usuarios.id (el suscriptor)
- subscriptions NO tiene course_id - usa creator_id para relacionar con el creador
- Para contar suscriptores de un creador: WHERE subscriptions.creator_id = usuarios.id
- whatsapp_sessions.is_active = TRUE indica que el usuario está vinculado y verificado
- Para saber si un usuario tiene WhatsApp vinculado: JOIN whatsapp_sessions ws ON ws.user_id = usuarios.id WHERE ws.is_active = TRUE`;
    }

    /**
     * Force refresh the schema cache
     */
    async refreshSchemaCache() {
        this._schemaCache = null;
        this._schemaCacheTime = 0;
        return await this.getDynamicSchema();
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
            } catch (e) {
                console.error('❌ MCPService: Failed to get SupabaseService instance:', e.message);
                return [];
            }
        }

        try {
            // New Schema Query: questions_history -> linked to question_sessions
            let query = this._tenantClient
                .from('questions_history')
                .select(`
                    id,
                    question_text,
                    correct_index,
                    explanation,
                    created_at,
                    question_options (option_text, order_index),
                    session:question_sessions!inner (topic_id, task_id)
                `)
                .eq('user_id', userId)
                .eq('course_id', courseId)
                .order('created_at', { ascending: false });

            // Apply filters on the session relation
            if (topicId) {
                query = query.eq('session.topic_id', topicId);
            }
            if (taskId) {
                query = query.eq('session.task_id', taskId);
            }

            const { data: rows, error } = await query;

            if (error) {
                // Determine if error is due to missing table (migration check)
                if (error.code === '42P01') { // undefined_table
                    console.warn("⚠️ New tables not found. Falling back to old 'reinforcement_question_history'...");
                    return await this._getLegacyReinforcementHistory(userId, courseId, topicId, taskId);
                }
                throw error;
            }

            let history = [];
            if (rows && Array.isArray(rows)) {
                history = rows.map(r => ({
                    question: r.question_text,
                    options: (r.question_options && r.question_options.sort((a, b) => a.order_index - b.order_index).map(o => o.option_text)) || [],
                    answer_index: r.correct_index,
                    explanation: r.explanation,
                    id: r.id, // Keep ID for reference
                    topic_id: r.session && r.session.topic_id,
                    task_id: r.session && r.session.task_id
                }));
            }

            console.log(`✅ MCPService: Found ${history.length} questions in history for user ${userId} course ${courseId}`);

            return history;
        } catch (error) {
            logger.warn(`Error fetching reinforcement history: ${error.message}`);
            return [];
        }
    }

    /**
     * Fallback for legacy table
     */
    async _getLegacyReinforcementHistory(userId, courseId, topicId = null, taskId = null) {
        try {
            let query = this._tenantClient
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
            return history;
        } catch (e) {
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
     * Get optimized context for LLM reinforcement learning
     * Combines recent history (windowing) with RAG relevant content to prevent token overflow
     * @param {number} userId - The user ID
     * @param {number} courseId - The course ID
     * @param {number} topicId - Optional topic ID to filter history
     * @param {number} limit - Max number of recent history items to retrieve (default 50)
     */
    async getReinforcementContextForLLM(userId, courseId, topicId = null, limit = 50) {
        try {
            logger.info(`🧠 Building reinforcement context for User ${userId}, Course ${courseId} (Topic: ${topicId || 'All'}, Limit: ${limit})`);

            // 1. Get recent history (Windowing Pattern) - Server Side Filtering
            // Instead of client sending full JSON, we query DB directly
            let query = this._tenantClient
                .from('reinforcement_question_history')
                .select('questions, created_at')
                .eq('user_id', userId)
                .eq('course_id', courseId);

            // Filter by topic if provided (and valid positive ID)
            if (topicId && !isNaN(topicId) && Number(topicId) > 0) {
                query = query.eq('topic_id', topicId);
            }

            const { data: history, error } = await query
                .order('created_at', { ascending: false }) // Newest first
                .limit(limit);

            if (error) throw error;


            // 2. Extract and Flatten Questions
            let recentQuestions = [];
            if (history && history.length > 0) {
                history.forEach(record => {
                    // Handle both string array and object array formats
                    if (record.questions && Array.isArray(record.questions)) {
                        record.questions.forEach(q => {
                            if (typeof q === 'string') {
                                recentQuestions.push(q);
                            } else if (q.question) {
                                recentQuestions.push(q.question);
                            }
                        });
                    }
                });
            }

            // 3. Apply semantic density reduction (keep only last N questions total)
            // Even if we fetched 50 batches, we might have 500 questions. detailed limit.
            const QUESTION_CAP = 50;
            if (recentQuestions.length > QUESTION_CAP) {
                recentQuestions = recentQuestions.slice(0, QUESTION_CAP);
            }

            // Reverse to chronological order (Oldest -> Newest) for the LLM to understand flow
            recentQuestions = recentQuestions.reverse();

            // 4. Format context string
            let contextString = `\n--- PREVIOUS INTERACTIONS (Last ${recentQuestions.length}) ---\n`;
            if (recentQuestions.length === 0) {
                contextString += "(No previous reinforcement history)";
            } else {
                recentQuestions.forEach((q, i) => {
                    contextString += `Q${i + 1}: ${q}\n`;
                });
            }
            contextString += "\n------------------------------------------\n";

            logger.info(`✅ Context built: ${recentQuestions.length} questions included.`);

            return {
                contextString,
                questionCount: recentQuestions.length,
                questions: recentQuestions
            };

        } catch (error) {
            logger.error(`❌ Error getting reinforcement context: ${error.message}`);
            return {
                contextString: "\n[System Error: Could not retrieve history]\n",
                questionCount: 0,
                questions: []
            };
        }
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
     * Uses new normalized schema (sessions, questions, options)
     * Implements STRICT Uniqueness Flow (Step 0-H):
     * 1. Hash Check (Exact match)
     * 2. Semantic Check (Question Embedding)
     * 3. Option Semantic Check (Option Embedding)
     */
    async saveReinforcementHistory(userId, courseId, questions, topicId = null, taskId = null, sessionId = null) {
        if (!userId || !courseId || !questions || !questions.length) return false;

        try {
            const REQUIRED_QUESTION_COUNT = 10;
            const preparedQuestions = this._prepareQuestionsForPersistence(questions, REQUIRED_QUESTION_COUNT);

            if (preparedQuestions.length === 0) {
                logger.warn(`⚠️ saveReinforcementHistory: no valid questions in batch`);
                return {
                    success: false,
                    savedCount: 0,
                    savedQuestions: [],
                    requiredCount: REQUIRED_QUESTION_COUNT,
                    insufficientCount: true,
                    totalSubmitted: Array.isArray(questions) ? questions.length : 0,
                    reason: 'NO_VALID_QUESTIONS'
                };
            }

            const EmbeddingService = (await
                import ('./infrastructure/embedding.service.js')).EmbeddingService;
            const embeddingService = EmbeddingService.getInstance();
            const supabase = this._tenantClient;

            // Ensure services are ready
            if (!embeddingService.isReady()) {
                logger.warn('⚠️ EmbeddingService not ready. Attempting to initialize...');
            }

            // A. Create Session (if not provided) [Step 0]
            // Check for existing recent session to prevent duplicates
            if (!sessionId) {
                // Look for an existing session created in the last 2 minutes for the same context
                const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
                let existingQuery = supabase
                    .from('question_sessions')
                    .select('id')
                    .eq('user_id', userId)
                    .eq('course_id', courseId)
                    .gte('created_at', twoMinutesAgo)
                    .order('created_at', { ascending: false })
                    .limit(1);

                // Match on topic_id and task_id (use is(null) for null values)
                if (topicId) {
                    existingQuery = existingQuery.eq('topic_id', topicId);
                } else {
                    existingQuery = existingQuery.is('topic_id', null);
                }
                if (taskId) {
                    existingQuery = existingQuery.eq('task_id', taskId);
                } else {
                    existingQuery = existingQuery.is('task_id', null);
                }

                const { data: existingSession } = await existingQuery.maybeSingle();

                if (existingSession) {
                    sessionId = existingSession.id;
                    logger.info(`♻️ Reusing existing session ${sessionId} (dedup within 2min window)`);
                } else {
                    const { data: sessionData, error: sessionError } = await supabase
                        .from('question_sessions')
                        .insert({
                            user_id: userId,
                            course_id: courseId,
                            topic_id: topicId || null,
                            task_id: taskId || null
                        })
                        .select('id')
                        .single();

                    if (sessionError) {
                        logger.error(`Error creating session during save: ${sessionError.message}`);
                        sessionId = null;
                    } else {
                        sessionId = sessionData.id;
                        logger.info(`✅ New session created: ${sessionId} (topic=${topicId}, task=${taskId})`);
                    }
                }
            }

            let savedCount = 0;
            const acceptedQuestions = [];
            const inBatchQuestionHashes = new Set();

            // ═══════════════════════════════════════════════════════════
            // BATCH OPTIMIZATION: Pre-compute hashes and embeddings for
            // ALL questions at once instead of one-by-one API calls.
            // This reduces N embedding API calls to 1-2 batch calls.
            // ═══════════════════════════════════════════════════════════

            // Step 1: Pre-compute all hashes and deduplicate within batch
            const questionsWithHashes = [];
            for (const q of preparedQuestions) {
                const qText = q.question;
                if (!qText) continue;
                const normalizedText = this._normalizeQuestionText(qText);
                const questionHash = crypto.createHash('sha256').update(normalizedText).digest('hex');
                if (inBatchQuestionHashes.has(questionHash)) {
                    logger.info(`🚫 Duplicate Question (In-Batch Hash Match): "${qText.substring(0, 40)}..."`);
                    continue;
                }
                inBatchQuestionHashes.add(questionHash);
                questionsWithHashes.push({ ...q, _hash: questionHash, _normalized: normalizedText });
            }

            if (questionsWithHashes.length === 0) {
                return { success: false, savedCount: 0, savedQuestions: [], requiredCount: REQUIRED_QUESTION_COUNT, cumulativeCount: 0 };
            }

            // Step 2: Batch hash check against DB (single query instead of N queries)
            // NOTE: We check by user_id + course_id to match the scope of getReinforcementHistory()
            // This allows questions to be reused across different courses
            const allHashes = questionsWithHashes.map(q => q._hash);
            let existingHashes = new Set();
            try {
                const { data: hashRows } = await supabase
                    .from('questions_history')
                    .select('question_hash')
                    .eq('user_id', userId)
                    .eq('course_id', courseId)
                    .in('question_hash', allHashes);
                if (hashRows) {
                    existingHashes = new Set(hashRows.map(r => r.question_hash));
                }
                logger.info(`📋 Hash check: found ${existingHashes.size}/${allHashes.length} existing hashes for user=${userId} course=${courseId}`);
            } catch (hashErr) {
                logger.warn(`⚠️ Batch hash check failed, will check individually: ${hashErr.message}`);
            }

            // Filter out hash-matched duplicates
            const hashUniqueQuestions = questionsWithHashes.filter(q => {
                if (existingHashes.has(q._hash)) {
                    logger.info(`🚫 Duplicate Question (Hash Match): "${q.question.substring(0, 40)}..."`);
                    return false;
                }
                return true;
            });

            if (hashUniqueQuestions.length === 0) {
                logger.info(`🚫 All ${questionsWithHashes.length} questions are hash-duplicates`);
                // Count cumulative
                let cumulativeCount = 0;
                try {
                    const { count } = await supabase.from('questions_history').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('course_id', courseId);
                    if (typeof count === 'number') cumulativeCount = count;
                } catch (_) {}
                return { success: false, savedCount: 0, cumulativeCount, savedQuestions: [], requiredCount: REQUIRED_QUESTION_COUNT };
            }

            // Step 3: Batch embed ALL unique question texts in ONE call
            const questionTexts = hashUniqueQuestions.map(q => q.question);
            let questionEmbeddings = [];
            try {
                questionEmbeddings = await embeddingService.embedDocuments(questionTexts);
            } catch (e) {
                logger.warn(`⚠️ Batch question embedding failed: ${e.message}. Using fallback.`);
            }

            // Assign embeddings (with fallback)
            for (let i = 0; i < hashUniqueQuestions.length; i++) {
                const emb = (questionEmbeddings && questionEmbeddings[i] && Array.isArray(questionEmbeddings[i]) && questionEmbeddings[i].length > 0)
                    ? questionEmbeddings[i]
                    : embeddingService._fallbackEmbed(hashUniqueQuestions[i].question);
                hashUniqueQuestions[i]._embedding = emb;
            }

            // Step 4: Batch embed ALL options in ONE call
            const allOptionTexts = [];
            const optionMapping = []; // Track which options belong to which question
            for (let qi = 0; qi < hashUniqueQuestions.length; qi++) {
                const opts = hashUniqueQuestions[qi].options || hashUniqueQuestions[qi].opciones || [];
                for (let oi = 0; oi < opts.length; oi++) {
                    allOptionTexts.push(String(opts[oi]).trim());
                    optionMapping.push({ qi, oi });
                }
            }

            let allOptionEmbeddings = [];
            if (allOptionTexts.length > 0) {
                try {
                    allOptionEmbeddings = await embeddingService.embedDocuments(allOptionTexts);
                } catch (e) {
                    logger.warn(`⚠️ Batch option embedding failed: ${e.message}. Using fallback.`);
                }
            }

            // Assign option embeddings back to questions
            for (const q of hashUniqueQuestions) {
                q._optionEmbeddings = [];
            }
            for (let i = 0; i < optionMapping.length; i++) {
                const { qi, oi } = optionMapping[i];
                const emb = (allOptionEmbeddings && allOptionEmbeddings[i] && Array.isArray(allOptionEmbeddings[i]) && allOptionEmbeddings[i].length > 0)
                    ? allOptionEmbeddings[i]
                    : embeddingService._fallbackEmbed(allOptionTexts[i]);
                hashUniqueQuestions[qi]._optionEmbeddings[oi] = emb;
            }

            // Step 5: Semantic check + save per question (embedding already computed)
            for (const q of hashUniqueQuestions) {
                const qText = q.question;
                const qExplanation = q.explanation;
                const qIndex = q.correctIndex;
                let questionEmbedding = q._embedding;
                const questionHash = q._hash;

                if (!qText || !questionEmbedding || !Array.isArray(questionEmbedding) || questionEmbedding.length === 0) continue;

                // --- Semantic Search (using pre-computed embedding) ---
                // Filter by user_id AND course_id to match the scope of hash duplicate detection
                if (questionEmbedding) {
                    const { data: semanticMatches, error: semanticError } = await supabase
                        .rpc('match_questions', {
                            query_embedding: questionEmbedding,
                            match_threshold: 0.90,
                            match_count: 1,
                            filter_user_id: userId,
                            filter_course_id: courseId
                        });

                    if (semanticError) {
                        if (semanticError.message.includes('schema cache') || semanticError.message.includes('Could not find the function')) {
                            // Function signature mismatch — migration_match_questions_v2.sql hasn't been run yet.
                            // Run scripts/migration_match_questions_v2.sql in the Supabase SQL Editor to fix.
                            logger.warn('⚠️ match_questions RPC not found. Run scripts/migration_match_questions_v2.sql in Supabase SQL Editor. Skipping semantic dedup.');
                        } else if (semanticError.message.includes('dimensions')) {
                            const expectedDim = this._parseExpectedDimensionFromError(semanticError.message);
                            if (expectedDim > 0) {
                                const adjustedEmbedding = this._adjustVectorDimension(questionEmbedding, expectedDim);
                                const { data: retryMatches, error: retrySemanticError } = await supabase
                                    .rpc('match_questions', {
                                        query_embedding: adjustedEmbedding,
                                        match_threshold: 0.90,
                                        match_count: 1,
                                        filter_user_id: userId,
                                        filter_course_id: courseId
                                    });

                                if (!retrySemanticError && retryMatches && retryMatches.length > 0) {
                                    logger.info(`🚫 Duplicate Question (Semantic Match ${retryMatches[0].similarity?.toFixed(2)}): "${qText.substring(0, 40)}..."`);
                                    continue;
                                }
                            } else {
                                logger.warn(`⚠️ Vector dimension mismatch in match_questions (model=${questionEmbedding.length}). Skipping semantic check.`);
                            }
                        } else {
                            logger.warn(`⚠️ Semantic check failed: ${semanticError.message}`);
                        }
                    } else if (semanticMatches && semanticMatches.length > 0) {
                        logger.info(`🚫 Duplicate Question (Semantic Match ${semanticMatches[0].similarity?.toFixed(2)}): "${qText.substring(0, 40)}..."`);
                        continue;
                    }
                }

                // --- Save Question (using pre-computed embedding) ---
                const optionsArray = q.options || q.opciones || [];
                const optionEmbeddings = q._optionEmbeddings || [];

                let savedQResult = null;

                const { data: savedQ, error: saveError } = await supabase
                    .from('questions_history')
                    .insert({
                        session_id: sessionId,
                        user_id: userId,
                        course_id: courseId,
                        question_text: qText,
                        question_hash: questionHash,
                        question_embedding: questionEmbedding,
                        correct_index: qIndex,
                        explanation: qExplanation
                    })
                    .select('id')
                    .single();

                if (saveError) {
                    if (saveError.message.includes('dimensions')) {
                        const expectedDim = this._parseExpectedDimensionFromError(saveError.message);
                        if (expectedDim <= 0) {
                            logger.error(`❌ Vector dimension mismatch (model=${questionEmbedding.length}): ${saveError.message}`);
                            continue;
                        }
                        questionEmbedding = this._adjustVectorDimension(questionEmbedding, expectedDim);
                        const retry = await supabase
                            .from('questions_history')
                            .insert({
                                session_id: sessionId, user_id: userId, course_id: courseId,
                                question_text: qText, question_hash: questionHash,
                                question_embedding: questionEmbedding, correct_index: qIndex,
                                explanation: qExplanation
                            })
                            .select('id').single();
                        if (retry.error) { logger.error(`❌ Retry failed: ${retry.error.message}`); continue; }
                        savedQResult = retry.data;
                    } else {
                        logger.error(`❌ Error saving question: ${saveError.message}`);
                        continue;
                    }
                }

                const questionId = (savedQResult || savedQ).id;

                // Save Options (using pre-computed embeddings)
                if (optionsArray.length > 0) {
                    const optionsPayload = optionsArray.map((opt, idx) => ({
                        question_id: questionId,
                        option_text: String(opt),
                        order_index: idx,
                        option_embedding: (optionEmbeddings[idx] && Array.isArray(optionEmbeddings[idx]) && optionEmbeddings[idx].length > 0)
                            ? optionEmbeddings[idx]
                            : embeddingService._fallbackEmbed(String(opt))
                    }));

                    const { error: optError } = await supabase.from('question_options').insert(optionsPayload);

                    if (optError) {
                        if (optError.message.includes('dimensions')) {
                            const expectedDim = this._parseExpectedDimensionFromError(optError.message);
                            if (expectedDim > 0) {
                                const adjustedPayload = optionsPayload.map(item => ({
                                    ...item,
                                    option_embedding: this._adjustVectorDimension(item.option_embedding, expectedDim)
                                }));
                                const retryOpt = await supabase.from('question_options').insert(adjustedPayload);
                                if (retryOpt.error) logger.error(`❌ Options retry failed: ${retryOpt.error.message}`);
                            }
                        } else {
                            logger.error(`❌ Error saving options: ${optError.message}`);
                        }
                    }
                }

                savedCount++;
                acceptedQuestions.push(q);

                if (savedCount >= REQUIRED_QUESTION_COUNT) {
                    break;
                }
            }

            // Count cumulative unique questions for this user+course+topic+task
            let cumulativeCount = savedCount;
            try {
                let countQuery = supabase
                    .from('questions_history')
                    .select('id', { count: 'exact', head: true })
                    .eq('user_id', userId)
                    .eq('course_id', courseId);

                if (sessionId) {
                    // Count all questions linked to sessions with the same topic/task
                    const { data: sessionData } = await supabase
                        .from('question_sessions')
                        .select('topic_id, task_id')
                        .eq('id', sessionId)
                        .single();

                    if (sessionData) {
                        // Get all session IDs with matching context
                        let sessionQuery = supabase
                            .from('question_sessions')
                            .select('id')
                            .eq('user_id', userId)
                            .eq('course_id', courseId);
                        if (sessionData.topic_id) sessionQuery = sessionQuery.eq('topic_id', sessionData.topic_id);
                        if (sessionData.task_id) sessionQuery = sessionQuery.eq('task_id', sessionData.task_id);
                        const { data: relatedSessions } = await sessionQuery;
                        if (relatedSessions && relatedSessions.length > 0) {
                            const sessionIds = relatedSessions.map(s => s.id);
                            countQuery = countQuery.in('session_id', sessionIds);
                        }
                    }
                }

                const { count, error: countError } = await countQuery;
                if (!countError && typeof count === 'number') {
                    cumulativeCount = count;
                }
            } catch (countErr) {
                logger.warn(`⚠️ Failed to get cumulative count: ${countErr.message}`);
            }

            logger.info(`✅ MCPService: Saved ${savedCount} unique questions this batch. Cumulative: ${cumulativeCount}/${REQUIRED_QUESTION_COUNT}.`);
            return {
                success: cumulativeCount >= REQUIRED_QUESTION_COUNT,
                savedCount,
                cumulativeCount,
                savedQuestions: acceptedQuestions,
                requiredCount: REQUIRED_QUESTION_COUNT,
                insufficientCount: cumulativeCount < REQUIRED_QUESTION_COUNT
            };

        } catch (error) {
            logger.error(`❌ Critical error in saveReinforcementHistory: ${error.message}`);
            return false;
        }
    }


    _parseExpectedDimensionFromError(message = '') {
        const match = String(message).match(/expected\s+(\d+)\s+dimensions?,\s+not\s+(\d+)/i);
        return match ? parseInt(match[1], 10) : 0;
    }

    _adjustVectorDimension(vector, targetDim) {
        if (!Array.isArray(vector)) return vector;
        if (!Number.isInteger(targetDim) || targetDim <= 0) return vector;
        if (vector.length === targetDim) return vector;
        if (vector.length > targetDim) return vector.slice(0, targetDim);
        return [...vector, ...new Array(targetDim - vector.length).fill(0)];
    }

    _prepareQuestionsForPersistence(questions, limit = 10) {
        if (!Array.isArray(questions) || questions.length === 0) {
            return [];
        }

        const prepared = [];
        const seenQuestions = new Set();

        for (const item of questions) {
            const questionText = (typeof item === 'string' ? item : (item.question || item.pregunta || '')).trim();
            if (!questionText) continue;

            const normalizedQuestion = this._normalizeQuestionText(questionText);
            if (!normalizedQuestion || seenQuestions.has(normalizedQuestion)) continue;

            const rawOptions = (Array.isArray(item?.options) ? item.options : Array.isArray(item?.opciones) ? item.opciones : [])
                .map(option => String(option || '').trim())
                .filter(Boolean);

            const uniqueOptions = [];
            const seenOptions = new Set();
            for (const option of rawOptions) {
                const normalizedOption = this._normalizeOptionText(option);
                if (!normalizedOption || seenOptions.has(normalizedOption)) continue;
                seenOptions.add(normalizedOption);
                uniqueOptions.push(option);
            }

            if (uniqueOptions.length < 4) {
                continue;
            }

            const trimmedOptions = uniqueOptions.slice(0, 4);
            const rawCorrectIndex = Number(item?.correctIndex ?? item?.correct_index ?? 0);
            const safeCorrectIndex = Number.isInteger(rawCorrectIndex) ? rawCorrectIndex : 0;
            const originalCorrectOption = rawOptions[safeCorrectIndex] || trimmedOptions[0];
            const normalizedCorrectOption = this._normalizeOptionText(originalCorrectOption);
            let correctedIndex = trimmedOptions.findIndex(option => this._normalizeOptionText(option) === normalizedCorrectOption);
            if (correctedIndex < 0) {
                correctedIndex = 0;
            }

            prepared.push({
                question: questionText,
                options: trimmedOptions,
                correctIndex: correctedIndex,
                explanation: String(item?.explanation || item?.explicacion || '').trim()
            });

            seenQuestions.add(normalizedQuestion);

            if (prepared.length >= limit) {
                break;
            }
        }

        return prepared;
    }

    _normalizeQuestionText(text = '') {
        return String(text)
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    _normalizeOptionText(text = '') {
        return String(text)
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
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

        for (const { key, table }
            of countConfigs) {
            const sql = `SELECT COUNT(*) AS total FROM ${table}`;
            sqlStatements.push(sql);

            try {
                const { count, error } = await this._tenantClient
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
                const { data, error } = await this._tenantClient
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
                        const { data, error } = await this._tenantClient
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
                        const { data, error } = await this._tenantClient
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
                        hint = "ERROR DE ESQUEMA: La columna solicitada no existe. Usa `get_database_schema` para verificar los nombres de columnas.";
                    } else if (msg.includes("relation") && msg.includes("does not exist")) {
                        hint = "ERROR DE ESQUEMA: La tabla solicitada no existe. Usa `get_database_schema` para verificar los nombres de tablas.";
                    } else if (msg.includes("missing FROM-clause")) {
                        hint = "ERROR DE SINTAXIS SQL: Usaste un alias sin definirlo en la cláusula FROM (ej: `SELECT t.id FROM table` en vez de `FROM table t`).";
                    } else if (msg.includes('syntax error at or near "<"')) {
                        hint = "ERROR DE SINTAXIS SQL: Estás usando placeholders como `<ID>` o `<CREADOR_ID>`. DEBES usar valores reales (ej: `WHERE id = 1`). NO uses corchetes angulares.";
                    } else {
                        hint = "Error en la consulta SQL. Verifica la sintaxis y los nombres de tablas/columnas usando `get_database_schema`.";
                    }

                    // Specific hint for the common hallucination about creator_user_id in usuarios
                    if (msg.includes('usuarios.creator_user_id')) {
                        hint = "ERROR DE ESQUEMA: La tabla 'usuarios' NO tiene columna 'creator_user_id'. Esa columna pertenece a 'courses'. Para encontrar creadores, usa 'courses.creator_user_id'.";
                    }

                    // Specific hint for task_submissions.student_username error
                    if (sqlError.message && sqlError.message.includes('task_submissions.student_username')) {
                        hint = "ERROR DE ESQUEMA: La tabla 'task_submissions' NO tiene columna 'student_username'. Usa 'student_id' (Foreign Key a usuarios.id).";
                    }

                    // Hint for grouping error 42803 - now supportive instead of restrictive
                    if (sqlError.code === '42803' || (sqlError.message && (sqlError.message.includes('GROUP BY') || sqlError.message.includes('STRICT MODE')))) {
                        hint = "ERROR SQL (42803): Columnas no agregadas deben estar en GROUP BY. Ejemplo correcto: SELECT course_id, COUNT(*) FROM tasks GROUP BY course_id";
                    }

                    // Return explicit error instead of generic snapshot to avoid confusing the LLM
                    data = {
                        error: true,
                        message: `Error ejecutando SQL: ${sqlError.message}`,
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
    async processQueryToData(query, userId = null, userContext = {}) {
            logger.info(`📊 Processing query to data (MCP Agent): "${query}" (User: ${userId})`);

            // Ensure lazy initialization runs before checking model availability
            if (this.llmService && typeof this.llmService._ensureInitialized === 'function') {
                await this.llmService._ensureInitialized();
            }

            if (!this.llmService || !this.llmService.model) {
                throw new Error("LLM Service not available for SQL generation");
            }

            // ============================================================
            // 🔐 ACCESS RESTRICTION for Excel data queries
            // ============================================================
            const { userRoles = [], username } = userContext;
            const safeUsername = (username || '').replace(/'/g, "''");
            const userIdResolution = safeUsername
                ? `(SELECT id FROM usuarios WHERE id = ${userId} UNION SELECT id FROM usuarios WHERE username = '${safeUsername}')`
                : userId ? `${userId}` : null;
            const isAdmin = userId && Array.isArray(userRoles) && (userRoles.map(Number).includes(3) || userRoles.map(Number).includes(4));

            let accessRestriction = '';
            if (userId && userIdResolution) {
                if (isAdmin) {
                    accessRestriction = `\n\n**NIVEL DE ACCESO: ADMINISTRADOR — Puedes consultar TODOS los datos de la plataforma sin restricciones.**\n` +
                        `⚠️ PROHIBIDO: Nunca uses auth.uid().\n` +
                        `**IDENTIDAD:** userId=${userId}${safeUsername ? `, username='${safeUsername}'` : ''}.\n` +
                        `**IMPORTANTE:** NO apliques filtros de curso ni de usuario a menos que el usuario lo pida explícitamente (ej. "mis cursos", "mis estudiantes").\n` +
                        `Si la consulta es general (ej. "todas las transacciones", "todos los usuarios"), devuelve TODOS los registros sin WHERE restrictivo.\n` +
                        `Solo cuando la consulta se refiera a "mis cursos" o "mis estudiantes", filtra con:\n` +
                        `  WHERE c.creator_user_id IN ${userIdResolution}\n`;
                } else {
                    accessRestriction = `\n\n**RESTRICCIÓN DE ACCESO OBLIGATORIA:**\n` +
                        `userId=${userId}${safeUsername ? `, username='${safeUsername}'` : ''}.\n` +
                        `⚠️ PROHIBIDO: Nunca uses auth.uid().\n` +
                        `SUBQUERY DE CURSOS ACCESIBLES:\n` +
                        `  (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution})\n\n` +
                        `CONSULTA DE REFERENCIA — PROGRESO DE ESTUDIANTES:\n` +
                        `  SELECT u.username AS estudiante, c.title AS curso,\n` +
                        `         pc.tareas_completadas, pc.tareas_totales, pc.porcentaje_progreso,\n` +
                        `         pc.calificacion_ponderada AS promedio, pc.estado\n` +
                        `  FROM progreso_curso pc\n` +
                        `  JOIN usuarios u ON pc.usuario_estudiante = u.id\n` +
                        `  JOIN courses c ON pc.curso_id = c.id\n` +
                        `  WHERE pc.curso_id IN (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution})\n` +
                        `  ORDER BY c.title, u.username;\n`;
                }
            }

            // Use the MCP Agent approach
            const conversationHistory = [];
            let iteration = 0;
            const MAX_SAFETY_ITERATIONS = 30;
            let lastSuccessfulResult = null;

            // Pre-load real DB schema so the LLM never guesses at table names from training data
            let preloadedSchema = '';
            try {
                preloadedSchema = await this.getDynamicSchema();
                logger.info('✅ Schema pre-loaded for processQueryToData agent');
            } catch (schErr) {
                logger.warn(`⚠️ Schema pre-load failed: ${schErr.message}`);
            }

            const systemMessage = new SystemMessage(`Eres un agente de base de datos. Tu objetivo es obtener datos RAW para exportar a Excel.

**ESQUEMA REAL DE LA BASE DE DATOS (Pre-cargado automáticamente):**
${preloadedSchema || '(esquema no disponible, usa get_database_schema)'}

**HERRAMIENTAS:**
1. \`get_database_schema\` - Obtiene el esquema de la base de datos (ya incluido arriba)
2. \`query_database\` - Ejecuta consultas SQL

**FLUJO:**
1. El esquema ya está cargado arriba — úsalo para identificar los nombres reales de tablas y columnas
2. Si el usuario menciona un nombre en español (ej: "transacciones"), busca el nombre inglés en el esquema arriba
3. Ejecuta query_database directamente con SQL correcto basado en el esquema
4. Si hay error, analízalo y corrige
5. Cuando obtengas datos, responde con: DATOS_LISTOS

**REGLAS:**
- USA SOLO columnas que existan en el esquema
- Incluye LIMIT 1000 para evitar sobrecargar el servidor
- Si la consulta falla, corrige basándote en el error
- **EVITA USAR FUNCIONES DE AGREGACIÓN (COUNT, SUM, AVG, etc.)** a menos que el usuario mencione explícitamente "cuenta", "total" o similar. El objetivo principal es devolver filas sin resumir siempre que sea posible.
- Si el prompt incluye palabras como "pagos", "users", "transacciones", "username" o similares, genera una consulta detallada que liste cada registro relevante en lugar de un solo valor agregado.
- **IMPORTANTE:** cuando el texto mencione explícitamente que se quiere un "excel" o un reporte, prioriza siempre un resultado tabular con filas completas y evita valores agregados, incluso si el usuario pregunta "cuántos" o "cuántas". Esta regla garantiza que los archivos Excel contengan datos en lugar de sólo totales.

**REGLA DE PRESENTACIÓN — NUNCA MOSTRAR IDs NUMÉRICOS:**
- NUNCA incluyas columnas de IDs numéricos (id, user_id, course_id, creator_user_id, student_id, topic_id, task_id, etc.) en el SELECT.
- Para personas: selecciona username, first_name, last_name en vez de user_id.
- Para cursos: selecciona title en vez de course_id.
- Para temas: selecciona name en vez de topic_id. Para tareas: selecciona title en vez de task_id.
- Siempre haz JOIN con las tablas correspondientes para resolver FKs a nombres legibles.
- Ejemplo PROHIBIDO: SELECT user_id, course_id FROM subscriptions
- Ejemplo CORRECTO: SELECT u.username, c.title FROM subscriptions s JOIN usuarios u ON s.subscriber_id = u.id JOIN courses c ON c.creator_user_id = s.creator_id

**⚠️ ESQUEMA CRÍTICO — COLUMNAS QUE NO EXISTEN:**
- topics NO tiene course_id. La cadena correcta es: tasks.topic_id → topics.materia_id → subjects.id → subjects.course_id → courses.id
- subscriptions NO tiene course_id.
- Para consultas de PROGRESO, usa SIEMPRE la tabla \`progreso_curso\` (tiene curso_id directo a courses.id). NO necesitas pasar por topics/subjects.
- Si existe una CONSULTA DE REFERENCIA abajo, úsala directamente con query_database sin consultar get_database_schema primero.
${accessRestriction}
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
                            const fallbackResult = await this._executeRawSQL(fallbackSql);
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
    async processQueryWithAgent(query, userContext = {}) {
        logger.info(`🤖 Processing query with MCP Agent: "${query}"`);

        // Ensure lazy initialization runs before checking model availability
        if (this.llmService && typeof this.llmService._ensureInitialized === 'function') {
            await this.llmService._ensureInitialized();
        }

        if (!this.llmService || !this.llmService.model) {
            logger.warn("⚠️ LLM Service not available. Returning fallback message.");
            return "Lo siento, el servicio de IA no está disponible en este momento (Falta configuración de API Key). Por favor, intenta consultas SQL directas o verifica la configuración del servidor.";
        }

        try {
            // ============================================================
            // 🔄 DYNAMIC DATABASE SCHEMA
            // Load schema automatically from Supabase (cached for 5 min)
            // ============================================================
            const schemaInfo = await this.getDynamicSchema();
            logger.info(`✅ Using dynamic schema (auto-refreshed)`);

            // ============================================================
            // 🔐 USER ACCESS RESTRICTION (if authenticated userId is provided)
            // ============================================================
            const { userId, userRoles = [], username } = userContext;
            const isAdmin = userId && Array.isArray(userRoles) && (userRoles.map(Number).includes(3) || userRoles.map(Number).includes(4));
            const isTeacher = userId && !isAdmin && (Array.isArray(userRoles) && userRoles.map(Number).includes(2));
            // When userId is present but no explicit roles, default to teacher-level restriction (safe default)
            const hasUserContext = !!userId;
            // Sanitize username for safe SQL embedding
            const safeUsername = (username || '').replace(/'/g, "''");
            const userIdResolution = safeUsername
                ? `(SELECT id FROM usuarios WHERE id = ${userId} UNION SELECT id FROM usuarios WHERE username = '${safeUsername}')`
                : `${userId}`;

            if (hasUserContext) {
                logger.info(`🔐 processQueryWithAgent — userId=${userId}, username=${username || 'N/A'}, roles=${JSON.stringify(userRoles)}, isAdmin=${isAdmin}, isTeacher=${isTeacher}`);
            } else {
                logger.warn(`⚠️ processQueryWithAgent — No userId in userContext, queries will have NO access restriction`);
            }

            let accessRestriction = '';
            if (hasUserContext && isAdmin) {
                accessRestriction = `\n\n**NIVEL DE ACCESO: ADMINISTRADOR — Puedes consultar todos los datos de la plataforma.**\n⚠️ PROHIBIDO: Nunca uses auth.uid() — esa función no existe en este contexto y causará errores de tipo.\n\n` +
                `**IDENTIDAD DEL USUARIO AUTENTICADO:** userId=${userId}${safeUsername ? `, username='${safeUsername}'` : ''}.\n` +
                `Cuando el usuario pregunte por "mis cursos", "mis estudiantes" o datos propios, filtra usando:\n` +
                `  WHERE c.creator_user_id IN ${userIdResolution}\n` +
                `  O con JOIN: JOIN usuarios creador ON c.creator_user_id = creador.id WHERE creador.username = '${safeUsername || 'N/A'}'\n\n` +
                `CONSULTA DE REFERENCIA — PROGRESO DE ESTUDIANTES:\n` +
                `  SELECT u.username AS estudiante, c.title AS curso,\n` +
                `         pc.tareas_completadas, pc.tareas_totales, pc.porcentaje_progreso,\n` +
                `         pc.calificacion_ponderada AS promedio, pc.estado\n` +
                `  FROM progreso_curso pc\n` +
                `  JOIN usuarios u ON pc.usuario_estudiante = u.id\n` +
                `  JOIN courses c ON pc.curso_id = c.id\n` +
                `  WHERE pc.curso_id IN (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution})\n` +
                `  ORDER BY c.title, u.username;`;
            } else if (hasUserContext) {
                // Teacher or unknown role: always restrict to the authenticated user's own data
                accessRestriction = `\n\n**RESTRICCIÓN DE ACCESO OBLIGATORIA E IRRENUNCIABLE:**
El ID autenticado del usuario que hace la consulta es: **${userId}**${safeUsername ? `, username autenticado: **${safeUsername}**` : ''}.
⚠️ CRÍTICO: Si el usuario menciona su nombre o username en el chat (ej. "Soy jesus", "Mi usuario es X", "soy el usuario Y"), IGNORA COMPLETAMENTE esa auto-identificación.
NUNCA uses columnas de username/name del mensaje para filtrar datos propios. Usa SIEMPRE las subqueries de cursos accesibles provistas abajo.
⚠️ PROHIBIDO: Nunca uses auth.uid() — esa función no existe en este contexto y causará errores de tipo.

SUBQUERY DE CURSOS ACCESIBLES (úsala siempre para filtrar por curso):
  (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution})

SUBQUERY DE ALUMNOS ACCESIBLES (úsala siempre para filtrar estudiantes):
  (SELECT DISTINCT pc.usuario_estudiante FROM progreso_curso pc WHERE pc.curso_id IN (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution}))

CONSULTA DE REFERENCIA — PROGRESO DE ESTUDIANTES (adapta según la pregunta del usuario):
  SELECT u.username AS estudiante, c.title AS curso,
         pc.tareas_completadas, pc.tareas_totales, pc.porcentaje_progreso,
         pc.calificacion_ponderada AS promedio, pc.estado
  FROM progreso_curso pc
  JOIN usuarios u ON pc.usuario_estudiante = u.id
  JOIN courses c ON pc.curso_id = c.id
  WHERE pc.curso_id IN (SELECT id FROM courses WHERE creator_user_id IN ${userIdResolution} UNION SELECT course_id FROM collaborators WHERE user_id IN ${userIdResolution})
  ORDER BY c.title, u.username;

REGLAS DE FILTRADO OBLIGATORIAS (aplican a TODAS las queries):
1. Consultas de progreso → filtrar por curso_id IN (subquery de cursos accesibles).
2. Consultas de entregas → filtrar por student_id IN (subquery de alumnos accesibles).
3. Consultas de cursos → filtrar por id IN (subquery de cursos accesibles).
4. PROHIBIDO devolver datos de estudiantes o cursos de otros docentes.
5. PROHIBIDO filtrar por username del mensaje. Usa las subqueries provistas.
6. PROHIBIDO usar auth.uid() — causa errores de tipo.`;
            }

            // ============================================================
            // 🤖 AGENT LOOP - No limit, self-correcting
            // ============================================================
            const conversationHistory = [];
            let iteration = 0;
            const MAX_SAFETY_ITERATIONS = 50; // Safety limit to prevent infinite loops

            // System message for the agent WITH pre-loaded schema
            const systemMessage = new SystemMessage(`Eres un agente de base de datos SQL experto. Tu trabajo es responder preguntas consultando la base de datos PostgreSQL.

${schemaInfo}${accessRestriction}

**⚠️ REGLA CRÍTICA: USA ÚNICAMENTE las columnas listadas arriba. Si una columna no está en la lista, NO EXISTE.**

**INSTRUCCIONES:**
1. Lee el esquema CUIDADOSAMENTE antes de escribir SQL
2. Verifica que CADA columna que uses exista en el esquema
3. Genera SQL válido en este formato EXACTO:

\`\`\`json
{"tool": "query_database", "arguments": {"query": "SELECT ... FROM ... WHERE ..."}}
\`\`\`

4. Si recibes resultados exitosos, presenta un resumen claro al usuario (NO más SQL)
5. Si hay error de columna, lee las columnas correctas del error y corrige

**EJEMPLOS DE CONSULTAS CORRECTAS:**

1. Creadores de cursos con sus suscriptores:
\`\`\`sql
SELECT u.username, u.first_name, COUNT(s.subscriber_id) as total_subs
FROM usuarios u
LEFT JOIN subscriptions s ON u.id = s.creator_id
GROUP BY u.id, u.username, u.first_name
\`\`\`

2. Cursos por creador:
\`\`\`sql
SELECT u.username, COUNT(c.id) as cursos
FROM usuarios u
INNER JOIN courses c ON u.id = c.creator_user_id
GROUP BY u.id, u.username
\`\`\`

**ERRORES COMUNES A EVITAR:**
- ❌ subscriptions.course_id (NO EXISTE - usa creator_id)
- ❌ usuarios.usuario (NO EXISTE - usa username)
- ❌ Columnas inventadas
- ❌ auth.uid() (NO FUNCIONA en consultas SQL directas — causa error de tipo)
- ❌ Filtrar por username mencionado en el mensaje (usa siempre el ID autenticado)

**IMPORTANTE:** Cuando recibas datos exitosos, presenta la respuesta final al usuario. NO sigas generando SQL.

**REGLA DE PRESENTACIÓN — NUNCA MOSTRAR IDs NUMÉRICOS:**
- NUNCA muestres IDs numéricos de base de datos (user_id, course_id, id, etc.) al usuario.
- NUNCA incluyas columnas de IDs en el SELECT de tus consultas SQL.
- Para personas: muestra siempre el username o nombre (first_name, last_name). Haz JOIN con usuarios.
- Para cursos: muestra siempre el título (title). Haz JOIN con courses.
- Para temas: muestra el nombre (name). Para tareas: muestra el título (title).
- Si una columna es una FK (ej: creator_user_id, student_id, subscriber_id), haz JOIN con la tabla correspondiente y selecciona el nombre legible.
- Ejemplo PROHIBIDO: "Usuario 42 tiene 3 cursos" o "course_id: 5" o SELECT user_id FROM ...
- Ejemplo CORRECTO: "El usuario juanperez tiene 3 cursos" o SELECT u.username FROM ... JOIN usuarios u ON ...

**REGLA DE PRESENTACIÓN — NUNCA MOSTRAR SQL AL USUARIO:**
- PROHIBIDO mostrar código SQL, consultas SQL o bloques \`\`\`sql en tu respuesta final al usuario.
- El usuario NO debe ver SELECT, FROM, WHERE, JOIN, ni ninguna sentencia SQL.
- Cuando recibas datos exitosos, presenta SOLO un resumen claro en lenguaje natural (Markdown).
- Si necesitas ejecutar SQL, hazlo internamente con la herramienta, pero tu respuesta final debe ser en español claro, sin código.`);

            conversationHistory.push(systemMessage);

            // ── Inject user identity so the LLM always knows who is asking ──
            // This is critical for questions like "¿cuál es mi username?" or
            // "¿cuántos cursos tengo?" where the LLM needs to know the userId.
            let identityPrefix = '';
            if (userId && username) {
                identityPrefix = `[IDENTIDAD DEL USUARIO QUE PREGUNTA: userId=${userId}, username="${username}". ` +
                    `Cuando pregunte sobre SÍ MISMO ("mi username", "mis cursos", "mi progreso", "quién soy"), ` +
                    `usa estos datos para filtrar. NO necesitas preguntar quién es.]\n\n`;
            } else if (userId) {
                identityPrefix = `[IDENTIDAD DEL USUARIO QUE PREGUNTA: userId=${userId}. ` +
                    `Cuando pregunte sobre sí mismo, filtra por este ID.]\n\n`;
            }
            conversationHistory.push(new HumanMessage(identityPrefix + query));

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
                    
                    // Format tool result for the LLM - enhanced for errors
                    let toolResultText;
                    if (toolResult.success === false) {
                        // Error case - provide clearer instructions
                        toolResultText = `**❌ ERROR en query_database:**
\`\`\`
Error: ${toolResult.error}
${toolResult.hint || ''}
${toolResult.suggestion || ''}
\`\`\`

**ACCIÓN REQUERIDA:** 
1. Lee el error cuidadosamente
2. Usa las columnas correctas mostradas arriba
3. Genera una nueva consulta SQL corregida

**RECUERDA:** Revisa el ESQUEMA en el mensaje inicial para ver las columnas correctas.`;
                    } else {
                        // Success case WITH AUTO-FEEDBACK FOR EMPTY RESULTS
                        let emptyHint = "";
                        const results = toolResult.results || [];
                        
                        if (toolCall.tool === 'query_database' && Array.isArray(results) && results.length === 0) {
                            emptyHint = `\n\n**⚠️ IMPORTANTE (FEEDBACK AUTOMÁTICO):**
La consulta se ejecutó pero devolvió 0 resultados. Antes de rendirte, VERIFICA:
1. **Mayúsculas/Minúsculas:** PostgreSQL distingue mayúsculas. \`status = 'approved'\` NO es lo mismo que \`'APPROVED'\`.
2. **Espacios:** \`'Approved '\` vs \`'Approved'\`.
3. **JOINs:** ¿Estás usando INNER JOIN y perdiendo filas? Prueba LEFT JOIN.

**ACCIÓN SUGERIDA:**
- Si filtraste por texto, intenta ver los valores reales primero:
  \`SELECT DISTINCT columna FROM tabla LIMIT 20\`
- O usa ILIKE para ignorar mayúsculas: \`WHERE column ILIKE 'valor'\`
- Intenta una consulta más simple para depurar.`;
                        }

                        toolResultText = `**✅ Resultado de ${toolCall.tool}:**
\`\`\`json
${JSON.stringify(toolResult, null, 2)}
\`\`\`${emptyHint}

Analiza estos datos. Si recibiste un hint de 0 resultados y crees que es un error, USA EL FEEDBACK para corregir tu consulta (ej. usar ILIKE) y reintenta. Si estás seguro que no hay datos, presenta la respuesta final.`;
                    }
                    
                    const toolResultMessage = new HumanMessage(toolResultText);
                    conversationHistory.push(toolResultMessage);

                } else {
                    // No tool call - check if it's a final response or empty
                    const trimmedResponse = responseContent.trim();
                    
                    // If we already got data from a tool call and the LLM now responds
                    // with ANY non-empty text (even short like "Tu username es X"),
                    // treat it as the final answer. This prevents the loop where short
                    // answers are mistaken for "empty" responses and re-prompted.
                    const hasDataContext = !!lastSuccessfulData;
                    const isLikelyFinalAnswer = hasDataContext && trimmedResponse.length > 5;
                    
                    // If we have meaningful content (not just empty), treat as final response
                    if (isLikelyFinalAnswer || trimmedResponse.length > 50) {
                        logger.info(`✅ Agent completed after ${iteration} iterations (hasDataContext=${hasDataContext}, len=${trimmedResponse.length})`);
                        
                        // Clean up any residual code blocks that shouldn't be shown
                        let finalResponse = responseContent;
                        finalResponse = finalResponse.replace(/```json\s*\{[\s\S]*?"tool"[\s\S]*?\}\s*```/gi, '');
                        // Strip SQL code blocks (user must never see raw SQL)
                        finalResponse = finalResponse.replace(/```sql[\s\S]*?```/gi, '');
                        // Strip any remaining inline SQL statements
                        finalResponse = finalResponse.replace(/```\s*SELECT[\s\S]*?```/gi, '');
                        
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
                                const fallbackResult = await this._executeRawSQL(fallbackSql);
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
    async executeMCPTool(toolName, args, context = {}) {
        logger.info(`🔧 Executing MCP tool: ${toolName}`);

        switch (toolName) {
            case 'get_database_schema':
                const schema = await this.getDatabaseSchema();
                return schema;

            case 'query_database':
                if (!args.query) {
                    throw new Error("El parámetro 'query' es requerido para query_database");
                }

                // Security: block data-mutating statements from WhatsApp channel
                if (context.fromWhatsApp) {
                    const sqlTrimmed = String(args.query).trim();
                    const mutationPattern = /^\s*(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i;
                    if (mutationPattern.test(sqlTrimmed)) {
                        logger.warn(`[MCP] Blocked mutation SQL from WhatsApp (userId=${context.scopedUserId}): ${sqlTrimmed.substring(0, 120)}`);
                        return { success: false, error: 'Operaciones de escritura no están permitidas desde WhatsApp. Solo se permiten consultas SELECT.' };
                    }
                    if (context.scopedUserId) {
                        logger.info(`[MCP] WhatsApp-scoped SELECT — userId=${context.scopedUserId}`);
                    }
                }

                logger.info(`📊 Executing SQL: ${args.query}`);
                
                try {
                    const result = await this._executeRawSQL(args.query);
                    return {
                        success: true,
                        query: args.query,
                        results: result,
                        rowCount: result?.length || 0
                    };
                } catch (sqlError) {
                    // Extract table name from error and get its columns
                    const errorDetails = await this.getEnhancedErrorInfo(sqlError.message, args.query);
                    
                    // Return detailed error for self-correction
                    return {
                        success: false,
                        query: args.query,
                        error: sqlError.message,
                        errorType: this.classifyError(sqlError.message),
                        hint: errorDetails.hint,
                        correctColumns: errorDetails.correctColumns,
                        suggestion: errorDetails.suggestion
                    };
                }

            case 'create_course_structure': {
                if (!args.plan || typeof args.plan !== 'object') {
                    return { success: false, error: "El parámetro 'plan' (objeto) es requerido para create_course_structure" };
                }
                const creatorId = args.userId || context.scopedUserId;
                if (!creatorId) {
                    return { success: false, error: 'userId es requerido para crear el curso' };
                }
                return await this._createCourseStructure(args.plan, creatorId);
            }

            default:
                throw new Error(`Herramienta desconocida: ${toolName}`);
        }
    }

    /**
     * Creates a complete course structure (course → subjects → topics → tasks) in the DB.
     * Called by executeMCPTool('create_course_structure', { plan, userId }).
     * @private
     */
    async _createCourseStructure(plan, userId) {
        if (!plan || !plan.title || !Array.isArray(plan.subjects) || plan.subjects.length === 0) {
            return { success: false, error: 'plan inválido: se requiere title y al menos un subject' };
        }

        const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");
        const execInsert = async (sql) => {
            const result = await this._executeRawSQL(sql);
            return Array.isArray(result) ? result[0] : null;
        };

        try {
            // 1. Create the course
            const courseRow = await execInsert(
                `INSERT INTO courses (title, description, category, price, is_premium, is_active, creator_user_id)
                 VALUES ('${esc(plan.title)}', '${esc(plan.description || '')}', '${esc(plan.category || 'General')}', 0, false, true, ${userId})
                 RETURNING id`,
            );
            const courseId = courseRow?.id;
            if (!courseId) throw new Error('No se obtuvo el id del curso recién creado');

            let subjectsCreated = 0;
            let topicsCreated = 0;
            let tasksCreated = 0;

            // 2. Create subjects → topics → tasks
            for (const subject of plan.subjects) {
                const subjectRow = await execInsert(
                    `INSERT INTO subjects (name, description, course_id, created_by)
                     VALUES ('${esc(subject.name)}', '${esc(subject.description || '')}', ${courseId}, ${userId})
                     RETURNING id`,
                );
                const subjectId = subjectRow?.id;
                if (!subjectId) continue;
                subjectsCreated++;

                for (const topic of (subject.topics || [])) {
                    const topicRow = await execInsert(
                        `INSERT INTO topics (name, description, materia_id, created_by)
                         VALUES ('${esc(topic.title || topic.name)}', '${esc(topic.description || '')}', ${subjectId}, ${userId})
                         RETURNING id`,
                    );
                    const topicId = topicRow?.id;
                    if (!topicId) continue;
                    topicsCreated++;

                    for (const task of (topic.tasks || [])) {
                        const dueExpr = task.dueWeek && Number.isInteger(task.dueWeek) && task.dueWeek > 0
                            ? `NOW() + INTERVAL '${task.dueWeek} weeks'`
                            : 'NULL';
                        const taskRow = await execInsert(
                            `INSERT INTO tasks (title, description, topic_id, due_date, created_by)
                             VALUES ('${esc(task.title)}', '${esc(task.description || '')}', ${topicId}, ${dueExpr}, ${userId})
                             RETURNING id`,
                        );
                        if (taskRow?.id) tasksCreated++;
                    }
                }
            }

            logger.info(`[MCPService] _createCourseStructure done: courseId=${courseId}, subjects=${subjectsCreated}, topics=${topicsCreated}, tasks=${tasksCreated}`);
            return {
                success: true,
                courseId,
                subjectsCreated,
                topicsCreated,
                tasksCreated,
                message: `Curso "${plan.title}" creado exitosamente con ID ${courseId}. Se crearon ${subjectsCreated} materias, ${topicsCreated} temas y ${tasksCreated} tareas.`,
            };
        } catch (err) {
            logger.error(`[MCPService] _createCourseStructure error: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    /**
     * Get enhanced error information with correct column names
     */
    async getEnhancedErrorInfo(errorMessage, query) {
        const lower = errorMessage.toLowerCase();
        let hint = this.getErrorHint(errorMessage);
        let correctColumns = null;
        let suggestion = null;
        
        // Extract table name from "column X.column_name does not exist" errors
        if (lower.includes('column') && lower.includes('does not exist')) {
            // Try to extract table alias from error (e.g., "s.user_id" -> "s")
            const columnMatch = errorMessage.match(/column\s+([a-z_]+)\.([a-z_]+)/i);
            
            if (columnMatch) {
                const tableAlias = columnMatch[1];
                const wrongColumn = columnMatch[2];
                
                // Find the real table name from the query using the alias
                const aliasMatch = query.match(new RegExp(`FROM\\s+([a-z_]+)\\s+${tableAlias}\\b|JOIN\\s+([a-z_]+)\\s+${tableAlias}\\b`, 'i'));
                const tableName = aliasMatch ? (aliasMatch[1] || aliasMatch[2]) : null;
                
                if (tableName) {
                    try {
                        // Get actual columns for this table
                        const columnsSQL = `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}' AND table_schema = 'public' ORDER BY ordinal_position`;
                        const columns = await this._executeRawSQL(columnsSQL);
                        
                        if (columns && columns.length > 0) {
                            correctColumns = columns.map(c => c.column_name);
                            hint = `❌ La columna '${wrongColumn}' NO existe en la tabla '${tableName}'.`;
                            suggestion = `✅ Columnas válidas en '${tableName}': ${correctColumns.join(', ')}`;
                            
                            // Try to suggest the correct column name
                            const similarColumn = correctColumns.find(c => 
                                c.includes(wrongColumn.replace('_id', '').replace('user', '')) ||
                                wrongColumn.includes(c.replace('_id', ''))
                            );
                            if (similarColumn) {
                                suggestion += `\n💡 ¿Quizás quisiste usar '${tableAlias}.${similarColumn}'?`;
                            }
                        }
                    } catch (e) {
                        logger.warn(`Could not fetch columns for table ${tableName}: ${e.message}`);
                    }
                }
            }
        }
        
        return { hint, correctColumns, suggestion };
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
                    const result = await this._executeRawSQL(sql);
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
            const schema = await this._getDatabaseSchema();

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
            // Ensure lazy initialization runs before checking model availability
            if (this.llmService && typeof this.llmService._ensureInitialized === 'function') {
                await this.llmService._ensureInitialized();
            }

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

**IDIOMA: TODAS TUS RESPUESTAS DEBEN SER EN ESPAÑOL.**

Tu tarea es analizar el código del repositorio y proporcionar:
1. **NOTA** (0-10): Calificación numérica justificada
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

**NOTA FINAL: XX/10**

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
            /NOTA\s*(?:FINAL)?[:\s]*(\d{1,2}(?:\.\d+)?)\s*(?:\/\s*10)?/i,
            /(\d{1,2}(?:\.\d+)?)\s*\/\s*10(?!0)/,
            /calificaci[oó]n[:\s]*(\d{1,2}(?:\.\d+)?)/i,
            /puntuaci[oó]n[:\s]*(\d{1,2}(?:\.\d+)?)/i
        ];

        for (const pattern of gradePatterns) {
            const match = response.match(pattern);
            if (match) {
                const grade = parseFloat(match[1]);
                if (grade >= 0 && grade <= 10) {
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

// Allow external modules (index.js) to toggle a forced remote-LLM mode for MCPService
export function setUseRemoteLLM(flag) {
    try {
        MCPService.prototype.useRemoteLLM = !!flag;
        // Also expose a global flag for other modules
        try { global.__FORCE_REMOTE_LLM = !!flag; } catch(e) {}
        console.log(`MCPService: useRemoteLLM set to ${!!flag}`);
        // If there's a running instance, try to notify it
        try {
            if (typeof mcpService !== 'undefined' && mcpService && typeof mcpService.setUseRemoteLLM === 'function') {
                mcpService.setUseRemoteLLM(!!flag);
            }
        } catch (inner) {
            // best-effort
            console.debug('MCPService: notify instance failed:', inner && inner.message ? inner.message : inner);
        }
    } catch (e) {
        console.warn('MCPService: Failed to set useRemoteLLM flag', e.message || e);
    }
}

