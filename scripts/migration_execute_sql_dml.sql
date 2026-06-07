-- Migration: upgrade execute_sql to support INSERT/UPDATE/DELETE with RETURNING
--
-- The original execute_sql function used `FROM (%s) t` which is invalid PostgreSQL
-- syntax for DML statements (INSERT/UPDATE/DELETE cannot appear in a FROM subquery).
-- This caused confirmCoursePlan to fail with:
--   "SQL Error: syntax error at or near \"INTO\""
--
-- Run this in the Supabase SQL Editor for each tenant that has the old function.

-- Drop first: Supabase may have the function with a different return type signature
-- (e.g. SETOF record or text), which prevents CREATE OR REPLACE from working.
DROP FUNCTION IF EXISTS public.execute_sql(text);

CREATE OR REPLACE FUNCTION public.execute_sql(query text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    result json;
    is_dml boolean;
BEGIN
    is_dml := query ~* '^\s*(INSERT|UPDATE|DELETE)\b';
    IF is_dml AND query ~* '\bRETURNING\b' THEN
        -- DML with RETURNING: wrap in a CTE so rows are selectable
        EXECUTE format(
            'WITH __r AS (%s) SELECT COALESCE(json_agg(t), ''[]''::json) FROM __r t',
            query
        ) INTO result;
    ELSIF is_dml THEN
        -- DML without RETURNING: execute and return empty array
        EXECUTE query;
        result := '[]'::json;
    ELSE
        -- SELECT and other read-only queries
        EXECUTE format(
            'SELECT COALESCE(json_agg(t), ''[]''::json) FROM (%s) t',
            query
        ) INTO result;
    END IF;
    RETURN COALESCE(result, '[]'::json);
END; $$;

GRANT EXECUTE ON FUNCTION public.execute_sql(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_sql(text) TO service_role;
