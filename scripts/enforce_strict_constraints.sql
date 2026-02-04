-- 1. Cleaning up invalid data (Null embeddings or hashes)
DELETE FROM public.question_options
WHERE option_embedding IS NULL;

DELETE FROM public.questions_history
WHERE question_embedding IS NULL OR question_hash IS NULL;

-- 2. Enforcing constraints to prevent future corruption
ALTER TABLE public.questions_history 
ALTER COLUMN question_embedding SET NOT NULL;

ALTER TABLE public.questions_history 
ALTER COLUMN question_hash SET NOT NULL;

ALTER TABLE public.question_options
ALTER COLUMN option_embedding SET NOT NULL;
