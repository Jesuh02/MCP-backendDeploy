#!/usr/bin/env node
/**
 * icfes_fill_lc2022_reading_passages.mjs
 *
 * Corrige las preguntas de Lectura Crítica 2022 que tienen el pasaje embebido
 * en `stem` (o un placeholder `[...]`) en lugar de en `reading_passage`.
 *
 * Estrategia por grupo de preguntas:
 *   1. "Líder" (primera pregunta del grupo, ej. LC-2022-Q01): su stem contiene
 *      el pasaje completo intercalado. Se extrae el pasaje (todo entre la línea
 *      de encabezado y la pregunta final) y se mueve a `reading_passage`.
 *      El stem queda solo con el texto de la pregunta.
 *
 *   2. "Seguidores" (Q02, Q03, etc.): su stem tiene un `[placeholder]` o un
 *      bloque de contexto citado. Se les asigna el mismo pasaje que al líder
 *      y el stem se limpia dejando solo el texto de la pregunta (+ contexto
 *      citado, si aplica).
 *
 * Variables de entorno requeridas (al menos una):
 *   DATABASE_URL             Conexión Postgres directa (Supabase / Railway)
 *   SUPABASE_URL + SUPABASE_SERVICE_KEY  Alternativa via Supabase client
 *
 * Flags CLI:
 *   --dry-run    Imprime los cambios sin escribir en la BD.
 *   --force      Reescribe incluso si reading_passage ya tiene valor.
 *
 * Uso:
 *   node scripts/icfes_fill_lc2022_reading_passages.mjs --dry-run
 *   node scripts/icfes_fill_lc2022_reading_passages.mjs
 */

import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

const { Pool } = pg

// ── CLI args ──────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const FORCE   = args.includes('--force')

// ── DB connection ─────────────────────────────────────────────────────────────
const DATABASE_URL     = process.env.DATABASE_URL
const SUPABASE_URL     = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
const USE_SUPABASE     = !DATABASE_URL && !!SUPABASE_URL && !!SUPABASE_SERVICE_KEY

if (!DATABASE_URL && !USE_SUPABASE) {
  console.error('ERROR: Define DATABASE_URL, o bien SUPABASE_URL + SUPABASE_SERVICE_KEY.')
  process.exit(1)
}

function inferSsl(url) {
  if (/sslmode=disable/i.test(url)) return false
  if (/\b(supabase\.co|supabase\.net|neon\.tech|railway\.app|rds\.amazonaws\.com)\b/i.test(url))
    return { rejectUnauthorized: false }
  return false
}

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: inferSsl(DATABASE_URL) })
  : null

const supabase = USE_SUPABASE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null

