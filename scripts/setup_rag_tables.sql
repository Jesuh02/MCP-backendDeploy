-- ═══════════════════════════════════════════════════════════════════════════════
-- RAG (Retrieval-Augmented Generation) - Database Setup Script
-- ═══════════════════════════════════════════════════════════════════════════════
-- 
-- This script sets up the necessary tables and functions for the RAG system
-- in Supabase. Execute this in the Supabase SQL Editor.
--
-- Prerequisites:
-- 1. Enable pgvector extension (only if not already enabled)
-- 2. Have appropriate database permissions
--
-- ═══════════════════════════════════════════════════════════════════════════════

-- Step 1: Enable pgvector extension (required for vector similarity search)
-- Note: This may already be enabled in Supabase. If you get an error, skip this step.
CREATE EXTENSION IF NOT EXISTS vector;

-- Step 2: Create the rag_documents table for storing document chunks and embeddings
CREATE TABLE IF NOT EXISTS rag_documents (
    id BIGSERIAL PRIMARY KEY,
    
    -- Document content and embedding
    content TEXT NOT NULL,
    embedding vector(1536),  -- OpenAI text-embedding-3-small dimension
    
    -- Metadata for filtering and organization
    file_name TEXT,
    file_type TEXT,
    course_id INTEGER,
    topic_id INTEGER,
    task_id INTEGER,
    chunk_index INTEGER DEFAULT 0,
    total_chunks INTEGER DEFAULT 1,
    
    -- Additional metadata as JSON
    metadata JSONB DEFAULT '{}',
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Step 3: Create indexes for faster queries
-- Index on embedding for vector similarity search
CREATE INDEX IF NOT EXISTS idx_rag_documents_embedding 
ON rag_documents 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Index on metadata columns for filtering
CREATE INDEX IF NOT EXISTS idx_rag_documents_course_id ON rag_documents(course_id);
CREATE INDEX IF NOT EXISTS idx_rag_documents_task_id ON rag_documents(task_id);
CREATE INDEX IF NOT EXISTS idx_rag_documents_topic_id ON rag_documents(topic_id);
CREATE INDEX IF NOT EXISTS idx_rag_documents_file_name ON rag_documents(file_name);
CREATE INDEX IF NOT EXISTS idx_rag_documents_created_at ON rag_documents(created_at DESC);

-- Index on metadata JSONB for flexible queries
CREATE INDEX IF NOT EXISTS idx_rag_documents_metadata ON rag_documents USING GIN (metadata);

-- Step 4: Create the vector similarity search function
CREATE OR REPLACE FUNCTION match_rag_documents(
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.7,
    match_count INT DEFAULT 5,
    filter_course_id INTEGER DEFAULT NULL,
    filter_topic_id INTEGER DEFAULT NULL,
    filter_task_id INTEGER DEFAULT NULL
)
RETURNS TABLE (
    id BIGINT,
    content TEXT,
    file_name TEXT,
    file_type TEXT,
    course_id INTEGER,
    topic_id INTEGER,
    task_id INTEGER,
    chunk_index INTEGER,
    metadata JSONB,
    similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        rd.id,
        rd.content,
        rd.file_name,
        rd.file_type,
        rd.course_id,
        rd.topic_id,
        rd.task_id,
        rd.chunk_index,
        rd.metadata,
        1 - (rd.embedding <=> query_embedding) AS similarity
    FROM rag_documents rd
    WHERE 
        1 - (rd.embedding <=> query_embedding) > match_threshold
        AND (filter_course_id IS NULL OR rd.course_id = filter_course_id)
        AND (filter_topic_id IS NULL OR rd.topic_id = filter_topic_id)
        AND (filter_task_id IS NULL OR rd.task_id = filter_task_id)
    ORDER BY rd.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Step 5: Create function to delete documents by metadata
CREATE OR REPLACE FUNCTION delete_rag_documents(
    filter_file_name TEXT DEFAULT NULL,
    filter_course_id INTEGER DEFAULT NULL,
    filter_task_id INTEGER DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM rag_documents
    WHERE 
        (filter_file_name IS NULL OR file_name = filter_file_name)
        AND (filter_course_id IS NULL OR course_id = filter_course_id)
        AND (filter_task_id IS NULL OR task_id = filter_task_id);
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

-- Step 6: Create trigger to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_rag_documents_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_rag_documents_timestamp ON rag_documents;
CREATE TRIGGER trigger_update_rag_documents_timestamp
    BEFORE UPDATE ON rag_documents
    FOR EACH ROW
    EXECUTE FUNCTION update_rag_documents_timestamp();

-- Step 7: Create RLS (Row Level Security) policies if needed
-- Uncomment these if you want to enable RLS
-- ALTER TABLE rag_documents ENABLE ROW LEVEL SECURITY;
-- 
-- CREATE POLICY "Users can read all documents" ON rag_documents
--     FOR SELECT USING (true);
-- 
-- CREATE POLICY "Only authenticated users can insert" ON rag_documents
--     FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- Step 8: Grant permissions (adjust as needed for your setup)
-- GRANT ALL ON rag_documents TO authenticated;
-- GRANT ALL ON rag_documents TO service_role;
-- GRANT USAGE, SELECT ON SEQUENCE rag_documents_id_seq TO authenticated;
-- GRANT USAGE, SELECT ON SEQUENCE rag_documents_id_seq TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES
-- Run these after executing the setup to verify everything is working
-- ═══════════════════════════════════════════════════════════════════════════════

-- Verify table exists
-- SELECT EXISTS (
--     SELECT FROM information_schema.tables 
--     WHERE table_name = 'rag_documents'
-- );

-- Verify pgvector extension
-- SELECT * FROM pg_extension WHERE extname = 'vector';

-- Verify function exists
-- SELECT proname FROM pg_proc WHERE proname = 'match_rag_documents';

-- Test insert (optional - remove after testing)
-- INSERT INTO rag_documents (content, file_name, file_type, course_id)
-- VALUES ('Test document content', 'test.txt', 'txt', 1);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLEANUP (Only use if you need to reset the RAG system)
-- ═══════════════════════════════════════════════════════════════════════════════

-- DROP FUNCTION IF EXISTS match_rag_documents;
-- DROP FUNCTION IF EXISTS delete_rag_documents;
-- DROP FUNCTION IF EXISTS update_rag_documents_timestamp CASCADE;
-- DROP TABLE IF EXISTS rag_documents;

-- ═══════════════════════════════════════════════════════════════════════════════
-- NOTES:
-- 
-- 1. Vector Dimension: Currently set to 1536 (OpenAI text-embedding-3-small)
--    If using a different embedding model, adjust the dimension:
--    - OpenAI text-embedding-3-small: 1536
--    - OpenAI text-embedding-ada-002: 1536
--    - Cohere embed-english-v3.0: 1024
--    - BGE-small: 384
--
-- 2. IVFFlat Index: The 'lists' parameter (100) controls index granularity.
--    - Lower values = faster index creation, slower queries
--    - Higher values = slower index creation, faster queries
--    - Recommended: sqrt(row_count) for optimal performance
--
-- 3. Cosine Similarity: Using <=> operator for cosine distance.
--    Similarity is calculated as 1 - distance (higher = more similar)
--
-- ═══════════════════════════════════════════════════════════════════════════════
