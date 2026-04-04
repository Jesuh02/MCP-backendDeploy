-- Migration: Add subject (materia) FK to progreso_estudiante
-- Also adds subject_id to topics to enable task → topic → subject chain

-- 1. Add subject_id to topics table (enables tracing task → topic → subject)
ALTER TABLE public.topics
  ADD COLUMN IF NOT EXISTS subject_id bigint NULL;

ALTER TABLE public.topics
  ADD CONSTRAINT topics_subject_id_fkey
  FOREIGN KEY (subject_id) REFERENCES public.subjects(id)
  ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_topics_subject_id
  ON public.topics USING btree (subject_id) TABLESPACE pg_default;

-- 2. Add materia_id to progreso_estudiante
ALTER TABLE public.progreso_estudiante
  ADD COLUMN IF NOT EXISTS materia_id bigint NULL;

ALTER TABLE public.progreso_estudiante
  ADD CONSTRAINT progreso_estudiante_materia_id_fkey
  FOREIGN KEY (materia_id) REFERENCES public.subjects(id)
  ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_progreso_estudiante_materia
  ON public.progreso_estudiante USING btree (materia_id) TABLESPACE pg_default;
