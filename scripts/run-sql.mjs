#!/usr/bin/env node
/**
 * Ejecuta un archivo .sql contra DATABASE_URL.
 * Uso: node scripts/run-sql.mjs <path-to-file.sql>
 *
 * Reutiliza la misma lógica de autodetección SSL que pg-repository.js
 * (SRP: un solo archivo = un solo propósito).
 */

import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'
const { Client } = pg

function inferSslConfig(cs) {
    if (!cs) return false
    if (/sslmode=disable/i.test(cs)) return false
    if (/sslmode=(require|verify-ca|verify-full)/i.test(cs)) return { rejectUnauthorized: false }
    if (/\b(supabase\.co|supabase\.net|neon\.tech|railway\.app|rds\.amazonaws\.com)\b/i.test(cs)) {
        return { rejectUnauthorized: false }
    }
    return false
}

async function main() {
    const file = process.argv[2]
    if (!file) {
        console.error('Uso: node scripts/run-sql.mjs <archivo.sql>')
        process.exit(2)
    }
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
        console.error('DATABASE_URL no configurada. Añádela a .env (Supabase: Settings → Database → Connection string → URI).')
        process.exit(2)
    }

    const sql = await readFile(resolve(file), 'utf8')
    const client = new Client({ connectionString, ssl: inferSslConfig(connectionString) })
    await client.connect()
    try {
        console.log(`[sql] aplicando ${file}…`)
        await client.query(sql)
        console.log('[sql] OK')
    } catch (e) {
        console.error('[sql] FALLÓ:', e.message)
        process.exitCode = 1
    } finally {
        await client.end()
    }
}

main().catch((e) => { console.error(e); process.exit(1) })
