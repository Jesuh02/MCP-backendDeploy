/**
 * SupabaseVectorStore - SOLID: Single Responsibility Principle
 * This service is ONLY responsible for vector storage operations in Supabase.
 * Implements IVectorStore interface for dependency inversion.
 */

import { IVectorStore } from '../../domain/interfaces/IVectorStore.js';
import { SupabaseService } from './SupabaseService.js';
import { logger } from '../logging/Logger.js';

export class SupabaseVectorStore extends IVectorStore {
    static instance = null;

    static getInstance() {
        if (!SupabaseVectorStore.instance) {
            SupabaseVectorStore.instance = new SupabaseVectorStore();
        }
        return SupabaseVectorStore.instance;
    }

    constructor() {
        super();
        if (SupabaseVectorStore.instance) return SupabaseVectorStore.instance;

        this.supabase = SupabaseService.getInstance();
        this.tableName = 'rag_documents';
        this._initialized = false;
    }

    /**
     * Initialize the vector store table if not exists
     * Creates the table with proper vector column
     */
    async initialize() {
        if (this._initialized) return;

        try {
            // Check if table exists by trying to query it
            const { data, error } = await this.supabase.client
                .from(this.tableName)
                .select('id')
                .limit(1);

            if (error && error.code === 'PGRST116') {
                // Table doesn't exist - we need to create it via SQL
                logger.warn(`Table ${this.tableName} doesn't exist. Please create it using the SQL script.`);
                console.log(`
╔════════════════════════════════════════════════════════════════════╗
║  RAG VECTOR STORE SETUP REQUIRED                                   ║
╠════════════════════════════════════════════════════════════════════╣
║  Please run the following SQL in your Supabase SQL Editor:         ║
║                                                                    ║
║  -- Enable pgvector extension                                      ║
║  CREATE EXTENSION IF NOT EXISTS vector;                            ║
║                                                                    ║
║  -- Create RAG documents table                                     ║
║  CREATE TABLE IF NOT EXISTS rag_documents (                        ║
║      id BIGSERIAL PRIMARY KEY,                                     ║
║      content TEXT NOT NULL,                                        ║
║      embedding vector(4096), -- Adjust to 4096 if using Qwen       ║
║      metadata JSONB DEFAULT '{}',                                  ║
║      course_id BIGINT,                                             ║
║      topic_id BIGINT,                                              ║
║      task_id BIGINT,                                               ║
║      file_name TEXT,                                               ║
║      file_type TEXT,                                               ║
║      chunk_index INTEGER,                                          ║
║      created_at TIMESTAMPTZ DEFAULT NOW()                          ║
║  );                                                                ║
║                                                                    ║
║  -- Create index for vector similarity search                      ║
║  CREATE INDEX IF NOT EXISTS rag_documents_embedding_idx            ║
║  ON rag_documents USING ivfflat (embedding vector_cosine_ops)      ║
║  WITH (lists = 100);                                               ║
║                                                                    ║
║  -- Create function for similarity search                          ║
║  CREATE OR REPLACE FUNCTION match_rag_documents(                   ║
║      query_embedding vector(4096), -- Adjust to 4096 if using Qwen ║
║      match_threshold float DEFAULT 0.7,                            ║
║      match_count int DEFAULT 5,                                    ║
║      filter_course_id bigint DEFAULT NULL,                         ║
║      filter_topic_id bigint DEFAULT NULL,                          ║
║      filter_task_id bigint DEFAULT NULL,                           ║
║      filter_content_item_id bigint DEFAULT NULL                    ║
║  ) RETURNS TABLE (                                                 ║
║      id bigint,                                                    ║
║      content text,                                                 ║
║      metadata jsonb,                                               ║
║      similarity float                                              ║
║  ) LANGUAGE plpgsql AS $$                                          ║
║  BEGIN                                                             ║
║      RETURN QUERY                                                  ║
║      SELECT                                                        ║
║          rd.id,                                                    ║
║          rd.content,                                               ║
║          rd.metadata,                                              ║
║          1 - (rd.embedding <=> query_embedding) as similarity      ║
║      FROM rag_documents rd                                         ║
║      WHERE                                                         ║
║          (filter_course_id IS NULL OR rd.course_id = filter_course_id) ║
║          AND (filter_topic_id IS NULL OR rd.topic_id = filter_topic_id) ║
║          AND (filter_task_id IS NULL OR rd.task_id = filter_task_id)    ║
║          AND (filter_content_item_id IS NULL OR rd.content_item_id = filter_content_item_id) ║
║          AND 1 - (rd.embedding <=> query_embedding) > match_threshold   ║
║      ORDER BY rd.embedding <=> query_embedding                     ║
║      LIMIT match_count;                                            ║
║  END;                                                              ║
║  $$;                                                               ║
╚════════════════════════════════════════════════════════════════════╝
                `);
            } else {
                this._initialized = true;
                logger.info(`✅ Vector store table '${this.tableName}' is ready`);
            }
        } catch (error) {
            logger.error('Error initializing vector store:', error);
        }
    }

