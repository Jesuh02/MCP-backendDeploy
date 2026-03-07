-- Migration v2: Add course_id filter to match_questions / match_options
-- Run this in the Supabase SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────
-- The JS backend calls these functions with 5 named parameters:
--   query_embedding, match_threshold, match_count, filter_user_id, filter_course_id
-- Previous scripts created only the 4-param version (no filter_course_id),
-- which causes: "Could not find the function ... in the schema cache".
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop ALL existing overloads (4-param and 5-param) to avoid ambiguous overloads
DROP FUNCTION IF EXISTS public.match_questions(vector,    float, int, bigint);
DROP FUNCTION IF EXISTS public.match_questions(vector(4096), float, int, bigint);
DROP FUNCTION IF EXISTS public.match_questions(vector,    float, int, bigint, bigint);
DROP FUNCTION IF EXISTS public.match_questions(vector(4096), float, int, bigint, bigint);

DROP FUNCTION IF EXISTS public.match_options(vector,    float, int, bigint);
DROP FUNCTION IF EXISTS public.match_options(vector(4096), float, int, bigint);
DROP FUNCTION IF EXISTS public.match_options(vector,    float, int, bigint, bigint);
DROP FUNCTION IF EXISTS public.match_options(vector(4096), float, int, bigint, bigint);

-- ─────────────────────────────────────────────────────────────────────────────
-- match_questions — 5 params, with optional course filter
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.match_questions(
  query_embedding  vector(4096),
  match_threshold  float,
  match_count      int,
  filter_user_id   bigint,
  filter_course_id bigint DEFAULT NULL
)
RETURNS TABLE (
  id            bigint,
  question_text text,
  similarity    float
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
    AND qh.question_embedding IS NOT NULL
    AND (filter_course_id IS NULL OR qh.course_id = filter_course_id)
    AND 1 - (qh.question_embedding <=> query_embedding) > match_threshold
  ORDER BY qh.question_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- match_options — 5 params, with optional course filter
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.match_options(
  query_embedding  vector(4096),
  match_threshold  float,
  match_count      int,
  filter_user_id   bigint,
  filter_course_id bigint DEFAULT NULL
)
RETURNS TABLE (
  id          bigint,
  option_text text,
  question_id bigint,
  similarity  float
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
    AND qo.option_embedding IS NOT NULL
    AND (filter_course_id IS NULL OR qh.course_id = filter_course_id)
    AND 1 - (qo.option_embedding <=> query_embedding) > match_threshold
  ORDER BY qo.option_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Force PostgREST to reload its schema cache so the new signatures are visible immediately
NOTIFY pgrst, 'reload schema';
