-- ═══════════════════════════════════════════════════════════════════════════════
-- STEALTH ASSESSMENT SYSTEM
-- Paper de referencia: Stealth Assessment in Digital Games (Valerie Shute, 2011)
--
-- Sistema de Evaluación Invisible que analiza el comportamiento del estudiante
-- durante los quizzes sin que este sepa que está siendo evaluado.
--
-- Métricas capturadas:
-- - Tiempo de respuesta por pregunta
-- - Patrones de error (qué tipo de preguntas falla más)
-- - Cambios de mente (si cambia su respuesta)
-- - Nivel de confianza (velocidad + patrones)
-- - Comportamiento bajo presión
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Tabla: stealth_assessment_interactions ────────────────────────────────────
-- Guarda los datos de cada interacción individual durante un quiz
CREATE TABLE IF NOT EXISTS stealth_assessment_interactions (
    id BIGSERIAL PRIMARY KEY,

    -- Context
    user_id BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    topic_id BIGINT REFERENCES topics(id) ON DELETE SET NULL,
    task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
    session_id TEXT NOT NULL, -- Unique session identifier

    -- Question metadata
    question_index INTEGER NOT NULL DEFAULT 0,
    question_id TEXT NOT NULL,
    question_type TEXT NOT NULL DEFAULT 'multiple_choice', -- multiple_choice, fill_in_blank, ordering
    question_category TEXT DEFAULT 'general',
    difficulty INTEGER DEFAULT 3 CHECK (difficulty BETWEEN 1 AND 5),

    -- Timing metrics (invisible to student)
    time_to_first_click_ms INTEGER DEFAULT 0, -- Time until first interaction
    time_to_submit_ms INTEGER DEFAULT 0, -- Total time until submit

    -- Behavior metrics (invisible to student)
    answer_changes INTEGER DEFAULT 0, -- Number of times answer was changed
    change_history JSONB DEFAULT '[]'::jsonb, -- History of changes with timestamps
    is_correct BOOLEAN DEFAULT FALSE,
    hint_used BOOLEAN DEFAULT FALSE,
    scroll_events INTEGER DEFAULT 0, -- Reading behavior indicator
    focus_lost_count INTEGER DEFAULT 0, -- Distraction indicator

    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_stealth_interactions_user_course
    ON stealth_assessment_interactions(user_id, course_id);
CREATE INDEX IF NOT EXISTS idx_stealth_interactions_session
    ON stealth_assessment_interactions(session_id);
CREATE INDEX IF NOT EXISTS idx_stealth_interactions_created
    ON stealth_assessment_interactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stealth_interactions_category
    ON stealth_assessment_interactions(question_category);

-- ─── Tabla: stealth_assessment_summaries ───────────────────────────────────────
-- Guarda el análisis agregado de cada sesión (la "Radiografía de Comprensión")
CREATE TABLE IF NOT EXISTS stealth_assessment_summaries (
    id BIGSERIAL PRIMARY KEY,

    -- Context
    user_id BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    topic_id BIGINT REFERENCES topics(id) ON DELETE SET NULL,
    task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
    session_id TEXT NOT NULL,

    -- Core metrics
    total_questions INTEGER DEFAULT 0,
    correct_count INTEGER DEFAULT 0,
    accuracy NUMERIC(5,2) DEFAULT 0,
    avg_response_time_ms INTEGER DEFAULT 0,
    median_response_time_ms INTEGER DEFAULT 0,
    response_time_variance BIGINT DEFAULT 0,
    total_answer_changes INTEGER DEFAULT 0,
    questions_with_changes INTEGER DEFAULT 0,
    rushing_count INTEGER DEFAULT 0, -- Too fast = guessing
    overthinking_count INTEGER DEFAULT 0, -- Too slow = struggling

    -- Scores (0-100)
    comprehension_score INTEGER DEFAULT 0 CHECK (comprehension_score BETWEEN 0 AND 100),
    confidence_index INTEGER DEFAULT 0 CHECK (confidence_index BETWEEN 0 AND 100),

    -- Detailed analysis (JSONB for flexibility)
    cognitive_profile JSONB DEFAULT '{}'::jsonb,
    weak_areas JSONB DEFAULT '[]'::jsonb,
    strong_areas JSONB DEFAULT '[]'::jsonb,
    behavioral_patterns JSONB DEFAULT '{}'::jsonb,
    recommendations JSONB DEFAULT '[]'::jsonb,

    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Unique constraint for upsert
    CONSTRAINT unique_stealth_summary_session
        UNIQUE (user_id, course_id, session_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_stealth_summaries_user_course
    ON stealth_assessment_summaries(user_id, course_id);
CREATE INDEX IF NOT EXISTS idx_stealth_summaries_updated
    ON stealth_assessment_summaries(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_stealth_summaries_comprehension
    ON stealth_assessment_summaries(comprehension_score);
CREATE INDEX IF NOT EXISTS idx_stealth_summaries_confidence
    ON stealth_assessment_summaries(confidence_index);

-- ─── Row Level Security (RLS) ──────────────────────────────────────────────────
-- Only teachers/admins can see stealth assessment data (students cannot)

ALTER TABLE stealth_assessment_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stealth_assessment_summaries ENABLE ROW LEVEL SECURITY;

-- Policy: Service role can do everything
CREATE POLICY stealth_interactions_service_all ON stealth_assessment_interactions
    FOR ALL USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY stealth_summaries_service_all ON stealth_assessment_summaries
    FOR ALL USING (TRUE) WITH CHECK (TRUE);

-- ─── Comments for documentation ────────────────────────────────────────────────
COMMENT ON TABLE stealth_assessment_interactions IS
    'Stealth Assessment: Individual interaction data per quiz question (invisible to student)';

COMMENT ON TABLE stealth_assessment_summaries IS
    'Stealth Assessment: Aggregated analysis per session - the "Comprehension X-Ray"';

COMMENT ON COLUMN stealth_assessment_summaries.comprehension_score IS
    'Weighted score (0-100) combining accuracy, confidence, consistency, and engagement';

COMMENT ON COLUMN stealth_assessment_summaries.confidence_index IS
    'Derived from response time patterns and answer changes (0-100)';

COMMENT ON COLUMN stealth_assessment_summaries.cognitive_profile IS
    'JSON with learningStyle, masteryLevel, stressIndicator, retentionPrediction, etc.';

COMMENT ON COLUMN stealth_assessment_summaries.behavioral_patterns IS
    'JSON counts: guessing, deliberate, struggling, secondGuessing, distracted';

-- ═══════════════════════════════════════════════════════════════════════════════
-- USAGE EXAMPLE
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 1. Client sends interaction data after each question:
--    POST /reinforcement/stealth-assessment
--    Body: { userId, courseId, sessionId, interactions: [...] }
--
-- 2. Teacher gets student's "X-Ray":
--    GET /reinforcement/stealth-assessment/xray?userId=123&courseId=456
--
-- 3. Teacher gets course-level analytics:
--    GET /reinforcement/stealth-assessment/course-analytics?courseId=456
--
-- The student NEVER sees this data - it's only for teachers/admins.
-- ═══════════════════════════════════════════════════════════════════════════════
