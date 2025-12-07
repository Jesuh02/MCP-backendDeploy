/**
 * Supabase Service
 * Handles all database operations with Supabase
 * Implements singleton pattern for connection reuse
 */

import { createClient } from '@supabase/supabase-js';
import { logger } from '../logging/Logger.js';

export class SupabaseService {
    static instance = null;

    constructor() {
        if (SupabaseService.instance) {
            return SupabaseService.instance;
        }

        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

        if (!supabaseUrl || !supabaseKey) {
            throw new Error('Supabase credentials not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env');
        }

        this.client = createClient(supabaseUrl, supabaseKey, {
            auth: {
                autoRefreshToken: true,
                persistSession: false
            }
        });

        SupabaseService.instance = this;
    }

    static getInstance() {
        if (!SupabaseService.instance) {
            SupabaseService.instance = new SupabaseService();
        }
        return SupabaseService.instance;
    }

    /**
     * Test database connection
     */
    async testConnection() {
        try {
            const { data, error } = await this.client
                .from('usuarios')
                .select('count')
                .limit(1);

            if (error) throw error;

            logger.info('✅ Supabase connection test successful');
            return true;
        } catch (error) {
            logger.error('❌ Supabase connection test failed:', error);
            throw error;
        }
    }

    /**
     * Get database schema information dynamically (Cached)
     */
    async getDatabaseSchema() {
        // Return cached schema if available (valid for 1 hour)
        if (this.schemaCache && this.schemaCacheTime && (Date.now() - this.schemaCacheTime < 3600000)) {
            logger.info('⚡ Using cached database schema');
            return this.schemaCache;
        }

        try {
            logger.info('Fetching dynamic database schema...');

            // 1. Fetch Tables and Columns
            const columnsQuery = `
                SELECT 
                    table_name, 
                    column_name, 
                    data_type, 
                    is_nullable
                FROM 
                    information_schema.columns
                WHERE 
                    table_schema = 'public'
                ORDER BY 
                    table_name, ordinal_position
            `;

            const columnsData = await this.executeRawSQL(columnsQuery);

            if (!columnsData || !Array.isArray(columnsData) || columnsData.length === 0) {
                throw new Error("Could not retrieve columns metadata");
            }

            // 2. Fetch Foreign Keys
            const fkQuery = `
                SELECT
                    tc.table_name, 
                    kcu.column_name, 
                    ccu.table_name AS foreign_table_name,
                    ccu.column_name AS foreign_column_name 
                FROM 
                    information_schema.table_constraints AS tc 
                JOIN 
                    information_schema.key_column_usage AS kcu
                      ON tc.constraint_name = kcu.constraint_name
                      AND tc.table_schema = kcu.table_schema
                JOIN 
                    information_schema.constraint_column_usage AS ccu
                      ON ccu.constraint_name = tc.constraint_name
                      AND ccu.table_schema = tc.table_schema
                WHERE 
                    tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema='public'
            `;

            let fkData = [];
            try {
                fkData = await this.executeRawSQL(fkQuery);
            } catch (e) {
                logger.warn('Could not fetch foreign keys dynamically:', e.message);
            }

            // 3. Format as DDL-like string
            const tables = {};
            columnsData.forEach(row => {
                if (!tables[row.table_name]) tables[row.table_name] = [];
                tables[row.table_name].push(row);
            });

            let schemaString = "-- DYNAMICALLY GENERATED SCHEMA (Real-time) --\n";
            schemaString += "-- This schema is fetched directly from Supabase information_schema\n\n";

            for (const [tableName, cols] of Object.entries(tables)) {
                schemaString += `CREATE TABLE public.${tableName} (\n`;
                const colDefs = cols.map(col => {
                    let def = `  ${col.column_name} ${col.data_type}`;
                    if (col.is_nullable === 'NO') def += ' NOT NULL';
                    return def;
                });

                if (fkData && Array.isArray(fkData)) {
                    const tableFks = fkData.filter(fk => fk.table_name === tableName);
                    tableFks.forEach(fk => {
                        colDefs.push(`  CONSTRAINT fk_${tableName}_${fk.column_name} FOREIGN KEY (${fk.column_name}) REFERENCES public.${fk.foreign_table_name}(${fk.foreign_column_name})`);
                    });
                }

                schemaString += colDefs.join(',\n');
                schemaString += "\n);\n\n";
            }

            // Cache the result
            this.schemaCache = schemaString;
            this.schemaCacheTime = Date.now();

            return schemaString;

        } catch (error) {
            logger.error('Error fetching dynamic schema:', error);
            return this.getStaticFallbackSchema();
        }
    }

