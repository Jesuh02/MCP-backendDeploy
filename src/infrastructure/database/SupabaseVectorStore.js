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
║      embedding vector(1536),                                       ║
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
║      query_embedding vector(1536),                                 ║
║      match_threshold float DEFAULT 0.7,                            ║
║      match_count int DEFAULT 5,                                    ║
║      filter_course_id bigint DEFAULT NULL,                         ║
║      filter_topic_id bigint DEFAULT NULL,                          ║
║      filter_task_id bigint DEFAULT NULL                            ║
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
    async store(content, embedding, metadata = {}) {
        await this.initialize();

        try {
            const record = {
                content,
                embedding: `[${embedding.join(',')}]`, // Format for pgvector
                metadata: JSON.stringify(metadata),
                topic_id: metadata.topicId || null,
                content_item_id: metadata.contentItemId || null,
                file_name: metadata.fileName || null,
                file_type: metadata.fileType || null,
                chunk_index: metadata.chunkIndex || 0,
                created_at: new Date().toISOString()
            };

            const { data, error } = await this.supabase.client
                .from(this.tableName)
                .insert([record])
                .select();

            if (error) {
                // If table doesn't exist, try knowledge_base as fallback
                if (error.code === 'PGRST116' || error.message.includes('does not exist')) {
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
     * Fallback storage to knowledge_base table
     */
    async _storeToKnowledgeBase(content, embedding, metadata) {
        try {
            const { data, error } = await this.supabase.client
                .from('knowledge_base')
                .insert([{
                    content,
                    embedding: embedding ? `[${embedding.join(',')}]` : null,
                    metadata,
                    created_at: new Date().toISOString()
                }])
                .select();

            if (error) throw error;
            return data[0];
        } catch (e) {
            logger.error('Fallback storage also failed:', e);
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
                    filter_task_id: filter.taskId || null
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

            if (filter.topicId) {
                query = query.eq('topic_id', filter.topicId);
            }
            if (filter.contentItemId) {
                query = query.eq('content_item_id', filter.contentItemId);
            }
            if (filter.fileName) {
                query = query.eq('file_name', filter.fileName);
            }

            const { data, error, count } = await query.select();

            if (error) throw error;

            logger.info(`Deleted ${data?.length || 0} documents from vector store`);
            return data ? .length || 0;
        } catch (error) {
            logger.error('Error deleting documents:', error);
            return 0;
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

            if (filter.topicId) query = query.eq('topic_id', filter.topicId);
            if (filter.contentItemId) query = query.eq('content_item_id', filter.contentItemId);
            if (filter.fileName) query = query.eq('file_name', filter.fileName);

            const { count, error } = await query;

            return !error && count > 0;
        } catch (error) {
            return false;
        }
    }
}

export default SupabaseVectorStore;