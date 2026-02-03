-- ═══════════════════════════════════════════════════════════════════════════════
-- SCRIPT DE CONFIGURACIÓN: Sistema de Preguntas Únicas
-- Ejecutar en Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Habilitar extensión de vectores (probablemente ya habilitada)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Asegurar que las columnas necesarias existen
ALTER TABLE public.questions_history 
ADD COLUMN IF NOT EXISTS question_hash text,
ADD COLUMN IF NOT EXISTS question_embedding vector(4096),
ADD COLUMN IF NOT EXISTS session_id bigint;

ALTER TABLE public.question_options 
ADD COLUMN IF NOT EXISTS option_embedding vector(4096);

-- 3. Crear índices para búsqueda rápida
CREATE INDEX IF NOT EXISTS idx_questions_history_user_hash 
ON public.questions_history(user_id, question_hash);

CREATE INDEX IF NOT EXISTS idx_questions_history_embedding 
ON public.questions_history 
USING ivfflat (question_embedding vector_cosine_ops)
WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_question_options_embedding 
ON public.question_options 
USING ivfflat (option_embedding vector_cosine_ops)
WITH (lists = 100);

-- 4. Función RPC: Buscar preguntas similares por embedding
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
    AND qh.question_embedding IS NOT NULL
    AND 1 - (qh.question_embedding <=> query_embedding) > match_threshold
  ORDER BY qh.question_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 5. Función RPC: Buscar opciones similares por embedding
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
    AND qo.option_embedding IS NOT NULL
    AND 1 - (qo.option_embedding <=> query_embedding) > match_threshold
  ORDER BY qo.option_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 6. Función para limpiar preguntas genéricas existentes (OPCIONAL - ejecutar manualmente si deseas)
-- ADVERTENCIA: Esto borrará preguntas que contengan opciones genéricas
/*
DELETE FROM question_options 
WHERE option_text ILIKE '%detalle superficial%'
   OR option_text ILIKE '%información no relacionada%'
   OR option_text ILIKE '%definición técnica precisa sobre%'
   OR option_text ILIKE '%concepto erróneo común%'
   OR option_text ILIKE '%definición opuesta%';

-- Borrar preguntas huérfanas (sin opciones)
DELETE FROM questions_history qh
WHERE NOT EXISTS (
    SELECT 1 FROM question_options qo WHERE qo.question_id = qh.id
);
*/

-- 7. Verificar que todo está configurado
SELECT 
    'questions_history' as table_name,
    COUNT(*) as total_rows,
    COUNT(question_embedding) as with_embedding,
    COUNT(question_hash) as with_hash
FROM questions_history
UNION ALL
SELECT 
    'question_options' as table_name,
    COUNT(*) as total_rows,
    COUNT(option_embedding) as with_embedding,
    NULL as with_hash
FROM question_options;

-- FIN DEL SCRIPT