    getStaticFallbackSchema() {
        return `
-- WARNING: This is a FALLBACK schema. Dynamic fetch failed.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.chat_messages (
  id bigint NOT NULL DEFAULT nextval('chat_messages_id_seq'::regclass),
  message text NOT NULL,
  is_from_user boolean DEFAULT false,
  timestamp bigint,
  session_id text,
  has_calification boolean DEFAULT false,
  calification_value text,
  calification_added boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  usuario_id bigint,
  username text,
  is_typing boolean DEFAULT false,
  is_error boolean DEFAULT false,
  is_graph_response boolean DEFAULT false,
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id),
  CONSTRAINT fk_chat_messages_usuario FOREIGN KEY (usuario_id) REFERENCES public.usuarios(id)
);
CREATE TABLE public.content_items (
  id bigint NOT NULL DEFAULT nextval('content_items_id_seq'::regclass),
  topic_id bigint,
  title text NOT NULL,
  body text,
  content_type text,
  created_at timestamp with time zone DEFAULT now(),
  creator_usuario_id bigint,
  creator_username text,
  order_index integer DEFAULT 0,
  task_id bigint,
  CONSTRAINT content_items_pkey PRIMARY KEY (id),
  CONSTRAINT fk_content_items_task FOREIGN KEY (task_id) REFERENCES public.tasks(id)
);
CREATE TABLE public.courses (
  id bigint NOT NULL DEFAULT nextval('courses_id_seq'::regclass),
  title text NOT NULL,
  description text,
  thumbnail_uri text,
  video_uri text,
  local_file_path text,
  duration text,
  category text,
  price numeric DEFAULT 0,
  is_premium boolean DEFAULT false,
  is_published boolean DEFAULT true,
  creation_date text,
  last_modified_date text,
  enrollment_count integer DEFAULT 0,
  rating real DEFAULT 0,
  tags text,
  timestamp bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint,
  created_at timestamp with time zone DEFAULT now(),
  creator_user_id bigint NOT NULL,
  CONSTRAINT courses_pkey PRIMARY KEY (id),
  CONSTRAINT fk_courses_creator_user FOREIGN KEY (creator_user_id) REFERENCES public.usuarios(id)
);
CREATE TABLE public.file_contexts (
  id bigint NOT NULL DEFAULT nextval('file_contexts_id_seq'::regclass),
  submission_id bigint,
  file_name text,
  file_type text,
  file_content text,
  extracted_text text,
  metadata text,
  content_summary text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT file_contexts_pkey PRIMARY KEY (id),
  CONSTRAINT file_contexts_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES public.task_submissions(id)
);
CREATE TABLE public.personas (
  id bigint NOT NULL DEFAULT nextval('personas_id_seq'::regclass),
  identificacion text NOT NULL,
  nombres text NOT NULL,
  apellidos text NOT NULL,
  email text NOT NULL,
  telefono text NOT NULL,
  direccion text,
  fechaNacimiento text,
  avatar text,
  esUsuario boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT personas_pkey PRIMARY KEY (id)
);
CREATE TABLE public.progreso_estudiante (
  curso_id bigint NOT NULL,
  tareas_completadas integer DEFAULT 0,
  tareas_totales integer DEFAULT 0,
  porcentaje_progreso real DEFAULT 0,
  calificacion_ponderada real,
  estado text DEFAULT 
CASE
    WHEN (COALESCE(calificacion_ponderada, (0)::real) >= (6)::double precision) THEN 'Ganado'::text
    ELSE 'Perdido'::text
END,
  ultima_calculada_en timestamp with time zone DEFAULT now(),
  certificado_emitido_en timestamp with time zone,
  creado_en timestamp with time zone DEFAULT now(),
  promedio real,
  usuario_estudiante bigint NOT NULL,
  CONSTRAINT progreso_estudiante_pkey PRIMARY KEY (usuario_estudiante, curso_id),
  CONSTRAINT progreso_estudiante_curso_id_fkey FOREIGN KEY (curso_id) REFERENCES public.courses(id)
);
CREATE TABLE public.recursos (
  id bigint NOT NULL DEFAULT nextval('recursos_id_seq'::regclass),
  nombre text NOT NULL,
  icono text NOT NULL,
  orden integer NOT NULL,
  padre_id bigint,
  interfaz text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT recursos_pkey PRIMARY KEY (id),
  CONSTRAINT recursos_padre_id_fkey FOREIGN KEY (padre_id) REFERENCES public.recursos(id)
);
CREATE TABLE public.rol_recursos (
  rol_id bigint NOT NULL,
  recurso_id bigint NOT NULL,
  CONSTRAINT rol_recursos_pkey PRIMARY KEY (rol_id, recurso_id),
  CONSTRAINT rol_recursos_rol_id_fkey FOREIGN KEY (rol_id) REFERENCES public.roles(id),
  CONSTRAINT rol_recursos_recurso_id_fkey FOREIGN KEY (recurso_id) REFERENCES public.recursos(id)
);
CREATE TABLE public.roles (
  id bigint NOT NULL DEFAULT nextval('roles_id_seq'::regclass),
  nombre text NOT NULL UNIQUE,
  nivel real NOT NULL,
  default boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT roles_pkey PRIMARY KEY (id)
);
CREATE TABLE public.subscriptions (
  subscription_date bigint,
  created_at timestamp with time zone DEFAULT now(),
  subscriber_id bigint NOT NULL,
  creator_id bigint NOT NULL,
  CONSTRAINT subscriptions_pkey PRIMARY KEY (subscriber_id, creator_id),
  CONSTRAINT subscriptions_subscriber_id_fkey FOREIGN KEY (subscriber_id) REFERENCES public.usuarios(id),
  CONSTRAINT subscriptions_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.usuarios(id)
);
CREATE TABLE public.task_submissions (
  id bigint NOT NULL DEFAULT nextval('task_submissions_id_seq'::regclass),
  task_id bigint,
  file_uri text,
  file_name text,
  submission_date bigint,
  grade real,
  feedback text,
  created_at timestamp with time zone DEFAULT now(),
  student_id integer,
  CONSTRAINT task_submissions_pkey PRIMARY KEY (id),
  CONSTRAINT task_submissions_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id),
  CONSTRAINT fk_task_submissions_student_id FOREIGN KEY (student_id) REFERENCES public.usuarios(id)
);
CREATE TABLE public.tasks (
  id bigint NOT NULL DEFAULT nextval('tasks_id_seq'::regclass),
  topic_id bigint,
  title text NOT NULL,
  description text,
  due_date timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT tasks_pkey PRIMARY KEY (id),
  CONSTRAINT tasks_topic_id_fkey FOREIGN KEY (topic_id) REFERENCES public.topics(id)
);
CREATE TABLE public.topics (
  id bigint NOT NULL DEFAULT nextval('topics_id_seq'::regclass),
  course_id bigint,
  name text NOT NULL,
  description text,
  order_index integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT topics_pkey PRIMARY KEY (id),
  CONSTRAINT topics_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id)
);
CREATE TABLE public.usuarios (
  id bigint NOT NULL DEFAULT nextval('usuarios_id_seq'::regclass),
  usuario text NOT NULL UNIQUE,
  contrasena text NOT NULL,
  persona_id bigint,
  rol_id integer DEFAULT 1,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT usuarios_pkey PRIMARY KEY (id),
  CONSTRAINT fk_usuarios_rol FOREIGN KEY (rol_id) REFERENCES public.roles(id),
  CONSTRAINT fk_usuarios_persona FOREIGN KEY (persona_id) REFERENCES public.personas(id),
  CONSTRAINT usuarios_persona_id_fkey FOREIGN KEY (persona_id) REFERENCES public.personas(id)
);
CREATE TABLE public.videos (
  id bigint NOT NULL DEFAULT nextval('videos_id_seq'::regclass),
  description text,
  title text NOT NULL,
  video_uri_string text,
  local_file_path text,
  timestamp bigint,
  is_paid boolean DEFAULT false,
  thumbnail_uri text,
  price numeric,
  created_at timestamp with time zone DEFAULT now(),
  remote_id bigint,
  course_id bigint,
  CONSTRAINT videos_pkey PRIMARY KEY (id),
  CONSTRAINT videos_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id)
);
`;
    }