// ── Question groups ───────────────────────────────────────────────────────────
// Each group: the leader's stem embeds the full passage.
// The followers use the same passage but have a placeholder or brief context.
const GROUPS = [
  {
    leader:  'LC-2022-Q01',
    members: ['LC-2022-Q01', 'LC-2022-Q02', 'LC-2022-Q03'],
  },
  {
    leader:  'LC-2022-Q04',
    members: ['LC-2022-Q04', 'LC-2022-Q05', 'LC-2022-Q06', 'LC-2022-Q07'],
  },
  {
    leader:  'LC-2022-Q08',
    members: ['LC-2022-Q08', 'LC-2022-Q09', 'LC-2022-Q10', 'LC-2022-Q11'],
  },
  {
    leader:  'LC-2022-Q12',
    members: ['LC-2022-Q12', 'LC-2022-Q13', 'LC-2022-Q14', 'LC-2022-Q15', 'LC-2022-Q16'],
  },
  {
    leader:  'LC-2022-Q17',
    members: ['LC-2022-Q17', 'LC-2022-Q18', 'LC-2022-Q19', 'LC-2022-Q20'],
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Splits a leader stem into { passage, question }.
 * Stem format: "HEADER\n\nPASSAGE_PARA1\n\nPASSAGE_PARA2\n\n...\n\nQUESTION"
 * The question is always the LAST paragraph; the passage is everything in between.
 */
function splitLeaderStem(stem) {
  const parts = stem.replace(/\r\n/g, '\n').split('\n\n')
  const passage  = parts.slice(1, -1).join('\n\n').trim()
  const question = parts[parts.length - 1].trim()
  return { passage, question }
}

function cleanFollowerStem(stem) {
  const parts = stem.replace(/\r\n/g, '\n').split('\n\n')
  const secondPara = (parts[1] || '').trim()
  const isPurePlaceholder = /^\[[\s\S]*\]$/.test(secondPara)

  if (isPurePlaceholder) {
    // Drop header (parts[0]) + placeholder (parts[1]), keep the rest
    return parts.slice(2).join('\n\n').trim()
  } else {
    // Drop only the header (parts[0]), keep everything else (contextual content + question)
    return parts.slice(1).join('\n\n').trim()
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function fetchGroup(client, members) {
  if (pool) {
    const { rows } = await client.query(
      `SELECT id, source_reference, stem, reading_passage
         FROM public.icfes_questions
        WHERE source_reference = ANY($1)
        ORDER BY source_reference`,
      [members],
    )
    return rows
  }
  // Supabase JS path
  const { data, error } = await supabase
    .from('icfes_questions')
    .select('id, source_reference, stem, reading_passage')
    .in('source_reference', members)
    .order('source_reference')
  if (error) throw new Error(`Supabase select failed: ${error.message}`)
  return data || []
}

async function updateQuestion(client, id, stem, reading_passage) {
  if (pool) {
    await client.query(
      `UPDATE public.icfes_questions
          SET stem            = $1,
              reading_passage = $2,
              updated_at      = now()
        WHERE id = $3`,
      [stem, reading_passage, id],
    )
    return
  }
  // Supabase JS path
  const { error } = await supabase
    .from('icfes_questions')
    .update({ stem, reading_passage, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(`Supabase update failed: ${error.message}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const client = pool ? await pool.connect() : null
  try {
    if (client) await client.query('BEGIN')

    let totalUpdated = 0

    for (const group of GROUPS) {
      const rows = await fetchGroup(client, group.members)

      if (!rows.length) {
        console.warn(`⚠️  Group ${group.leader}: no questions found — skipping.`)
        continue
      }

      const leaderRow = rows.find(r => r.source_reference === group.leader)
      if (!leaderRow) {
        console.warn(`⚠️  Leader ${group.leader} not found — skipping group.`)
        continue
      }

      const { passage, question: leaderQuestion } = splitLeaderStem(leaderRow.stem)

      if (!passage || passage.length < 20) {
        console.warn(`⚠️  ${group.leader}: extracted passage too short (${passage?.length ?? 0} chars) — skipping.`)
        continue
      }

      console.log(`\n📖  Group: ${group.leader}`)
      console.log(`    Passage (${passage.length} chars): ${passage.slice(0, 80).replace(/\n/g, '↵')}…`)

      for (const row of rows) {
        const isLeader = row.source_reference === group.leader

        if (row.reading_passage && !FORCE) {
          console.log(`    ✅ ${row.source_reference} already has reading_passage — skip.`)
          continue
        }

        const newStem = isLeader
          ? leaderQuestion
          : cleanFollowerStem(row.stem)

        if (DRY_RUN) {
          console.log(`    [DRY-RUN] ${row.source_reference}`)
          console.log(`      stem → "${newStem.slice(0, 80).replace(/\n/g, '↵')}…"`)
          console.log(`      reading_passage → "${passage.slice(0, 60).replace(/\n/g, '↵')}…"`)
          continue
        }

        await updateQuestion(client, row.id, newStem, passage)
        totalUpdated++
        console.log(`    ✅ ${row.source_reference} updated.`)
      }
    }

    if (DRY_RUN) {
      if (client) await client.query('ROLLBACK')
      console.log('\n🔍  Dry-run: no changes committed.')
    } else {
      if (client) await client.query('COMMIT')
      console.log(`\n✅  Done. ${totalUpdated} questions updated.`)
    }
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    console.error('❌  Error:', err.message)
    throw err
  } finally {
    if (client) client.release()
    if (pool) await pool.end()
  }
}

run().catch(() => process.exit(1))