    /**
     * Store a document chunk with its embedding
     * @param {string} content - The text content
     * @param {number[]} embedding - The embedding vector
     * @param {object} metadata - Additional metadata
     * @returns {Promise<object>} - Stored document
     */
    /**
     * Extract the specific FK field name from a 23503 constraint violation error.
     * @param {object} error - Supabase/Postgres error with details/message
     * @returns {string|null} - The column name (e.g., 'content_item_id') or null
     */
    _extractFailedFKField(error) {
        const msg = (error.details || error.message || '').toLowerCase();
        const fkColumns = ['content_item_id', 'task_id', 'topic_id', 'course_id'];
        for (const col of fkColumns) {
            if (msg.includes(col)) return col;
        }
        // Try to extract from constraint name pattern like "rag_documents_task_id_fkey"
        const constraintMatch = msg.match(/rag_documents_(\w+)_fkey/);
        if (constraintMatch) return constraintMatch[1];
        return null;
    }

    /**
     * Validate that foreign key references exist in the database before inserting.
     * Returns an object with only the valid FK values (invalid ones set to null).
     */
    async _validateForeignKeys(metadata) {
        const fkFields = {
            course_id: { value: metadata.courseId || metadata.course_id || null, table: 'courses' },
            topic_id: { value: metadata.topicId || metadata.topic_id || null, table: 'topics' },
            task_id: { value: metadata.taskId || metadata.task_id || null, table: 'tasks' },
            content_item_id: { value: metadata.contentItemId || metadata.content_item_id || null, table: 'content_items' }
        };

        const validated = {};

        for (const [field, { value, table }] of Object.entries(fkFields)) {
            if (value == null) {
                validated[field] = null;
                continue;
            }
            try {
                const { data, error } = await this.supabase.client
                    .from(table)
                    .select('id')
                    .eq('id', value)
                    .limit(1);

                if (error || !data || data.length === 0) {
                    logger.warn(`⚠️ FK validation: ${field}=${value} not found in '${table}'. Setting to null.`);
                    validated[field] = null;
                } else {
                    validated[field] = value;
                }
            } catch (e) {
                logger.warn(`⚠️ FK validation check failed for ${field}=${value}: ${e.message}. Setting to null.`);
                validated[field] = null;
            }
        }

        return validated;
    }

