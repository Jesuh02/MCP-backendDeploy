-- =============================================================================
-- Migration: subject_access_blocks
-- Objetivo: registrar bloqueos de acceso a materias por usuario.
--
-- Decisiones de diseño (3NF):
--   · course_id se OMITE de la tabla porque es una dependencia transitiva:
--     subject_id → subjects.course_id  (ya está normalizada en subjects).
--     Incluirlo violaría la Tercera Forma Normal (3FN).
--   · Se expone a través de la vista v_subject_access_blocks para retrocompatibilidad.
--   · Campos de auditoría completos: creación, modificación y desbloqueo.
--   · Soft-delete con is_active + unblocked_at/unblocked_by para mantener historial.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabla principal (normalizada)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subject_access_blocks (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Entidades involucradas
    user_id        bigint NOT NULL
                       REFERENCES public.usuarios(id)
                       ON UPDATE CASCADE ON DELETE CASCADE,
    subject_id     bigint NOT NULL
                       REFERENCES public.subjects(id)
                       ON UPDATE CASCADE ON DELETE CASCADE,
    -- NOTA: course_id omitido — se deriva de subject_id → subjects.course_id (3NF)

    -- Contenido del bloqueo
    reason         text    NOT NULL CHECK (char_length(trim(reason)) > 0),
    is_active      boolean NOT NULL DEFAULT true,  -- false = desbloqueo (soft-delete)

    -- Auditoría: alta
    blocked_at     timestamptz NOT NULL DEFAULT now(),
    blocked_by     bigint NULL
                       REFERENCES public.usuarios(id)
                       ON UPDATE CASCADE ON DELETE SET NULL,

    -- Auditoría: modificación
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     bigint NULL
                       REFERENCES public.usuarios(id)
                       ON UPDATE CASCADE ON DELETE SET NULL,

    -- Auditoría: baja (desbloqueo)
    unblocked_at   timestamptz NULL,
    unblocked_by   bigint NULL
                       REFERENCES public.usuarios(id)
                       ON UPDATE CASCADE ON DELETE SET NULL,

    -- Un usuario sólo puede tener un registro de bloqueo por materia
    CONSTRAINT subject_access_blocks_user_subject_unique UNIQUE (user_id, subject_id)
);

COMMENT ON TABLE  public.subject_access_blocks                IS 'Bloqueos de acceso de un usuario a una materia. Normalizada en 3FN; course_id se obtiene vía subjects.';
COMMENT ON COLUMN public.subject_access_blocks.is_active      IS 'true = bloqueado activo. false = desbloqueado (soft-delete para conservar historial).';
COMMENT ON COLUMN public.subject_access_blocks.unblocked_at   IS 'Timestamp del desbloqueo. NULL si el bloqueo sigue activo.';
COMMENT ON COLUMN public.subject_access_blocks.updated_at     IS 'Actualizado automáticamente por trigger fn_sab_set_updated_at.';

-- ---------------------------------------------------------------------------
-- 2. Trigger: mantener updated_at automáticamente
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_sab_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_sab_updated_at
    BEFORE UPDATE ON public.subject_access_blocks
    FOR EACH ROW EXECUTE FUNCTION public.fn_sab_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Índices (patrones de consulta más habituales)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sab_user_id
    ON public.subject_access_blocks USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_sab_subject_id
    ON public.subject_access_blocks USING btree (subject_id);

-- Consulta frecuente: "bloques activos de un usuario en una materia"
CREATE INDEX IF NOT EXISTS idx_sab_user_subject_active
    ON public.subject_access_blocks USING btree (user_id, subject_id)
    WHERE is_active = true;

-- Consulta frecuente: "todos los bloques activos de un usuario en un curso"
-- Incluye subject_id para que el índice cubra el JOIN con subjects.course_id
CREATE INDEX IF NOT EXISTS idx_sab_user_active
    ON public.subject_access_blocks USING btree (user_id)
    WHERE is_active = true;

-- ---------------------------------------------------------------------------
-- 4. Vista de compatibilidad (expone course_id sin desnormalizar la tabla)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_subject_access_blocks AS
SELECT
    sab.id,
    sab.user_id,
    sab.subject_id,
    s.course_id,          -- derivado de subjects (3NF)
    sab.reason,
    sab.is_active,
    sab.blocked_at,
    sab.blocked_by,
    sab.updated_at,
    sab.updated_by,
    sab.unblocked_at,
    sab.unblocked_by
FROM  public.subject_access_blocks sab
JOIN  public.subjects s ON s.id = sab.subject_id;

COMMENT ON VIEW public.v_subject_access_blocks IS
    'Vista de compatibilidad que incluye course_id (derivado vía subjects). Usar para consultas filtradas por curso.';

-- ---------------------------------------------------------------------------
-- 5. RLS (Row Level Security)
-- ---------------------------------------------------------------------------
ALTER TABLE public.subject_access_blocks ENABLE ROW LEVEL SECURITY;

-- El service-role del backend tiene acceso total (única vía de acceso — auth custom, no Supabase Auth)
-- NOTA: auth.uid() retorna uuid; usuarios.id es bigint → no existe conversión directa.
--       El acceso de usuarios se controla en la capa de aplicación (JWT propio), no vía RLS anon/authenticated.
CREATE POLICY "sab_service_role_all" ON public.subject_access_blocks
    FOR ALL TO service_role
    USING (true) WITH CHECK (true);
