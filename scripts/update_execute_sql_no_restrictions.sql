-- ============================================================
-- ACTUALIZACIÓN DE FUNCIÓN execute_sql SIN RESTRICCIONES
-- ============================================================
-- Este script actualiza la función execute_sql para permitir
-- TODOS los tipos de consultas SQL sin bloquear "dangerous keywords".
--
-- IMPORTANTE: Ejecutar esto en Supabase SQL Editor como usuario con permisos.
-- ============================================================

-- Eliminar la función existente si existe
DROP FUNCTION IF EXISTS execute_sql(text);
DROP FUNCTION IF EXISTS execute_query(text);

-- ============================================================
-- FUNCIÓN execute_sql - SIN RESTRICCIONES
-- ============================================================
-- Esta función ejecuta cualquier consulta SQL y devuelve los resultados como JSONB.
-- NO tiene restricciones de keywords - puede ejecutar SELECT, INSERT, UPDATE, DELETE, 
-- CREATE, DROP, ALTER, TRUNCATE, etc.
--
-- USO: SELECT * FROM execute_sql('SELECT * FROM usuarios LIMIT 10');
-- ============================================================

CREATE OR REPLACE FUNCTION execute_sql(query text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER -- Ejecuta con permisos del dueño de la función
SET search_path = public
AS $$
DECLARE
    result jsonb;
BEGIN
    -- Ejecutar la consulta dinámica y convertir a JSON
    EXECUTE format('SELECT COALESCE(jsonb_agg(row_to_json(t)), ''[]''::jsonb) FROM (%s) t', query)
    INTO result;
    
    RETURN result;
EXCEPTION
    WHEN OTHERS THEN
        -- Devolver el error como JSON para que el LLM pueda auto-corregirse
        RETURN jsonb_build_object(
            'error', true,
            'message', SQLERRM,
            'code', SQLSTATE,
            'query', query
        );
END;
$$;

-- ============================================================
-- FUNCIÓN execute_query - ALIAS DE execute_sql
-- ============================================================
-- Alias alternativo para compatibilidad

CREATE OR REPLACE FUNCTION execute_query(query_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN execute_sql(query_text);
END;
$$;

-- ============================================================
-- PERMISOS: Permitir que usuarios autenticados y service_role usen estas funciones
-- ============================================================
GRANT EXECUTE ON FUNCTION execute_sql(text) TO authenticated;
GRANT EXECUTE ON FUNCTION execute_sql(text) TO service_role;
GRANT EXECUTE ON FUNCTION execute_sql(text) TO anon;

GRANT EXECUTE ON FUNCTION execute_query(text) TO authenticated;
GRANT EXECUTE ON FUNCTION execute_query(text) TO service_role;
GRANT EXECUTE ON FUNCTION execute_query(text) TO anon;

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
-- Probar que las funciones funcionan correctamente

-- Test SELECT simple
SELECT execute_sql('SELECT 1 as test, ''hola'' as mensaje');

-- Test consulta a tabla real
SELECT execute_sql('SELECT id, username FROM usuarios LIMIT 3');

-- Test con COUNT (agregación)
SELECT execute_sql('SELECT COUNT(*) as total FROM usuarios');

-- Test con JOIN
SELECT execute_sql('SELECT c.title, u.username FROM courses c JOIN usuarios u ON c.creator_user_id = u.id LIMIT 5');

-- ============================================================
-- NOTAS DE SEGURIDAD
-- ============================================================
-- ⚠️ ADVERTENCIA: Esta función permite ejecutar CUALQUIER SQL.
-- 
-- Si necesitas restricciones específicas (por ejemplo, solo SELECT), 
-- puedes crear una versión diferente:
--
-- CREATE OR REPLACE FUNCTION execute_sql_readonly(query text)
-- RETURNS jsonb
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- AS $$
-- BEGIN
--     IF NOT (query ~* '^\\s*SELECT') THEN
--         RETURN jsonb_build_object('error', true, 'message', 'Solo se permiten consultas SELECT');
--     END IF;
--     RETURN execute_sql(query);
-- END;
-- $$;