    async store(content, embedding, metadata = {}) {
        await this.initialize();

        try {
            // Validate FK references exist in DB before inserting to avoid constraint violations
            const validatedFKs = await this._validateForeignKeys(metadata);

            const record = {
                content,
                embedding: `[${embedding.join(',')}]`, // Format for pgvector
                metadata: JSON.stringify(metadata),
                course_id: validatedFKs.course_id,
                topic_id: validatedFKs.topic_id,
                task_id: validatedFKs.task_id,
                content_item_id: validatedFKs.content_item_id,
                file_name: metadata.fileName || null,
                file_type: metadata.fileType || metadata.originalFileType || null,
                chunk_index: metadata.chunkIndex != null ? metadata.chunkIndex : 0,
                total_chunks: metadata.totalChunks != null ? metadata.totalChunks : 1,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };

            const { data, error } = await this.supabase.client
                .from(this.tableName)
                .insert([record])
                .select();

            if (error) {
                // DETECT DIMENSION MISMATCH (Auto-migration)
                if (error.message && (error.message.includes('dimensions') || error.message.includes('22000'))) {
                    logger.warn(`⚠️ Vector dimension mismatch detected: ${error.message}. Attempting auto-migration...`);
                    const targetDim = embedding.length;

                    try {
                        await this._migrateTableDimensions(targetDim);
                        // Retry insertion after migration
                        const retry = await this.supabase.client
                            .from(this.tableName)
                            .insert([record])
                            .select();
                        if (retry.error) throw retry.error;
                        return retry.data[0];
                    } catch (migrateError) {
                        logger.error('❌ Auto-migration failed:', migrateError);
                        // Fall through to throw/fallback
                    }
                }

                // HANDLE FOREIGN KEY VIOLATIONS (Code 23503)
                // This happens when inserting a record with a reference ID (taskId, topicId) that doesn't exist in DB
                if (error.code === '23503') {
                    // Instead of nullifying ALL FKs (which makes records invisible to queries),
                    // identify and nullify only the specific FK that failed.
                    const failedField = this._extractFailedFKField(error);
                    logger.warn(`Constraint violation on field '${failedField}' (${error.details || error.message}). Retrying with only that FK nullified...`);

                    const retryRecord = { ...record };
                    if (failedField) {
                        retryRecord[failedField] = null;
                    } else {
                        // Fallback: nullify only content_item_id (most likely to be missing)
                        retryRecord.content_item_id = null;
                    }

                    const retry = await this.supabase.client
                        .from(this.tableName)
                        .insert([retryRecord])
                        .select();

                    if (!retry.error) {
                        logger.info(`✅ Retry successful with ${failedField || 'content_item_id'} nullified. Record still has task_id=${retryRecord.task_id}, course_id=${retryRecord.course_id}`);
                        return retry.data[0];
                    }

                    // Second fallback: nullify only content_item_id (most likely FK problem)
                    // ⛔ NEVER nullify ALL FKs — this makes documents invisible to filtered queries,
                    // which is the root cause of the "wrong document" RAG bug.
                    logger.warn(`❌ Retry failed (${retry.error.message}). Attempting with content_item_id=null only...`);
                    const lastResortRecord = {
                        ...record,
                        content_item_id: null
                        // KEEP task_id, topic_id, course_id — these are essential for filtering
                    };
                    const lastRetry = await this.supabase.client
                        .from(this.tableName)
                        .insert([lastResortRecord])
                        .select();
                    if (!lastRetry.error) {
                        logger.info(`✅ Insert succeeded with content_item_id nullified. FKs preserved: task_id=${lastResortRecord.task_id}, topic_id=${lastResortRecord.topic_id}, course_id=${lastResortRecord.course_id}`);
                        return lastRetry.data[0];
                    }
                    logger.error('❌ All insert attempts failed:', lastRetry.error);
                }

                // If table doesn't exist, try knowledge_base as fallback
                // Also if expected columns are missing (404/406 or schema error), try generic insert
                if (error.code === 'PGRST116' || error.message.includes('does not exist') || error.message.includes('column')) {
                    logger.warn(`Specific column insert failed (${error.message}), attempting generic metadata insert...`);
                    return this._storeToKnowledgeBase(content, embedding, metadata);
                }
                throw error;
            }

            return data[0];
        } catch (error) {
            logger.error('Error storing document:', error);
            // Try fallback
            return this._storeToKnowledgeBase(content, embedding, metadata);
        }
    }

    /**
     * Helper to migrate table dimensions
     */
    async _migrateTableDimensions(newDim) {
        // SQL to update column and recreation of search function
        const sql = `
            DO $$ 
            BEGIN
                -- 1. Alter column type (Force recreation if alter fails)
                BEGIN
                    ALTER TABLE rag_documents ALTER COLUMN embedding TYPE vector(${newDim});
                EXCEPTION WHEN OTHERS THEN
                    -- If alter fails (e.g. data exists and cannot be cast), we drop and recreate
                    -- This results in loss of vector data but fixes the schema for new insertions
                    RAISE NOTICE 'Standard ALTER failed, dropping and recreating column... %', SQLERRM;
                    ALTER TABLE rag_documents DROP COLUMN IF EXISTS embedding;
                    ALTER TABLE rag_documents ADD COLUMN embedding vector(${newDim});
                END;

                -- 2. Add content_item_id if missing
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rag_documents' AND column_name = 'content_item_id') THEN
                    ALTER TABLE rag_documents ADD COLUMN content_item_id bigint;
                END IF;
            END $$;

            -- Recreate the function with new dimensions
            CREATE OR REPLACE FUNCTION match_rag_documents(
                query_embedding vector(${newDim}),
                match_threshold float DEFAULT 0.7,
                match_count int DEFAULT 5,
                filter_course_id bigint DEFAULT NULL,
                filter_topic_id bigint DEFAULT NULL,
                filter_task_id bigint DEFAULT NULL,
                filter_content_item_id bigint DEFAULT NULL
            ) RETURNS TABLE (
                id bigint,
                content text,
                metadata jsonb,
                similarity float
            ) LANGUAGE plpgsql AS $$
            BEGIN
                RETURN QUERY
                SELECT
                    rd.id,
                    rd.content,
                    rd.metadata,
                    1 - (rd.embedding <=> query_embedding) as similarity
                FROM rag_documents rd
                WHERE
                    (filter_course_id IS NULL OR rd.course_id = filter_course_id)
                    AND (filter_topic_id IS NULL OR rd.topic_id = filter_topic_id)
                    AND (filter_task_id IS NULL OR rd.task_id = filter_task_id)
                    AND (filter_content_item_id IS NULL OR rd.content_item_id = filter_content_item_id)
                    AND 1 - (rd.embedding <=> query_embedding) > match_threshold
                ORDER BY rd.embedding <=> query_embedding
                LIMIT match_count;
            END;
            $$;
        `;

        logger.info(`🔄 Migrating vector dimensions to ${newDim}...`);

        // Try both RPC methods commonly used
        const { error: err1 } = await this.supabase.client.rpc('exec_sql', { sql });
        if (!err1) return;

        logger.warn('exec_sql failed, trying execute_sql...', err1.message);

        const { error: err2 } = await this.supabase.client.rpc('execute_sql', { query: sql });
        if (err2) throw new Error(`Migration failed: ${err2.message}`);
    }