    /**
     * Execute RAG query with vector similarity search
     */
    async executeRAGQuery(query, topK = 5) {
        try {
            // Call the vector search RPC function
            const { data, error } = await this.client
                .rpc('search_knowledge_base', {
                    query_text: query,
                    match_threshold: 0.7,
                    match_count: topK
                });

            if (error) throw error;

            return data || [];
        } catch (error) {
            logger.error('RAG query error:', error);
            return [];
        }
    }

    /**
     * Get context for specific tables
     */
    async getTableContext(tableName, filters = {}, limit = 100) {
        try {
            let query = this.client
                .from(tableName)
                .select('*')
                .limit(limit);

            // Apply filters
            for (const [key, value] of Object.entries(filters)) {
                if (value !== undefined && value !== null) {
                    query = query.eq(key, value);
                }
            }

            const { data, error } = await query;

            if (error) throw error;

            return data || [];
        } catch (error) {
            logger.error(`Error fetching ${tableName}:`, error);
            return [];
        }
    }

    /**
     * Get all data from a specific table with pagination
     */
    async getTableData(tableName, page = 1, pageSize = 50) {
        try {
            const from = (page - 1) * pageSize;
            const to = from + pageSize - 1;

            const { data, error, count } = await this.client
                .from(tableName)
                .select('*', { count: 'exact' })
                .range(from, to);

            if (error) throw error;

            return {
                data: data || [],
                total: count || 0,
                page,
                pageSize,
                totalPages: Math.ceil((count || 0) / pageSize)
            };
        } catch (error) {
            logger.error(`Error fetching ${tableName} data:`, error);
            throw error;
        }
    }

