-- Migration script to update schema for question uniqueness and vector support
-- Run this in your Supabase SQL Editor

-- 1. Enable vector extension if not already enabled (usually handled, but good to ensure)
-- create extension if not exists vector;

-- 2. Update questions_history table
ALTER TABLE public.questions_history 
ADD COLUMN IF NOT EXISTS question_hash text,
ADD COLUMN IF NOT EXISTS question_embedding vector(4096),
ADD COLUMN IF NOT EXISTS session_id bigint;

-- Add FK for session_id if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'questions_history_session_id_fkey') THEN
        ALTER TABLE public.questions_history 
        ADD CONSTRAINT questions_history_session_id_fkey 
        FOREIGN KEY (session_id) REFERENCES public.question_sessions(id);
    END IF;
END $$;

-- 3. Update question_options table
ALTER TABLE public.question_options 
ADD COLUMN IF NOT EXISTS option_embedding vector(4096);

-- 4. Create/Update Similarity Search Functions

-- Function: match_questions
CREATE OR REPLACE FUNCTION match_questions(
  query_embedding vector(4096),
  match_threshold float,
  match_count int,
  filter_user_id bigint
)
RETURNS TABLE (
  id bigint,
  question_text text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    qh.id,
    qh.question_text,
    1 - (qh.question_embedding <=> query_embedding) AS similarity
  FROM questions_history qh
  WHERE
    qh.user_id = filter_user_id
    AND 1 - (qh.question_embedding <=> query_embedding) > match_threshold
  ORDER BY qh.question_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Function: match_options
CREATE OR REPLACE FUNCTION match_options(
  query_embedding vector(4096),
  match_threshold float,
  match_count int,
  filter_user_id bigint
)
RETURNS TABLE (
  id bigint,
  option_text text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    qo.id,
    qo.option_text,
    1 - (qo.option_embedding <=> query_embedding) AS similarity
  FROM question_options qo
  JOIN questions_history qh ON qo.question_id = qh.id
  WHERE
    qh.user_id = filter_user_id
    AND 1 - (qo.option_embedding <=> query_embedding) > match_threshold
  ORDER BY qo.option_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