    /**
     * Fallback storage to knowledge_base table
     */
    async _storeToKnowledgeBase(content, embedding, metadata) {
        try {
            // Fallback insert — PRESERVE FK fields so documents remain visible
            // to filtered queries. Only nullify the specific FK that failed.
            // Storing with null FKs makes documents invisible to all filtered
            // searches, causing the system to return wrong content.
            const validatedFKs = await this._validateForeignKeys(metadata);

            const { data, error } = await this.supabase.client
                .from('rag_documents')
                .insert([{
                    content,
                    embedding: embedding ? `[${embedding.join(',')}]` : null,
                    metadata: JSON.stringify(metadata),
                    file_name: metadata.fileName || null,
                    file_type: metadata.fileType || metadata.originalFileType || null,
                    chunk_index: metadata.chunkIndex != null ? metadata.chunkIndex : 0,
                    total_chunks: metadata.totalChunks != null ? metadata.totalChunks : 1,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    course_id: validatedFKs.course_id,
                    topic_id: validatedFKs.topic_id,
                    task_id: validatedFKs.task_id,
                    content_item_id: validatedFKs.content_item_id
                }])
                .select();

            if (error) {
                // If FK validation passed but insert still fails, try with nullified FKs as absolute last resort
                logger.warn(`⚠️ Fallback insert with validated FKs failed: ${error.message}. Trying with null FKs (last resort)...`);
                const { data: lastData, error: lastError } = await this.supabase.client
                    .from('rag_documents')
                    .insert([{
                        content,
                        embedding: embedding ? `[${embedding.join(',')}]` : null,
                        metadata: JSON.stringify(metadata),
                        file_name: metadata.fileName || null,
                        file_type: metadata.fileType || metadata.originalFileType || null,
                        chunk_index: metadata.chunkIndex != null ? metadata.chunkIndex : 0,
                        total_chunks: metadata.totalChunks != null ? metadata.totalChunks : 1,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                        course_id: null,
                        topic_id: null,
                        task_id: null,
                        content_item_id: null
                    }])
                    .select();
                if (lastError) throw lastError;
                logger.warn('⚠️ Last resort insert succeeded but record has NULL FKs — it will be invisible to filtered queries');
                return lastData[0];
            }
            return data[0];
        } catch (e) {
            logger.error('Fallback storage (rag_documents plain) also failed:', e);
            throw e;
        }
    }

    /**
     * Search for similar documents using vector similarity
     * @param {number[]} queryEmbedding - The query embedding vector
     * @param {number} topK - Number of results to return
     * @param {number} threshold - Similarity threshold (0-1)
     * @param {object} filter - Metadata filter (courseId, topicId, taskId)
     * @returns {Promise<object[]>} - Similar documents with similarity scores
     */
    async search(queryEmbedding, topK = 5, threshold = 0.7, filter = {}) {
        await this.initialize();

        try {
            // Try the custom RPC function first
            const { data, error } = await this.supabase.client
                .rpc('match_rag_documents', {
                    query_embedding: `[${queryEmbedding.join(',')}]`,
                    match_threshold: threshold,
                    match_count: topK,
                    filter_course_id: filter.courseId || null,
                    filter_topic_id: filter.topicId || null,
                    filter_task_id: filter.taskId || null,
                    filter_content_item_id: filter.contentItemId || null
                });

            if (error) {
                logger.warn(`match_rag_documents RPC failed: ${error.message}. Trying auto-provision & direct SQL fallback...`);

                // If the function doesn't exist, try to create it automatically
                if (error.message.includes('function') || error.message.includes('does not exist') || error.code === 'PGRST202') {
                    const created = await this._ensureMatchFunction(queryEmbedding.length);
                    if (created) {
                        // Retry after creating the function
                        const retry = await this.supabase.client
                            .rpc('match_rag_documents', {
                                query_embedding: `[${queryEmbedding.join(',')}]`,
                                match_threshold: threshold,
                                match_count: topK,
                                filter_course_id: filter.courseId || null,
                                filter_topic_id: filter.topicId || null,
                                filter_task_id: filter.taskId || null,
                                filter_content_item_id: filter.contentItemId || null
                            });
                        if (!retry.error && retry.data) {
                            logger.info(`✅ match_rag_documents auto-provisioned and working! ${retry.data.length} results`);
                            return retry.data;
                        }
                    }
                }

                // Fallback to direct SQL search
                return this._fallbackSearch(queryEmbedding, topK, threshold, filter);
            }

            return data || [];
        } catch (error) {
            logger.error('Vector search error:', error);
            return this._fallbackSearch(queryEmbedding, topK, threshold, filter);
        }
    }