    /**
     * Insert data into knowledge base for RAG
     */
    async insertKnowledgeBase(content, metadata = {}) {
        try {
            const { data, error } = await this.client
                .from('knowledge_base')
                .insert([{
                    content,
                    metadata,
                    created_at: new Date().toISOString()
                }])
                .select();

            if (error) throw error;

            return data[0];
        } catch (error) {
            logger.error('Error inserting knowledge base:', error);
            throw error;
        }
    }

    /**
     * Get comprehensive database context for AI
     */
    async getComprehensiveContext(userQuery = '') {
        try {
            const schema = await this.getDatabaseSchema();

            // Build context string
            let context = '# TareaMov Database Context\n\n';
            context += '## Available Tables:\n\n';

            for (const [table, info] of Object.entries(schema)) {
                if (info.exists) {
                    context += `- **${table}**: ${info.count} records\n`;
                }
            }

            context += '\n## Critical Information:\n';
            context += '- **Valid Roles**: usuario, admin\n';
            context += '- **Primary Features**: Educational platform with courses, videos, tasks\n\n';

            // Add RAG results if query provided
            if (userQuery) {
                const ragResults = await this.executeRAGQuery(userQuery, 3);
                if (ragResults.length > 0) {
                    context += '## Relevant Information (from knowledge base):\n\n';
                    ragResults.forEach((result, index) => {
                        context += `${index + 1}. ${result.content}\n`;
                        context += `   (Similarity: ${(result.similarity * 100).toFixed(1)}%)\n\n`;
                    });
                }
            }

            return context;
        } catch (error) {
            logger.error('Error building comprehensive context:', error);
            throw error;
        }
    }

