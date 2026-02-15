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
                    logger.warn(`Constraint violation detected (${error.details || error.message}). Retrying with ALL FK fields nullified...`);

                    // Nullify ALL FK fields at once to avoid cascading failures
                    const retryRecord = {
                        ...record,
                        task_id: null,
                        topic_id: null,
                        course_id: null,
                        content_item_id: null
                    };

                    const retry = await this.supabase.client
                        .from(this.tableName)
                        .insert([retryRecord])
                        .select();

                    if (!retry.error) {
                        logger.info('✅ Retry successful with all FK fields nullified');
                        return retry.data[0];
                    }
                    // If fails again, log and continue to throw/fallback
                    logger.warn('❌ Retry failed:', retry.error);
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
            // Note: We use rag_documents as the fallback table name too, just passing metadata in JSONB
            // This handles cases where specific columns (course_id, topic_id) might be missing
            // IMPORTANT: Do NOT set FK fields here — they already failed validation or caused constraint errors.
            // Store context IDs only inside the metadata JSONB column for reference.
            const { data, error } = await this.supabase.client
                .from('rag_documents')
                .insert([{
                    content,
                    embedding: embedding ? `[${embedding.join(',')}]` : null,
                    metadata,
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

            if (error) throw error;
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
                // Fallback to simpler search
                return this._fallbackSearch(queryEmbedding, topK, threshold, filter);
            }

            return data || [];
        } catch (error) {
            logger.error('Vector search error:', error);
            return this._fallbackSearch(queryEmbedding, topK, threshold, filter);
        }
    }

    /**
     * Fallback search using knowledge_base table
     */
    async _fallbackSearch(queryEmbedding, topK, threshold, filter) {
        try {
            // Try search_knowledge_base RPC
            const { data, error } = await this.supabase.client
                .rpc('search_knowledge_base', {
                    query_embedding: `[${queryEmbedding.join(',')}]`,
                    match_threshold: threshold,
                    match_count: topK
                });

            if (!error && data) {
                return data;
            }

            // Ultimate fallback: return empty
            logger.warn('All vector search methods failed, returning empty results');
            return [];
        } catch (e) {
            logger.error('Fallback search failed:', e);
            return [];
        }
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
            if (filter.fileName) query = query.eq('file_name', filter.fileName);

            const { count, error } = await query;

            return !error && count > 0;
        } catch (error) {
            return false;
        }
    }
}

export default SupabaseVectorStore;