    /**
     * Auto-create the match_rag_documents function in the database.
     * This solves the root cause: the RPC function was never created.
     * @param {number} dims - Embedding dimensions (e.g., 4096)
     * @returns {Promise<boolean>} - true if function was created successfully
     */
    async _ensureMatchFunction(dims = 4096) {
        if (this._matchFunctionAttempted) return false; // Only try once per instance
        this._matchFunctionAttempted = true;

        const createFunctionSQL = `
            CREATE OR REPLACE FUNCTION match_rag_documents(
                query_embedding vector(${dims}),
                match_threshold float DEFAULT 0.7,
                match_count int DEFAULT 5,
                filter_course_id bigint DEFAULT NULL,
                filter_topic_id bigint DEFAULT NULL,
                filter_task_id bigint DEFAULT NULL,
                filter_content_item_id bigint DEFAULT NULL
            ) RETURNS TABLE (
                id bigint,
                content text,
                metadata jsonb,
                similarity float
            ) LANGUAGE plpgsql AS $$
            BEGIN
                RETURN QUERY
                SELECT
                    rd.id,
                    rd.content,
                    rd.metadata,
                    1 - (rd.embedding <=> query_embedding) as similarity
                FROM rag_documents rd
                WHERE
                    (filter_course_id IS NULL OR rd.course_id = filter_course_id)
                    AND (filter_topic_id IS NULL OR rd.topic_id = filter_topic_id)
                    AND (filter_task_id IS NULL OR rd.task_id = filter_task_id)
                    AND (filter_content_item_id IS NULL OR rd.content_item_id = filter_content_item_id)
                    AND rd.embedding IS NOT NULL
                    AND 1 - (rd.embedding <=> query_embedding) > match_threshold
                ORDER BY rd.embedding <=> query_embedding
                LIMIT match_count;
            END;
            $$;
        `;

        try {
            // Try exec_sql RPC (common in Supabase setups)
            const { error: err1 } = await this.supabase.client.rpc('exec_sql', { sql: createFunctionSQL });
            if (!err1) {
                logger.info(`✅ Auto-created match_rag_documents function (${dims} dims) via exec_sql`);
                return true;
            }

            // Try execute_sql RPC
            const { error: err2 } = await this.supabase.client.rpc('execute_sql', { query: createFunctionSQL });
            if (!err2) {
                logger.info(`✅ Auto-created match_rag_documents function (${dims} dims) via execute_sql`);
                return true;
            }

            logger.warn(`⚠️ Could not auto-create match_rag_documents (no exec_sql/execute_sql RPC). Please run the SQL manually in Supabase SQL Editor.`);
            return false;
        } catch (e) {
            logger.warn(`⚠️ Auto-create match_rag_documents failed: ${e.message}`);
            return false;
        }
    }

    /**
     * Direct SQL fallback search — performs cosine similarity search WITHOUT
     * needing the match_rag_documents RPC function.
     * 
     * Uses Supabase PostgREST ordering with pgvector's <=> operator via raw RPC,
     * or falls back to fetching all embeddings and computing similarity in JS.
     */
    async _fallbackSearch(queryEmbedding, topK, threshold, filter) {
        try {
            logger.info(`[FallbackSearch] Attempting direct vector similarity search (filter: courseId=${filter.courseId}, topicId=${filter.topicId}, taskId=${filter.taskId})`);

            // Strategy 1: Use a lightweight inline SQL via Supabase RPC
            // This avoids needing a pre-created function — we call a generic SQL executor if available
            const inlineSQL = `
                SELECT id, content, metadata,
                       1 - (embedding <=> $1::vector) as similarity
                FROM rag_documents
                WHERE embedding IS NOT NULL
                  ${filter.courseId ? `AND course_id = ${parseInt(filter.courseId)}` : ''}
                  ${filter.topicId ? `AND topic_id = ${parseInt(filter.topicId)}` : ''}
                  ${filter.taskId ? `AND task_id = ${parseInt(filter.taskId)}` : ''}
                  AND 1 - (embedding <=> $1::vector) > ${parseFloat(threshold)}
                ORDER BY embedding <=> $1::vector
                LIMIT ${parseInt(topK)};
            `;

            // Try exec_sql
            try {
                const { data, error } = await this.supabase.client.rpc('exec_sql', {
                    sql: inlineSQL.replace(/\$1/g, `'[${queryEmbedding.join(',')}]'`)
                });
                if (!error && data && data.length > 0) {
                    logger.info(`✅ [FallbackSearch] exec_sql returned ${data.length} results`);
                    return data;
                }
            } catch (_) { /* exec_sql not available */ }

            // Strategy 2: Fetch candidate chunks (with embeddings) and compute similarity in JavaScript
            // This is slower but ALWAYS works as long as the table and pgvector are set up
            logger.info('[FallbackSearch] exec_sql not available. Computing similarity in JavaScript...');
            return await this._jsSimilaritySearch(queryEmbedding, topK, threshold, filter);

        } catch (e) {
            logger.error('Fallback search failed:', e);
            return [];
        }
    }

