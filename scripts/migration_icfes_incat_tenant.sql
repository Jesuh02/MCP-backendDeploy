-- ============================================================
-- Migration: ICFES student-tracking tables for INCAT tenant
-- Apply to: INCAT production DB (gzckzrocfmhsizlrnqep)
-- ============================================================
--
-- NOTE: FK constraints to icfes_areas, icfes_questions,
-- icfes_question_options, and icfes_subtopics are intentionally
-- OMITTED. Those catalogs live in the QA (question-bank) database,
-- not in this tenant database. IDs are stored as plain bigints.
-- The only local FKs are to public.usuarios(id) since students
-- are registered in this tenant.
-- ============================================================

-- 1. Exam sessions
CREATE TABLE IF NOT EXISTS public.icfes_exam_sessions (
  id          bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  student_id  bigint NOT NULL,
  area_id     smallint NOT NULL,            -- QA icfes_areas(id) — no cross-DB FK
  redis_key   text UNIQUE,
  status      text NOT NULL DEFAULT 'active'
              CHECK (status = ANY (ARRAY['active','completed','expired','abandoned'])),
  started_at  timestamp with time zone DEFAULT now(),
  expires_at  timestamp with time zone NOT NULL,
  finished_at timestamp with time zone,
  score       numeric,
  CONSTRAINT icfes_exam_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT icfes_exam_sessions_student_fkey
    FOREIGN KEY (student_id) REFERENCES public.usuarios(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_icfes_exam_sessions_student
  ON public.icfes_exam_sessions (student_id);

CREATE INDEX IF NOT EXISTS idx_icfes_exam_sessions_status
  ON public.icfes_exam_sessions (status);

-- 2. Session ↔ question binding (ordered list of 20 questions per session)
CREATE TABLE IF NOT EXISTS public.icfes_session_questions (
  session_id  bigint NOT NULL,
  question_id bigint NOT NULL,             -- QA icfes_questions(id) — no cross-DB FK
  order_index smallint NOT NULL CHECK (order_index >= 1 AND order_index <= 20),
  CONSTRAINT icfes_session_questions_pkey PRIMARY KEY (session_id, order_index),
  CONSTRAINT icfes_session_questions_session_fkey
    FOREIGN KEY (session_id) REFERENCES public.icfes_exam_sessions(id) ON DELETE CASCADE
);

-- 3. Per-question student attempts
CREATE TABLE IF NOT EXISTS public.icfes_attempts (
  id                 bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  student_id         bigint NOT NULL,
  session_id         bigint,
  question_id        bigint NOT NULL,       -- QA icfes_questions(id) — no cross-DB FK
  selected_option_id bigint,               -- QA icfes_question_options(id) — no cross-DB FK
  is_correct         boolean NOT NULL,
  response_time_ms   integer NOT NULL CHECK (response_time_ms >= 0),
  answered_at        timestamp with time zone DEFAULT now(),
  CONSTRAINT icfes_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT icfes_attempts_student_fkey
    FOREIGN KEY (student_id) REFERENCES public.usuarios(id) ON DELETE CASCADE,
  CONSTRAINT icfes_attempts_session_fkey
    FOREIGN KEY (session_id) REFERENCES public.icfes_exam_sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_icfes_attempts_student
  ON public.icfes_attempts (student_id);

CREATE INDEX IF NOT EXISTS idx_icfes_attempts_question
  ON public.icfes_attempts (question_id);

-- 4. Adaptive skill metrics per student × subtopic
CREATE TABLE IF NOT EXISTS public.icfes_skill_metrics (
  id                    bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  student_id            bigint NOT NULL,
  subtopic_id           bigint NOT NULL,    -- QA icfes_subtopics(id) — no cross-DB FK
  error_rate            real NOT NULL DEFAULT 0 CHECK (error_rate >= 0 AND error_rate <= 1),
  time_normalized       real NOT NULL DEFAULT 0,
  error_pattern_score   real NOT NULL DEFAULT 0 CHECK (error_pattern_score >= 0 AND error_pattern_score <= 1),
  recovery_curve_score  real NOT NULL DEFAULT 0 CHECK (recovery_curve_score >= 0 AND recovery_curve_score <= 1),
  falencia_score        real NOT NULL DEFAULT 0 CHECK (falencia_score >= 0 AND falencia_score <= 1),
  attempts_count        integer NOT NULL DEFAULT 0,
  updated_at            timestamp with time zone DEFAULT now(),
  CONSTRAINT icfes_skill_metrics_pkey PRIMARY KEY (id),
  CONSTRAINT icfes_skill_metrics_student_fkey
    FOREIGN KEY (student_id) REFERENCES public.usuarios(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_icfes_skill_metrics_student_subtopic
  ON public.icfes_skill_metrics (student_id, subtopic_id);

-- ============================================================
-- Enable Row Level Security (mirror QA policies)
-- ============================================================

ALTER TABLE public.icfes_exam_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.icfes_session_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.icfes_attempts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.icfes_skill_metrics     ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically; the following policies
-- allow authenticated users to access only their own rows.

CREATE POLICY IF NOT EXISTS "students_own_sessions"
  ON public.icfes_exam_sessions
  FOR ALL USING (student_id = (auth.uid())::bigint);

CREATE POLICY IF NOT EXISTS "students_own_session_questions"
  ON public.icfes_session_questions
  FOR ALL USING (
    session_id IN (
      SELECT id FROM public.icfes_exam_sessions
      WHERE student_id = (auth.uid())::bigint
    )
  );

CREATE POLICY IF NOT EXISTS "students_own_attempts"
  ON public.icfes_attempts
  FOR ALL USING (student_id = (auth.uid())::bigint);

CREATE POLICY IF NOT EXISTS "students_own_skill_metrics"
  ON public.icfes_skill_metrics
  FOR ALL USING (student_id = (auth.uid())::bigint);
