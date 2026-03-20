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
 * Configuración (Railway > Variables):
 *   DATABASE_URL = postgres://postgres:<password>@db.<project>.supabase.co:5432/postgres
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

/**
 * Intenta correr las migraciones DDL usando pg (conexión directa).
 * Si DATABASE_URL no está configurado, solo loguea un aviso y retorna.
 */
export async function runStartupMigrations() {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
        logger.warn(
            '⚠️  DATABASE_URL no está configurado. ' +
            'El trigger fn_check_certificate_ganado puede estar roto. ' +
            'Configura DATABASE_URL en Railway con la URL de conexión directa de Supabase ' +
            '(Supabase Dashboard > Settings > Database > URI).'
        );
        return;
    }

    let client;
    try {
        // Import dinámico para no romper el servidor si pg no está instalado
        const { default: pkg } = await
        import ('pg');
        const { Client } = pkg;

        client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
        await client.connect();

        // Verificar si el trigger todavía apunta a la tabla vieja
        const checkResult = await client.query(
            `SELECT prosrc FROM pg_proc WHERE proname = 'fn_check_certificate_ganado'`
        );

        const fnBody = (checkResult.rows[0] || {}).prosrc || '';
        if (fnBody.includes('progreso_estudiante')) {
            logger.info('🔧 Aplicando migración: fn_check_certificate_ganado → progreso_curso');
            await client.query(FIX_TRIGGER_SQL);
            logger.info('✅ Trigger fn_check_certificate_ganado actualizado a progreso_curso');
        } else {
            logger.info('✅ Trigger fn_check_certificate_ganado ya usa progreso_curso — sin cambios');
        }
    } catch (err) {
        logger.warn(`⚠️  No se pudo ejecutar la migración del trigger: ${err.message}`);
        logger.warn('   La emisión de certificados puede fallar. Ejecuta manualmente:');
        logger.warn('   scripts/fix_trigger_certificates_progreso_curso.sql en Supabase SQL Editor');
    } finally {
        if (client) {
            try { await client.end(); } catch (_) { /* ignore */ }
        }
    }
}