    /**
     * Health check for Supabase connection
     */
    async healthCheck() {
        try {
            const start = Date.now();
            await this.testConnection();
            const latency = Date.now() - start;

            return {
                status: 'healthy',
                latency: `${latency}ms`,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }

    /**
     * Execute raw SQL query using Supabase RPC
     * This allows executing arbitrary SQL queries
     * Note: Requires a Postgres function 'execute_sql' in your database
     * Or we parse simple SELECT queries and use PostgREST API
     */
    async executeRawSQL(sqlQuery) {
        try {
            logger.info(`Executing raw SQL: ${sqlQuery.substring(0, 100)}...`);

            // Remove trailing semicolon if present (common issue with RPC)
            if (sqlQuery.trim().endsWith(';')) {
                sqlQuery = sqlQuery.trim().slice(0, -1);
            }

            // 1. Try to execute via RPC 'execute_sql' (Preferred for complex queries)
            try {
                const { data, error } = await this.client.rpc('execute_sql', { query: sqlQuery });
                if (!error) {
                    logger.info('✅ Executed via RPC execute_sql');
                    return data;
                }

                // If error is a SQL syntax error (e.g. column missing), throw it immediately
                // so the LLM can self-correct. Only fallback if RPC itself is missing.
                if (error.code !== 'PGRST202' && !error.message.includes('function') && !error.message.includes('not found')) {
                    logger.warn(`RPC execute_sql failed with specific SQL error: ${error.message}`);
                    throw new Error(`SQL Error: ${error.message}`);
                }
            } catch (rpcError) {
                // If it was the specific SQL error we threw above, rethrow it
                if (rpcError.message.startsWith('SQL Error:')) {
                    throw rpcError;
                }
                // Fallback to parser only if RPC is missing
                logger.warn('RPC execute_sql not available, falling back to limited client-side parsing');
            }

            // 2. Fallback: Parse simple SELECT queries client-side
            // First, remove trailing semicolon if present
            let trimmedQuery = sqlQuery.trim();
            if (trimmedQuery.endsWith(';')) {
                trimmedQuery = trimmedQuery.slice(0, -1).trim();
            }

            const lowerTrimmedQuery = trimmedQuery.toLowerCase();

            // Match: SELECT ... FROM table_name ...
            const selectMatch = lowerTrimmedQuery.match(/^select\s+(.+?)\s+from\s+(\w+)(.*)$/i);

            if (selectMatch) {
                const columns = selectMatch[1].trim();
                const tableName = selectMatch[2].trim();
                let rest = selectMatch[3].trim();

                // Remove semicolon from rest as well
                if (rest.endsWith(';')) {
                    rest = rest.slice(0, -1).trim();
                }

                // Check for unsupported complex clauses in fallback mode
                if (rest.includes('join') || rest.includes('group by') || rest.includes('select') || rest.includes('(')) {
                    // Instead of blocking, we try to execute it anyway via RPC (which already failed) or throw a helpful error
                    throw new Error("Complex query failed via RPC and is not supported by client-side parser. Please simplify your query or check table/column names.");
                }

                // Build query using Supabase client
                let query = this.client.from(tableName);

                // Handle SELECT *
                if (columns === '*') {
                    query = query.select('*');
                } else {
                    // Clean columns (remove aliases like 'as x' because PostgREST doesn't support them in select())
                    // Also remove table prefixes like 'u.username' -> 'username'
                    const cleanColumns = columns.split(',').map(c => {
                        let col = c.trim().split(/\s+as\s+/i)[0]; // Remove alias
                        if (col.includes('.')) {
                            col = col.split('.')[1]; // Remove table prefix
                        }
                        return col;
                    }).join(',');
                    query = query.select(cleanColumns);
                }

                // Parse WHERE clause
                const whereMatch = rest.match(/where\s+(.+?)(?:order\s+by|limit|$)/i);
                if (whereMatch) {
                    let whereClause = whereMatch[1].trim();
                    if (whereClause.endsWith(';')) {
                        whereClause = whereClause.slice(0, -1).trim();
                    }

                    // Handle 'IS NULL'
                    const isNullMatch = whereClause.match(/(\w+)\s+is\s+null/i);
                    if (isNullMatch) {
                        query = query.is(isNullMatch[1], null);
                    }
                    // Handle 'IS NOT NULL'
                    else if (whereClause.match(/(\w+)\s+is\s+not\s+null/i)) {
                        const match = whereClause.match(/(\w+)\s+is\s+not\s+null/i);
                        query = query.not(match[1], 'is', null);
                    }
                    // Handle simple equality 'col = val'
                    else {
                        const eqMatch = whereClause.match(/(\w+)\s*=\s*([^\s;]+)/i);
                        if (eqMatch) {
                            const column = eqMatch[1];
                            let value = eqMatch[2];
                            value = value.replace(/^['"]|['"]$/g, '').replace(/;$/g, '').trim();

                            const lowerVal = String(value).toLowerCase();
                            let finalValue;
                            if (lowerVal === 'true') finalValue = true;
                            else if (lowerVal === 'false') finalValue = false;
                            else if (lowerVal === 'null') finalValue = null;
                            else {
                                const numValue = Number(value);
                                finalValue = isNaN(numValue) ? value : numValue;
                            }

                            query = query.eq(column, finalValue);
                        }
                    }
                }

                // Parse ORDER BY clause
                const orderByMatch = rest.match(/order\s+by\s+(\w+)(?:\s+(asc|desc))?/i);
                if (orderByMatch) {
                    const column = orderByMatch[1];
                    const direction = orderByMatch[2] ? orderByMatch[2].toLowerCase() : 'asc';
                    query = query.order(column, { ascending: direction === 'asc' });
                }

                // Parse LIMIT clause
                const limitMatch = rest.match(/limit\s+(\d+)/i);
                if (limitMatch) {
                    query = query.limit(parseInt(limitMatch[1]));
                }

                // Execute query
                const { data, error } = await query;

                if (error) {
                    logger.error('SQL execution error:', error);
                    throw error;
                }

                return data;
            }

            // If we can't parse it, throw error
            throw new Error('Complex SQL queries (JOIN, GROUP BY, SUBQUERIES) are NOT supported. You MUST retrieve raw data and perform aggregations/joins in your reasoning.');

        } catch (error) {
            logger.error('Error executing raw SQL:', error);
            throw error;
        }
    }
}

export default SupabaseService;