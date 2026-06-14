/**
 * Supabase Service
 * Handles all database operations with Supabase
 * Implements singleton pattern for connection reuse
 *
 * Auto-heals a misconfigured SUPABASE_URL by deriving the correct project URL
 * from the JWT `ref` claim in the service key. This prevents silent failures
 * when SUPABASE_URL does not match the actual project of the provided key.
 */

import { createClient } from '@supabase/supabase-js';
import { logger } from '../logging/Logger.js';
import { R2StorageAdapter } from '../../modules/storage/infrastructure/r2.storage.adapter.js';

/**
 * Decodes a Supabase JWT and returns the project ref claim (e.g. "abc123").
 * Returns null if the key is absent or cannot be decoded.
 */
function extractProjectRef(jwtKey) {
    if (!jwtKey) return null;
    try {
        const [, payload] = jwtKey.split('.');
        if (!payload) return null;
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return decoded.ref || null;
    } catch {
        return null;
    }
}

export class SupabaseService {
    static instance = null;

    constructor() {
        if (SupabaseService.instance) {
            return SupabaseService.instance;
        }

        const configuredUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

        if (!configuredUrl || !supabaseKey) {
            console.error('❌ Supabase credentials missing!');
            console.error('   Required environment variables:');
            console.error('   - SUPABASE_URL (current:', configuredUrl ? 'SET' : 'NOT SET', ')');
            console.error('   - SUPABASE_SERVICE_KEY or SUPABASE_KEY (current:', supabaseKey ? 'SET' : 'NOT SET', ')');
            console.error('   Configure these in Railway Dashboard > Variables');
            throw new Error('Supabase credentials not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY/SUPABASE_KEY in Railway environment variables');
        }

        // Auto-heal: the JWT service key's `ref` claim is the authoritative project identifier.
        // If SUPABASE_URL points to the wrong project, derive and use the correct URL instead.
        const derivedRef = extractProjectRef(supabaseKey);
        const derivedUrl = derivedRef ? `https://${derivedRef}.supabase.co` : null;
        const supabaseUrl = (derivedUrl && derivedUrl !== configuredUrl) ? derivedUrl : configuredUrl;

        if (supabaseUrl !== configuredUrl) {
            logger.warn(
                `[SupabaseService] SUPABASE_URL mismatch detected. ` +
                `Configured: ${configuredUrl}, derived from key: ${supabaseUrl}. ` +
                `Using derived URL. Update SUPABASE_URL in Railway to remove this warning.`,
            );
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
        // Return cached schema if available (valid for 6 hours - optimized for speed)
        if (this.schemaCache && this.schemaCacheTime && (Date.now() - this.schemaCacheTime < 21600000)) {
            logger.info('⚡ Using cached database schema (fast)');
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
  file_uri text,
  file_name text,
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
  order_index integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT tasks_pkey PRIMARY KEY (id),
  CONSTRAINT tasks_topic_id_fkey FOREIGN KEY (topic_id) REFERENCES public.topics(id)
);
CREATE TABLE public.topics (
  id bigint NOT NULL DEFAULT nextval('topics_id_seq'::regclass),
  name text NOT NULL,
  description text,
  order_index integer DEFAULT 0,
  materia_id bigint,
  subject_id bigint,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT topics_pkey PRIMARY KEY (id),
  CONSTRAINT fk_topics_materia FOREIGN KEY (materia_id) REFERENCES public.subjects(id),
  CONSTRAINT topics_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id)
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
     * Register or update an FCM token for a user
     * Supports multiple devices per user
     */
    async registerFCMToken(userId, token, deviceType = 'android') {
        try {
            const { data, error } = await this.client
                .from('user_fcm_tokens')
                .upsert({
                    user_id: userId,
                    token: token,
                    device_type: deviceType,
                    last_updated: new Date().toISOString()
                }, {
                    onConflict: 'user_id,token'
                })
                .select();

            if (error) throw error;

            logger.info(`✅ FCM token registered for user ${userId}`);
            return data;
        } catch (error) {
            logger.error('Error registering FCM token:', error);
            throw error;
        }
    }

    /**
     * Get all FCM tokens for a specific user
     */
    async getUserFCMTokens(userId) {
        try {
            const { data, error } = await this.client
                .from('user_fcm_tokens')
                .select('token')
                .eq('user_id', userId);

            if (error) throw error;

            return data.map(t => t.token);
        } catch (error) {
            logger.error(`Error fetching FCM tokens for user ${userId}:`, error);
            return [];
        }
    }

    /**
     * Remove invalid FCM tokens
     */
    async removeInvalidFCMTokens(tokens) {
        if (!tokens || tokens.length === 0) return;

        try {
            const { error } = await this.client
                .from('user_fcm_tokens')
                .delete()
                .in('token', tokens);

            if (error) throw error;

            logger.info(`🗑️ Removed ${tokens.length} invalid FCM tokens`);
        } catch (error) {
            logger.error('Error removing invalid FCM tokens:', error);
        }
    }

    /**
     * Match documents using vector similarity
     */
    async matchDocuments(embedding, matchThreshold = 0.7, matchCount = 5, filter = {}) {
        try {
            const { data, error } = await this.client
                .rpc('match_documents', {
                    query_embedding: embedding,
                    match_threshold: matchThreshold,
                    match_count: matchCount,
                    filter: filter
                });

            if (error) {
                // Fallback to search_knowledge_base if match_documents doesn't exist
                logger.warn('match_documents RPC failed, trying search_knowledge_base fallback...');
                return this.executeRAGQuery(null, matchCount, embedding);
            }

            return data || [];
        } catch (error) {
            logger.error('Error matching documents:', error);
            return [];
        }
    }

    /**
     * Execute RAG query with vector similarity search
     */
    async executeRAGQuery(query, topK = 5, embedding = null) {
        try {
            const rpcParams = {
                match_threshold: 0.7,
                match_count: topK
            };

            if (query) rpcParams.query_text = query;
            if (embedding) rpcParams.query_embedding = embedding;

            // Call the vector search RPC function
            const { data, error } = await this.client
                .rpc('search_knowledge_base', rpcParams);

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
    async insertKnowledgeBase(content, metadata = {}, embedding = null) {
        try {
            const payload = {
                content,
                metadata,
                created_at: new Date().toISOString(),
                course_id: metadata.courseId || metadata.course_id || null,
                topic_id: metadata.topicId || metadata.topic_id || null,
                task_id: metadata.taskId || metadata.task_id || null,
                content_item_id: metadata.contentItemId || metadata.content_item_id || null
            };

            if (embedding) {
                payload.embedding = embedding;
            }

            const { data, error } = await this.client
                .from('rag_documents')
                .insert([payload])
                .select();

            if (error) throw error;

            return data[0];
        } catch (error) {
            logger.error('Error inserting knowledge base (rag_documents):', error);
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
            let context = '# YisusCompany Database Context\n\n';
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

    // ============================================================
    // VIDEO CRUD OPERATIONS
    // ============================================================

    /**
     * Insert a new video record into the videos table
     * @param {Object} videoData - Video data to insert
     * @returns {Object} - Inserted video with generated ID
     */
    async insertVideo(videoData) {
        try {
            const {
                title,
                description,
                videoUriString,
                localFilePath,
                timestamp,
                isPaid,
                thumbnailUri,
                price,
                remoteId,
                courseId
            } = videoData;

            // Validate required fields
            if (!title) {
                throw new Error('Video title is required');
            }

            // If caller provided a base64 buffer, upload it to R2 first
            let uploaded = null;
            if (videoData.videoBase64) {
                try {
                    const buffer = Buffer.from(videoData.videoBase64, 'base64');
                    const originalFilename = videoData.originalFilename || `${title.replace(/\s+/g, '_')}.mp4`;
                    const contentType = videoData.contentType || 'video/mp4';
                    const r2 = new R2StorageAdapter();
                    uploaded = await r2.uploadBufferWithAutoKey(buffer, originalFilename, contentType, 'videos');
                    logger.info(`✅ Uploaded video to R2: ${uploaded.key}`);
                } catch (e) {
                    logger.error('❌ Failed uploading buffer to R2:', e);
                    throw e;
                }
            }

            // Build insert payload (snake_case for Postgres)
            const insertPayload = {
                title,
                description: description || null,
                // Prefer uploaded public URL when available
                video_uri_string: (uploaded && uploaded.publicUrl) ? uploaded.publicUrl : (videoUriString || null),
                // store the object key in local_file_path when uploaded to R2, otherwise use original
                local_file_path: (uploaded && uploaded.key) ? uploaded.key : (localFilePath || null),
                timestamp: timestamp || Date.now(),
                is_paid: isPaid || false,
                thumbnail_uri: thumbnailUri || null,
                price: price || null,
                remote_id: remoteId || null,
                course_id: courseId || null
            };

            logger.info(`📹 [SupabaseService] Inserting video: ${title}`);
            logger.info(`   Payload: ${JSON.stringify(insertPayload)}`);

            const { data, error } = await this.client
                .from('videos')
                .insert(insertPayload)
                .select()
                .single();

            if (error) {
                // Handle duplicate key gracefully
                if (error.code === '23505') {
                    logger.warn(`⚠️ Video already exists (duplicate key): ${title}`);
                    // Try to fetch existing video
                    const existing = await this.fetchVideoByTitleAndCourse(title, courseId);
                    if (existing) {
                        return existing;
                    }
                }
                logger.error(`❌ [SupabaseService] Insert video error:`, error);
                throw error;
            }

            logger.info(`✅ [SupabaseService] Video inserted successfully: ID=${data.id}`);
            // Ensure returned object has non-null description for clients
            if (data && (data.description === null || data.description === undefined)) {
                data.description = '';
            }
            return data;
        } catch (error) {
            logger.error('❌ [SupabaseService] insertVideo failed:', error);
            throw error;
        }
    }

    /**
     * Fetch video by title and course_id (for duplicate detection)
     * @param {string} title - Video title
     * @param {number|null} courseId - Course ID (optional)
     * @returns {Object|null} - Video record or null
     */
    async fetchVideoByTitleAndCourse(title, courseId = null) {
        try {
            let query = this.client
                .from('videos')
                .select('*')
                .eq('title', title);

            if (courseId !== null && courseId !== undefined) {
                query = query.eq('course_id', courseId);
            }

            const { data, error } = await query.limit(1).single();

            if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
                throw error;
            }

            return data || null;
        } catch (error) {
            logger.error('❌ [SupabaseService] fetchVideoByTitleAndCourse failed:', error);
            return null;
        }
    }

    /**
     * Update an existing video record
     * @param {number} videoId - Video ID to update
     * @param {Object} updateData - Fields to update
     * @returns {Object} - Updated video record
     */
    async updateVideo(videoId, updateData) {
        try {
            // Convert camelCase to snake_case
            const updatePayload = {};
            if (updateData.title !== undefined) updatePayload.title = updateData.title;
            if (updateData.description !== undefined) updatePayload.description = updateData.description;
            if (updateData.videoUriString !== undefined) updatePayload.video_uri_string = updateData.videoUriString;
            if (updateData.localFilePath !== undefined) updatePayload.local_file_path = updateData.localFilePath;
            if (updateData.isPaid !== undefined) updatePayload.is_paid = updateData.isPaid;
            if (updateData.thumbnailUri !== undefined) updatePayload.thumbnail_uri = updateData.thumbnailUri;
            if (updateData.price !== undefined) updatePayload.price = updateData.price;
            if (updateData.remoteId !== undefined) updatePayload.remote_id = updateData.remoteId;
            if (updateData.courseId !== undefined) updatePayload.course_id = updateData.courseId;

            const { data, error } = await this.client
                .from('videos')
                .update(updatePayload)
                .eq('id', videoId)
                .select()
                .single();

            if (error) throw error;

            logger.info(`✅ [SupabaseService] Video updated: ID=${videoId}`);
            return data;
        } catch (error) {
            logger.error('❌ [SupabaseService] updateVideo failed:', error);
            throw error;
        }
    }

    /**
     * Fetch video by ID
     * @param {number} videoId - Video ID
     * @returns {Object|null} - Video record or null
     */
    async fetchVideoById(videoId) {
        try {
            const { data, error } = await this.client
                .from('videos')
                .select('*')
                .eq('id', videoId)
                .single();

            if (error && error.code !== 'PGRST116') {
                throw error;
            }

            return data || null;
        } catch (error) {
            logger.error('❌ [SupabaseService] fetchVideoById failed:', error);
            return null;
        }
    }

    /**
     * Save generated questions to Supabase history
     * @param {Object} params - { userId, courseId, questions, sessionId }
     * @returns {Promise<void>}
     */
    async saveGeneratedQuestions({ userId, courseId, questions, sessionId = null }) {
        if (!questions || !Array.isArray(questions) || questions.length === 0) {
            logger.warn('⚠️ saveGeneratedQuestions called with no questions');
            return;
        }

        try {
            logger.info(`💾 Saving ${questions.length} questions to history (User: ${userId}, Course: ${courseId})`);

            // Lazy Load EmbeddingService to avoid circular dependency
            const EmbeddingService = (await
                import ('../../modules/ai/infrastructure/embedding.service.js')).EmbeddingService;
            const embeddingService = EmbeddingService.getInstance();
            if (!embeddingService.isReady()) {
                logger.warn('⚠️ EmbeddingService not ready in SupabaseService fallback.');
            }

            for (const q of questions) {
                // Ensure Embedding & Hash exist
                let qText = q.question || q.question_text || '';
                let qHash = q.question_hash;
                let qEmbed = q.question_embedding || q.embedding;

                // 1. Ensure Hash Exists
                if (!qHash && qText) {
                    try {
                        const crypto = await
                        import ('crypto');
                        qHash = crypto.createHash('sha256').update(qText.toLowerCase().trim()).digest('hex');
                    } catch (e) {
                        // Fallback to internal simple hash if crypto fails
                        logger.warn(`⚠️ Crypto import failed, using simple hash: ${e.message}`);
                        qHash = this._generateHash(qText);
                    }
                }

                // 2. Ensure Embedding Exists (Strict No-Null Policy)
                if ((!qEmbed || !Array.isArray(qEmbed) || qEmbed.length === 0) && qText) {
                    try {
                        // Attempt AI Embedding
                        if (embeddingService.isReady()) {
                            qEmbed = await embeddingService.embedQuery(qText);
                        }
                    } catch (e) {
                        logger.warn(`⚠️ AI Embedding failed: ${e.message}`);
                    }

                    // Fallback to Mathematical Embedding if AI failed
                    if (!qEmbed || !Array.isArray(qEmbed) || qEmbed.length === 0) {
                        logger.warn(`⚠️ Using Fallback Embedding for Question: "${qText.substring(0,20)}..."`);
                        qEmbed = embeddingService._fallbackEmbed(qText);
                    }
                }

                // CRITICAL SAFETY V2: Abort if embedding is STILL missing (should be impossible now)
                if (!qEmbed || !Array.isArray(qEmbed) || qEmbed.length === 0) {
                    logger.error(`❌ FATAL: Skipping question save - Embedding completely failed: "${qText.substring(0,25)}..."`);
                    continue;
                }

                // Ensure Hash is not null
                if (!qHash) {
                    qHash = this._generateHash(qText || 'unknown');
                }

                // 🔍 UNIQUENESS CHECK: Check if question with this hash already exists
                const { data: existingQ } = await this.client
                    .from('questions_history')
                    .select('id')
                    .eq('question_hash', qHash)
                    .maybeSingle();

                if (existingQ) {
                    logger.info(`♻️ Skipped duplicate question (Hash: ${qHash.substring(0,8)}...)`);
                    continue;
                }

                // 1. Insert Question
                const { data: qData, error: qError } = await this.client
                    .from('questions_history')
                    .insert({
                        user_id: userId,
                        course_id: courseId,
                        session_id: sessionId,
                        question_text: qText,
                        correct_index: q.correctIndex,
                        explanation: q.explanation,
                        question_embedding: qEmbed,
                        question_hash: qHash
                    })
                    .select('id')
                    .single();

                if (qError) {
                    logger.warn(`⚠️ Error saving question (SaveGeneratedQuestions): ${qError.message}`);
                    continue;
                }

                const questionId = qData.id;

                // 2. Insert Options
                if (q.options && Array.isArray(q.options)) {
                    // Generate embeddings for options if missing
                    let optEmbeds = q.option_embeddings || [];
                    if ((!optEmbeds || optEmbeds.length === 0) && embeddingService.isReady()) {
                        try {
                            const optTexts = q.options.map(o => (typeof o === 'object' ? (o.text || o.option_text) : String(o)));
                            optEmbeds = await embeddingService.embedDocuments(optTexts);
                        } catch (e) {
                            logger.warn(`⚠️ Failed to generate option embeddings: ${e.message}`);
                        }
                    }

                    const optionsPayload = q.options.map((optText, idx) => ({
                        question_id: questionId,
                        option_text: typeof optText === 'object' ? (optText.text || optText.option_text) : optText,
                        order_index: idx,
                        option_embedding: optEmbeds[idx] || embeddingService._fallbackEmbed(typeof optText === 'object' ? (optText.text || optText.option_text) : String(optText))
                    }));

                    const { error: oError } = await this.client
                        .from('question_options')
                        .insert(optionsPayload);

                    if (oError) {
                        logger.warn(`⚠️ Error saving options for question ${questionId}: ${oError.message}`);
                    }
                }
            }
            logger.info('✅ Questions history saved successfully (Fallback Method).');
        } catch (error) {
            logger.error('❌ Error in saveGeneratedQuestions:', error.message);
        }
    }

    _generateHash(str) {
        let hash = 0;
        if (str.length === 0) return hash.toString();
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0; // Convert to 32bit integer
        }
        return hash.toString();
    }

    /**
     * Delete a course and all related content
     * @param {number} courseId - Course ID
     * @returns {boolean} - True if successful
     */
    async deleteCourse(courseId) {
        try {
            logger.info(`🗑️ [SupabaseService] Deleting course: ${courseId}`);

            // Delete related records first to ensure referential integrity

            // 1. Delete student progress
            await this.client.from('progreso_materia').delete().eq('curso_id', courseId);
            await this.client.from('progreso_curso').delete().eq('curso_id', courseId);

            // 2. Delete videos associated with this course
            await this.client.from('videos').delete().eq('course_id', courseId);

            // 3. Topics and tasks via subjects
            const { data: subjects } = await this.client.from('subjects').select('id').eq('course_id', courseId);
            if (subjects && subjects.length > 0) {
                const subjectIds = subjects.map(s => s.id);
                const { data: topics } = await this.client.from('topics').select('id').in('materia_id', subjectIds);
                if (topics && topics.length > 0) {
                    const topicIds = topics.map(t => t.id);
                    if (topicIds.length > 0) {
                        await this.client.from('tasks').delete().in('topic_id', topicIds);
                        await this.client.from('topics').delete().in('id', topicIds);
                    }
                }
            }

            // 4. Finally delete the course
            const { error } = await this.client.from('courses').delete().eq('id', courseId);

            if (error) throw error;

            logger.info(`✅ [SupabaseService] Course deleted: ${courseId}`);
            return true;
        } catch (error) {
            logger.error(`❌ [SupabaseService] deleteCourse failed for ID ${courseId}:`, error);
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
            // Log the full query being executed
            logger.info(`🔍 Executing raw SQL...`);
            logger.info('📥 INPUT:', JSON.stringify({ query: sqlQuery }, null, 2));

            // Remove trailing semicolon if present (common issue with RPC)
            if (sqlQuery.trim().endsWith(';')) {
                sqlQuery = sqlQuery.trim().slice(0, -1);
            }

            // 1. Try to execute via RPC 'execute_sql' (Preferred for complex queries)
            try {
                const { data, error } = await this.client.rpc('execute_sql', { query: sqlQuery });
                if (!error) {
                    // Log the full output with query and results
                    logger.info('📤 OUTPUT:', JSON.stringify({
                        query: sqlQuery,
                        results: data,
                        rowCount: data ? data.length : 0
                    }, null, 2));
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

                // Complex queries (JOIN, GROUP BY, SUBQUERIES) should be handled by RPC execute_sql
                // If we reach here, it means RPC failed - provide a helpful error
                if (rest.includes('join') || rest.includes('group by') || rest.includes('select') || rest.includes('(')) {
                    // Log the complex query for debugging
                    logger.warn(`Complex query detected in fallback parser: ${sqlQuery.substring(0, 200)}...`);
                    // Instead of blocking, throw error with SQL so user can fix or run directly
                    throw new Error(`La consulta requiere RPC execute_sql que no está disponible. Consulta: ${sqlQuery.substring(0, 100)}... Verifica que la función execute_sql existe en Supabase.`);
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
                    // Handle comparison operators (>=, <=, >, <, =, <>)
                    else {
                        const opMatch = whereClause.match(/(\w+)\s*([<>=!]+)\s*([^\s;]+)/i);
                        if (opMatch) {
                            const column = opMatch[1];
                            const operator = opMatch[2];
                            let value = opMatch[3];
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

                            switch (operator) {
                                case '=':
                                    query = query.eq(column, finalValue);
                                    break;
                                case '!=':
                                case '<>':
                                    query = query.neq(column, finalValue);
                                    break;
                                case '>':
                                    query = query.gt(column, finalValue);
                                    break;
                                case '<':
                                    query = query.lt(column, finalValue);
                                    break;
                                case '>=':
                                    query = query.gte(column, finalValue);
                                    break;
                                case '<=':
                                    query = query.lte(column, finalValue);
                                    break;
                                default:
                                    query = query.eq(column, finalValue); // Fallback
                            }
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

                // Log output for fallback parser
                logger.info('📤 OUTPUT (fallback parser):', JSON.stringify({
                    query: sqlQuery,
                    results: data,
                    rowCount: data ? data.length : 0
                }, null, 2));

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