    /**
     * JavaScript-side cosine similarity search.
     * Fetches embeddings from the database and computes similarity locally.
     * This is the ultimate fallback that works without ANY database functions.
     * 
     * Optimization: Fetches in batches and filters by course/topic/task first
     * to reduce data transfer.
     */
    async _jsSimilaritySearch(queryEmbedding, topK, threshold, filter) {
        try {
            let query = this.supabase.client
                .from(this.tableName)
                .select('id, content, metadata, embedding')
                .not('embedding', 'is', null);

            if (filter.courseId) query = query.eq('course_id', filter.courseId);
            if (filter.topicId) query = query.eq('topic_id', filter.topicId);
            if (filter.taskId) query = query.eq('task_id', filter.taskId);

            // Limit to reasonable batch to avoid memory issues
            const { data, error } = await query.limit(500);

            if (error) {
                logger.error(`[JS Similarity] Query error: ${error.message}`);
                return [];
            }

            if (!data || data.length === 0) {
                logger.warn('[JS Similarity] No documents with embeddings found for the given filter');
                return [];
            }

            logger.info(`[JS Similarity] Computing similarity for ${data.length} candidate documents...`);

            // Compute cosine similarity for each document
            const results = [];
            for (const doc of data) {
                try {
                    const docEmbedding = this._parseEmbedding(doc.embedding);
                    if (!docEmbedding || docEmbedding.length === 0) continue;

                    const similarity = this._cosineSimilarity(queryEmbedding, docEmbedding);
                    if (similarity >= threshold) {
                        results.push({
                            id: doc.id,
                            content: doc.content,
                            metadata: typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : (doc.metadata || {}),
                            similarity: parseFloat(similarity.toFixed(4))
                        });
                    }
                } catch (parseErr) {
                    // Skip documents with unparseable embeddings
                    continue;
                }
            }

            // Sort by similarity descending and take top K
            results.sort((a, b) => b.similarity - a.similarity);
            const topResults = results.slice(0, topK);

            logger.info(`✅ [JS Similarity] Found ${topResults.length} results above threshold ${threshold} (from ${data.length} candidates)`);
            return topResults;

        } catch (e) {
            logger.error('[JS Similarity] Error:', e);
            return [];
        }
    }

    /**
     * Parse a pgvector embedding string into a float array.
     * Handles formats: "[1,2,3]", [1,2,3], or raw array.
     */
    _parseEmbedding(embedding) {
        if (!embedding) return null;
        if (Array.isArray(embedding)) return embedding;
        if (typeof embedding === 'string') {
            try {
                // pgvector returns "[0.1,0.2,...]"
                const cleaned = embedding.replace(/^\[|\]$/g, '');
                return cleaned.split(',').map(Number);
            } catch (_) {
                return null;
            }
        }
        return null;
    }

