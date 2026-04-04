-- =================================================================
-- FIX: Trigger fn_check_certificate_ganado usa tabla renombrada
--
-- Problema:
--   migration_certificates_integrity.sql creó el trigger
--   fn_check_certificate_ganado referenciando public.progreso_estudiante.
--   Luego split_progreso_estudiante.sql renombró esa tabla a
--   public.progreso_curso y eliminó la columna materia_id.
--   Ahora todo INSERT/UPDATE en certificates falla con:
--     "relation "public.progreso_estudiante" does not exist"
--
-- Solución:
--   Re-crear fn_check_certificate_ganado usando progreso_curso
--   (sin condición materia_id IS NULL, que ya no existe).
--
-- Ejecutar en Supabase SQL Editor (una sola vez).
-- =================================================================

CREATE OR REPLACE FUNCTION public.fn_check_certificate_ganado()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.progreso_curso
        WHERE usuario_estudiante = NEW.user_id
          AND curso_id            = NEW.course_id
          AND estado              = 'Ganado'
    ) THEN
        RAISE EXCEPTION
            'No se puede emitir el certificado: el estudiante % no ha ganado el curso % (estado != Ganado)',
            NEW.user_id, NEW.course_id;
    END IF;
    RETURN NEW;
END;
$$;

-- El trigger en sí no necesita re-crearse; solo la función cambia.
-- Verificación:
-- SELECT proname, prosrc FROM pg_proc WHERE proname = 'fn_check_certificate_ganado';
