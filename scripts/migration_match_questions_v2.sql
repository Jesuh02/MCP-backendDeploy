-- Migration: Add course_id filter to match_questions for consistent duplicate detection
-- Run this in Supabase SQL Editor

-- Drop existing function and recreate with course_id filter
DROP FUNCTION IF EXISTS match_questions(vector, float, int, bigint);

CREATE OR REPLACE FUNCTION match_questions(
  query_embedding vector(4096),
  match_threshold float,
  match_count int,
  filter_user_id bigint,
  filter_course_id bigint DEFAULT NULL
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
    AND (filter_course_id IS NULL OR qh.course_id = filter_course_id)
    AND 1 - (qh.question_embedding <=> query_embedding) > match_threshold
  ORDER BY qh.question_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Also update match_options to be consistent
DROP FUNCTION IF EXISTS match_options(vector, float, int, bigint);

CREATE OR REPLACE FUNCTION match_options(
  query_embedding vector(4096),
  match_threshold float,
  match_count int,
  filter_user_id bigint,
  filter_course_id bigint DEFAULT NULL
)
RETURNS TABLE (
  id bigint,
  option_text text,
  question_id bigint,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    qo.id,
    qo.option_text,
    qo.question_id,
    1 - (qo.option_embedding <=> query_embedding) AS similarity
  FROM question_options qo
  JOIN questions_history qh ON qh.id = qo.question_id
  WHERE
    qh.user_id = filter_user_id
    AND (filter_course_id IS NULL OR qh.course_id = filter_course_id)
    AND 1 - (qo.option_embedding <=> query_embedding) > match_threshold
  ORDER BY qo.option_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
