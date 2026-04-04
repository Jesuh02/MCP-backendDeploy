/**
 * migrationRunner.js
 * Ejecuta migraciones DDL al iniciar el servidor usando una conexión
 * directa a PostgreSQL (requiere DATABASE_URL en env).
 *
 * Problema que resuelve:
 *   El trigger fn_check_certificate_ganado en la tabla `certificates`
 *   todavía referencia public.progreso_estudiante (renombrada a progreso_curso).
 *   Supabase JS no puede ejecutar DDL vía PostgREST, así que necesitamos
 *   la conexión directa pg para correr el CREATE OR REPLACE FUNCTION.
 *
 * También crea la función execute_sql() en TODAS las bases de datos de tenant,
 * que es requerida por MCPService para ejecutar consultas dinámicas.
 *
 * Configuración (Railway > Variables):
 *   DATABASE_URL = postgres://postgres:<password>@db.<project>.supabase.co:5432/postgres
 *   TENANT_INCAT_DATABASE_URL = postgres://postgres:<password>@db.<project-incat>.supabase.co:5432/postgres
 *   Se obtiene en: Supabase Dashboard > Settings > Database > Connection string > URI
 */
import { logger } from '../logging/Logger.js';

// ─── Migración: arreglar trigger fn_check_certificate_ganado ───────────────
const FIX_TRIGGER_SQL = `
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
`;

// ─── Migración: crear execute_sql() para consultas dinámicas MCP ───────────
const EXECUTE_SQL_FN = `
CREATE OR REPLACE FUNCTION public.execute_sql(query text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    result json;
BEGIN
    EXECUTE format('SELECT COALESCE(json_agg(t), ''[]''::json) FROM (%s) t', query) INTO result;
    RETURN COALESCE(result, '[]'::json);
END;
$$;
`;

const EXECUTE_SQL_GRANTS = `
GRANT EXECUTE ON FUNCTION public.execute_sql(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_sql(text) TO service_role;
`;

/**
 * Collects all DATABASE_URLs: the primary + any TENANT_<ID>_DATABASE_URL env vars.
 * Returns an array of { label, databaseUrl }.
 */
function _collectDatabaseUrls() {
    const urls = [];

    const primary = process.env.DATABASE_URL;
    if (primary) {
        urls.push({ label: 'primary', databaseUrl: primary });
    }

    // Discover per-tenant DATABASE_URLs: TENANT_INCAT_DATABASE_URL, etc.
    const pattern = /^TENANT_([A-Z0-9_]+)_DATABASE_URL$/;
    for (const [key, value] of Object.entries(process.env)) {
        const m = pattern.exec(key);
        if (m && value) {
            urls.push({ label: m[1].toLowerCase(), databaseUrl: value });
        }
    }

    return urls;
}

/**
 * Ensures the execute_sql RPC function exists in a database.
 * @param {import('pg').Client} pgClient
 * @param {string} label — human-readable label for logging
 */
async function _ensureExecuteSqlFunction(pgClient, label) {
    try {
        const check = await pgClient.query(
            `SELECT 1 FROM pg_proc WHERE proname = 'execute_sql' AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')`
        );
        if (check.rows.length > 0) {
            logger.info(`  ✅ [${label}] execute_sql already exists`);
            return;
        }
        logger.info(`  🔧 [${label}] Creating execute_sql function...`);
        await pgClient.query(EXECUTE_SQL_FN);
        await pgClient.query(EXECUTE_SQL_GRANTS);
        logger.info(`  ✅ [${label}] execute_sql created successfully`);
    } catch (err) {
        logger.warn(`  ⚠️  [${label}] Failed to create execute_sql: ${err.message}`);
    }
}

/**
 * Intenta correr las migraciones DDL usando pg (conexión directa).
 * Si DATABASE_URL no está configurado, solo loguea un aviso y retorna.
 *
 * Runs on ALL discovered database URLs (primary + per-tenant).
 */
export async function runStartupMigrations() {
    const dbUrls = _collectDatabaseUrls();

    if (dbUrls.length === 0) {
        logger.warn(
            '⚠️  DATABASE_URL no está configurado. ' +
            'El trigger fn_check_certificate_ganado puede estar roto y execute_sql no se auto-creará. ' +
            'Configura DATABASE_URL en Railway con la URL de conexión directa de Supabase ' +
            '(Supabase Dashboard > Settings > Database > URI). ' +
            'Para tenants adicionales: TENANT_INCAT_DATABASE_URL, etc.'
        );
        return;
    }

    let pkg;
    try {
        // Import dinámico para no romper el servidor si pg no está instalado
        const mod = await import('pg');
        pkg = mod.default;
    } catch {
        logger.warn('⚠️  pg module not installed — skipping DDL migrations');
        return;
    }

    const { Client } = pkg;

    for (const { label, databaseUrl } of dbUrls) {
        let client;
        try {
            client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
            await client.connect();
            logger.info(`[MigrationRunner] Connected to ${label} database`);

            // ── execute_sql function (required for MCP queries) ──
            await _ensureExecuteSqlFunction(client, label);

            // ── Trigger migration (primary only — certificates table may not exist in all tenants) ──
            if (label === 'primary') {
                const checkResult = await client.query(
                    `SELECT prosrc FROM pg_proc WHERE proname = 'fn_check_certificate_ganado'`
                );
                const fnBody = (checkResult.rows[0] || {}).prosrc || '';
                if (fnBody.includes('progreso_estudiante')) {
                    logger.info('  🔧 Aplicando migración: fn_check_certificate_ganado → progreso_curso');
                    await client.query(FIX_TRIGGER_SQL);
                    logger.info('  ✅ Trigger fn_check_certificate_ganado actualizado a progreso_curso');
                } else {
                    logger.info('  ✅ Trigger fn_check_certificate_ganado ya usa progreso_curso — sin cambios');
                }
            }
        } catch (err) {
            logger.warn(`⚠️  [${label}] Migración falló: ${err.message}`);
            if (label === 'primary') {
                logger.warn('   La emisión de certificados puede fallar. Ejecuta manualmente:');
                logger.warn('   scripts/fix_trigger_certificates_progreso_curso.sql en Supabase SQL Editor');
            }
            logger.warn(`   Para execute_sql, ejecuta manualmente: scripts/migration_execute_sql_function.sql`);
        } finally {
            if (client) {
                try { await client.end(); } catch (_) { /* ignore */ }
            }
        }
    }
}