    /**
     * Compute cosine similarity between two vectors.
     * Returns a value between -1 and 1 (1 = identical).
     */
    _cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) return 0;

        // Handle dimension mismatch by using the shorter length
        const len = Math.min(vecA.length, vecB.length);
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < len; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }

        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        if (denominator === 0) return 0;

        return dotProduct / denominator;
    }

    /**
     * Delete documents by filter
     * @param {object} filter - Metadata filter
     * @returns {Promise<number>} - Number of deleted documents
     */
    async delete(filter = {}) {
        await this.initialize();

        try {
            let query = this.supabase.client
                .from(this.tableName)
                .delete();

            if (filter.courseId) {
                query = query.eq('course_id', filter.courseId);
            }
            if (filter.topicId) {
                query = query.eq('topic_id', filter.topicId);
            }
            if (filter.taskId) {
                query = query.eq('task_id', filter.taskId);
            }
            if (filter.fileName) {
                query = query.eq('file_name', filter.fileName);
            }

            const { data, error, count } = await query.select();

            if (error) throw error;

            logger.info(`Deleted ${data?.length || 0} documents from vector store`);
            return data?.length || 0;
        } catch (error) {
            logger.error('Error deleting documents:', error);
            return 0;
        }
    }

    /**
     * Fetch all text chunks from rag_documents for a given filter.
     * Returns raw text content (no embeddings) for direct inclusion in prompts.
     * @param {object} filter - { courseId, topicId, taskId }
     * @returns {Promise<Array<{ content: string, fileName: string, chunkIndex: number }>>}
     */
    async getContentChunks(filter = {}) {
        await this.initialize();

        try {
            let query = this.supabase.client
                .from(this.tableName)
                .select('content, file_name, chunk_index')
                .order('file_name', { ascending: true })
                .order('chunk_index', { ascending: true });

            if (filter.courseId) query = query.eq('course_id', filter.courseId);
            if (filter.topicId) query = query.eq('topic_id', filter.topicId);
            if (filter.taskId) query = query.eq('task_id', filter.taskId);

            const { data, error } = await query.limit(200);

            if (error) {
                logger.error('Error fetching content chunks:', error);
                return [];
            }

            return (data || []).map(row => ({
                content: row.content || '',
                fileName: row.file_name || '',
                chunkIndex: row.chunk_index ?? 0,
            }));
        } catch (error) {
            logger.error('Error in getContentChunks:', error);
            return [];
        }
    }

    /**
     * Fetches a paginated window of chunks for progressive context building.
     * Instead of returning all chunks (which causes the LLM to always see
     * the same content), this returns a specific "page" of chunks.
     *
     * Chunk Windowing Strategy:
     *   - windowSize: how many chunks per page (default 8)
     *   - overlap: chunks shared between consecutive pages (default 2)
     *   - stride = windowSize - overlap
     *   - Page N starts at offset = N * stride
     *   - When page exceeds available pages, wraps around (modulo)
     *
     * @param {object} filter - { courseId, topicId, taskId }
     * @param {number} page - Zero-based page index (wraps around if exceeds total)
     * @param {number} windowSize - Chunks per page (default 8)
     * @param {number} overlap - Overlap between pages (default 2)
     * @returns {Promise<{ chunks: Array, totalChunks: number, page: number, totalPages: number }>}
     */
    async getChunkPage(filter = {}, page = 0, windowSize = 8, overlap = 2) {
        await this.initialize();

        try {
            // First get total count
            let countQuery = this.supabase.client
                .from(this.tableName)
                .select('id', { count: 'exact', head: true });

            if (filter.courseId) countQuery = countQuery.eq('course_id', filter.courseId);
            if (filter.topicId) countQuery = countQuery.eq('topic_id', filter.topicId);
            if (filter.taskId) countQuery = countQuery.eq('task_id', filter.taskId);

            const { count: totalChunks, error: countError } = await countQuery;

            if (countError || !totalChunks || totalChunks === 0) {
                return { chunks: [], totalChunks: 0, page: 0, totalPages: 0 };
            }

            const stride = Math.max(1, windowSize - overlap);
            const totalPages = Math.max(1, Math.ceil((totalChunks - overlap) / stride));
            const effectivePage = page % totalPages;
            const offset = effectivePage * stride;

            let query = this.supabase.client
                .from(this.tableName)
                .select('content, file_name, chunk_index')
                .order('file_name', { ascending: true })
                .order('chunk_index', { ascending: true });

            if (filter.courseId) query = query.eq('course_id', filter.courseId);
            if (filter.topicId) query = query.eq('topic_id', filter.topicId);
            if (filter.taskId) query = query.eq('task_id', filter.taskId);

            const { data, error } = await query.range(offset, offset + windowSize - 1);

            if (error) {
                logger.error('Error fetching chunk page:', error);
                return { chunks: [], totalChunks, page: effectivePage, totalPages };
            }

            const chunks = (data || []).map(row => ({
                content: row.content || '',
                fileName: row.file_name || '',
                chunkIndex: row.chunk_index ?? 0,
            }));

            logger.info(`📄 getChunkPage: page=${effectivePage}/${totalPages}, chunks=${chunks.length}/${totalChunks}, offset=${offset}`);

            return { chunks, totalChunks, page: effectivePage, totalPages };
        } catch (error) {
            logger.error('Error in getChunkPage:', error);
            return { chunks: [], totalChunks: 0, page: 0, totalPages: 0 };
        }
    }

    /**
     * ═══════════════════════════════════════════════════════════
     * HYBRID RETRIEVAL: Window Expansion around semantic results
     * ═══════════════════════════════════════════════════════════
     *
     * Given a set of chunk indices returned by semantic search, expands
     * a window of ±windowSize around each index to provide richer context
     * to the LLM. Chunks are deduplicated and ordered by file + chunk_index.
     *
     * @param {object} filter - { courseId, topicId, taskId }
     * @param {number[]} chunkIndices - Chunk indices from semantic search results
     * @param {number} windowSize - How many chunks to include before/after each result (default 3)
     * @returns {Promise<Array<{ content: string, fileName: string, chunkIndex: number }>>}
     */
    async getChunksAround(filter = {}, chunkIndices = [], windowSize = 3) {
        await this.initialize();

        if (!chunkIndices || chunkIndices.length === 0) return [];

        try {
            // Calculate expanded ranges for each chunk index
            const expandedIndices = new Set();
            for (const idx of chunkIndices) {
                for (let i = Math.max(0, idx - windowSize); i <= idx + windowSize; i++) {
                    expandedIndices.add(i);
                }
            }

            const indicesArray = Array.from(expandedIndices).sort((a, b) => a - b);

            let query = this.supabase.client
                .from(this.tableName)
                .select('content, file_name, chunk_index')
                .in('chunk_index', indicesArray)
                .order('file_name', { ascending: true })
                .order('chunk_index', { ascending: true });

            if (filter.courseId) query = query.eq('course_id', filter.courseId);
            if (filter.topicId) query = query.eq('topic_id', filter.topicId);
            if (filter.taskId) query = query.eq('task_id', filter.taskId);

            const { data, error } = await query.limit(200);

            if (error) {
                logger.error('Error in getChunksAround:', error);
                return [];
            }

            const chunks = (data || []).map(row => ({
                content: row.content || '',
                fileName: row.file_name || '',
                chunkIndex: row.chunk_index ?? 0,
            }));

            logger.info(`📄 getChunksAround: ${chunkIndices.length} seed indices → ${indicesArray.length} expanded → ${chunks.length} chunks returned`);

            return chunks;
        } catch (error) {
            logger.error('Error in getChunksAround:', error);
            return [];
        }
    }

    /**
     * Retrieves chunks by their exact indices for a given filter.
     * Used by hybrid retrieval to fetch specific semantic search results
     * with their metadata intact.
     *
     * @param {object} filter - { courseId, topicId, taskId }
     * @param {number[]} chunkIndices - Specific chunk indices to retrieve
     * @returns {Promise<Array<{ content: string, fileName: string, chunkIndex: number, id: number }>>}
     */
    async getChunksByIndices(filter = {}, chunkIndices = []) {
        await this.initialize();

        if (!chunkIndices || chunkIndices.length === 0) return [];

        try {
            let query = this.supabase.client
                .from(this.tableName)
                .select('id, content, file_name, chunk_index')
                .in('chunk_index', chunkIndices)
                .order('chunk_index', { ascending: true });

            if (filter.courseId) query = query.eq('course_id', filter.courseId);
            if (filter.topicId) query = query.eq('topic_id', filter.topicId);
            if (filter.taskId) query = query.eq('task_id', filter.taskId);

            const { data, error } = await query.limit(200);

            if (error) {
                logger.error('Error in getChunksByIndices:', error);
                return [];
            }

            return (data || []).map(row => ({
                id: row.id,
                content: row.content || '',
                fileName: row.file_name || '',
                chunkIndex: row.chunk_index ?? 0,
            }));
        } catch (error) {
            logger.error('Error in getChunksByIndices:', error);
            return [];
        }
    }

    /**
     * Check if documents exist for a specific context
     * @param {object} filter - Filter criteria
     * @returns {Promise<boolean>}
     */
    async exists(filter = {}) {
        try {
            let query = this.supabase.client
                .from(this.tableName)
                .select('id', { count: 'exact', head: true });

            if (filter.courseId) query = query.eq('course_id', filter.courseId);
            if (filter.topicId) query = query.eq('topic_id', filter.topicId);
            if (filter.taskId) query = query.eq('task_id', filter.taskId);
            if (filter.contentItemId) query = query.eq('content_item_id', filter.contentItemId);
            if (filter.fileName) query = query.eq('file_name', filter.fileName);

            const { count, error } = await query;

            if (error) {
                logger.warn(`⚠️ exists() query error: ${error.message}`);
                return false;
            }

            return count > 0;
        } catch (error) {
            logger.warn(`⚠️ exists() exception: ${error.message}`);
            return false;
        }
    }
}

export default SupabaseVectorStore;

