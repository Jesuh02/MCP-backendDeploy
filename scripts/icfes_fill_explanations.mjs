#!/usr/bin/env node
/**
 * icfes_fill_explanations.mjs
 *
 * Rellena el campo `explanation` de las preguntas en `public.icfes_questions`
 * que NO tienen explicación. Para cada pregunta:
 *   1. Carga el enunciado (stem) y todas las opciones (icfes_question_options).
 *   2. Identifica la opción correcta (is_correct = true).
 *   3. Llama a un LLM (OpenRouter o DeepSeek, los mismos que usa el backend)
 *      pidiéndole una explicación pedagógica en español, justificando por qué
 *      la opción correcta lo es.
 *   4. UPDATE icfes_questions SET explanation = ..., updated_at = now().
 *
 * Variables de entorno requeridas:
 *   - DATABASE_URL                    Conexión Postgres (Supabase / Railway / etc.)
 *   - Una de:
 *       OPENROUTER_API_KEY            (recomendado)
 *       DEEPSEEK_API_KEY
 *
 * Variables opcionales:
 *   - OPENROUTER_CHAT_MODEL           default: qwen/qwen-2.5-72b-instruct
 *   - DEEPSEEK_MODEL                  default: deepseek-chat
 *   - DEEPSEEK_BASE_URL               default: https://api.deepseek.com
 *
 * Flags CLI:
 *   --dry-run        No escribe en la BD; solo imprime lo que generaría.
 *   --limit=N        Procesa como máximo N preguntas (default: todas).
 *   --concurrency=N  Llamadas LLM en paralelo (default: 3).
 *   --ids=1,2,3      Solo procesa esos question.id (separados por coma).
 *
 * Uso:
 *   node scripts/icfes_fill_explanations.mjs --dry-run --limit=5
 *   node scripts/icfes_fill_explanations.mjs --concurrency=4
 */

import pg from 'pg'
import axios from 'axios'
import { createClient } from '@supabase/supabase-js'

const { Pool } = pg

// ---------- CLI args ----------
const args = process.argv.slice(2)
const getFlag = (name) => args.find((a) => a === `--${name}`) !== undefined
const getOpt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : null
}

const DRY_RUN = getFlag('dry-run')
const LIMIT = Number(getOpt('limit')) || null
const CONCURRENCY = Math.max(1, Number(getOpt('concurrency')) || 3)
const ID_FILTER = (getOpt('ids') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isFinite(n))

// ---------- DB ----------
function inferSslConfig(connectionString) {
  if (!connectionString) return false
  if (/sslmode=disable/i.test(connectionString)) return false
  if (/sslmode=(require|verify-ca|verify-full)/i.test(connectionString)) {
    return { rejectUnauthorized: false }
  }
  if (/\b(supabase\.co|supabase\.net|neon\.tech|railway\.app|rds\.amazonaws\.com)\b/i.test(connectionString)) {
    return { rejectUnauthorized: false }
  }
  return false
}

const DATABASE_URL = process.env.DATABASE_URL
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY

const USE_SUPABASE = !DATABASE_URL && !!SUPABASE_URL && !!SUPABASE_SERVICE_KEY

if (!DATABASE_URL && !USE_SUPABASE) {
  console.error(
    '❌ Configura DATABASE_URL, o bien SUPABASE_URL + SUPABASE_SERVICE_KEY',
  )
  process.exit(1)
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      max: Math.max(2, CONCURRENCY + 1),
      ssl: inferSslConfig(DATABASE_URL),
    })
  : null

const supabase = USE_SUPABASE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
    })
  : null

// ---------- LLM ----------
const HAS_OPENROUTER = !!process.env.OPENROUTER_API_KEY
const HAS_DEEPSEEK = !!process.env.DEEPSEEK_API_KEY

if (!HAS_OPENROUTER && !HAS_DEEPSEEK) {
  console.error('❌ Configura OPENROUTER_API_KEY o DEEPSEEK_API_KEY')
  process.exit(1)
}

const SYSTEM_PROMPT = `Eres un docente experto en preparación para el examen ICFES Saber 11 (Colombia).
Tu tarea es redactar la EXPLICACIÓN de la respuesta correcta para una pregunta de opción múltiple.

Reglas estrictas:
- Responde SIEMPRE en español, en tono didáctico y claro, dirigido a un estudiante de secundaria.
- Justifica por qué la opción marcada como correcta lo es, apoyándote en los conceptos involucrados.
- Si es útil, descarta brevemente las distractoras más comunes (1–2 frases máximo).
- Extensión: entre 60 y 180 palabras.
- NO uses markdown, NO uses listas con viñetas, NO uses encabezados.
- NO comiences con frases como "La respuesta correcta es…"; entra directamente a la explicación conceptual.
- Devuelve ÚNICAMENTE el texto de la explicación, sin comillas ni prefijos.`

async function callOpenRouter(userPrompt) {
  const apiKey = process.env.OPENROUTER_API_KEY
  const model = process.env.OPENROUTER_CHAT_MODEL || 'qwen/qwen-2.5-72b-instruct'
  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 600,
      temperature: 0.3,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    },
  )
  return (res.data?.choices?.[0]?.message?.content || '').trim()
}

async function callDeepSeek(userPrompt) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  const res = await axios.post(
    `${baseUrl}/v1/chat/completions`,
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 600,
      temperature: 0.3,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    },
  )
  return (res.data?.choices?.[0]?.message?.content || '').trim()
}

async function generateExplanation(userPrompt) {
  // Preferimos OpenRouter; si falla, caemos a DeepSeek.
  const errors = []
  if (HAS_OPENROUTER) {
    try {
      return await callOpenRouter(userPrompt)
    } catch (err) {
      errors.push(`OpenRouter: ${err.response?.status || ''} ${err.message}`)
    }
  }
  if (HAS_DEEPSEEK) {
    try {
      return await callDeepSeek(userPrompt)
    } catch (err) {
      errors.push(`DeepSeek: ${err.response?.status || ''} ${err.message}`)
    }
  }
  throw new Error(`Todos los proveedores LLM fallaron: ${errors.join(' | ')}`)
}

// ---------- Cleanup helpers ----------
function sanitizeExplanation(text) {
  if (!text) return ''
  let t = text.trim()
  // Quita comillas envolventes accidentales.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    t = t.slice(1, -1).trim()
  }
  // Colapsa saltos múltiples.
  t = t.replace(/\n{3,}/g, '\n\n')
  return t
}

function buildUserPrompt({ stem, options, correct, area, topic, subtopic }) {
  const optionsBlock = options
    .map((o) => `${o.label}. ${o.content}${o.is_correct ? '   ← CORRECTA' : ''}`)
    .join('\n')

  const ctxLines = []
  if (area) ctxLines.push(`Área: ${area}`)
  if (topic) ctxLines.push(`Tema: ${topic}`)
  if (subtopic) ctxLines.push(`Subtema: ${subtopic}`)
  const ctx = ctxLines.length ? ctxLines.join('\n') + '\n\n' : ''

  return (
    `${ctx}Enunciado:\n${stem}\n\n` +
    `Opciones:\n${optionsBlock}\n\n` +
    `Opción correcta: ${correct.label}. ${correct.content}\n\n` +
    `Redacta la explicación de por qué esa opción es la correcta, ` +
    `siguiendo las reglas del system prompt.`
  )
}

// ---------- Main ----------
async function fetchPendingQuestionsPg(client) {
  const where = [`(q.explanation IS NULL OR btrim(q.explanation) = '')`]
  const params = []
  if (ID_FILTER.length > 0) {
    params.push(ID_FILTER)
    where.push(`q.id = ANY($${params.length}::bigint[])`)
  }
  let sql = `
    SELECT
      q.id,
      q.stem,
      q.subtopic_id,
      st.name      AS subtopic_name,
      t.name       AS topic_name,
      a.name       AS area_name
    FROM public.icfes_questions q
    LEFT JOIN public.icfes_subtopics st ON st.id = q.subtopic_id
    LEFT JOIN public.icfes_topics    t  ON t.id  = st.topic_id
    LEFT JOIN public.icfes_areas     a  ON a.id  = t.area_id
    WHERE ${where.join(' AND ')}
    ORDER BY q.id ASC
  `
  if (LIMIT) sql += ` LIMIT ${LIMIT}`
  const { rows } = await client.query(sql, params)
  return rows
}

async function fetchPendingQuestionsSb() {
  // Trae preguntas con explanation null/'' + JOIN a subtopics/topics/areas vía Supabase JS.
  // Hacemos dos pases: una con explanation IS NULL y otra con explanation = ''
  // y luego deduplicamos. Supabase no permite OR limpio entre is.null y eq.''
  // así que usamos el filtro `or`.
  let query = supabase
    .from('icfes_questions')
    .select(
      `id, stem, subtopic_id,
       icfes_subtopics:subtopic_id (
         name,
         icfes_topics:topic_id (
           name,
           icfes_areas:area_id ( name )
         )
       )`,
    )
    .or('explanation.is.null,explanation.eq.')
    .order('id', { ascending: true })

  if (ID_FILTER.length > 0) query = query.in('id', ID_FILTER)
  if (LIMIT) query = query.limit(LIMIT)

  const { data, error } = await query
  if (error) throw new Error(`Supabase select falló: ${error.message}`)

  return (data || []).map((r) => {
    const st = r.icfes_subtopics
    const t = st?.icfes_topics
    const a = t?.icfes_areas
    return {
      id: r.id,
      stem: r.stem,
      subtopic_id: r.subtopic_id,
      subtopic_name: st?.name || null,
      topic_name: t?.name || null,
      area_name: a?.name || null,
    }
  })
}

async function fetchOptionsPg(client, questionId) {
  const { rows } = await client.query(
    `SELECT id, label, content, is_correct
       FROM public.icfes_question_options
      WHERE question_id = $1
      ORDER BY label ASC`,
    [questionId],
  )
  return rows
}

async function fetchOptionsSb(questionId) {
  const { data, error } = await supabase
    .from('icfes_question_options')
    .select('id, label, content, is_correct')
    .eq('question_id', questionId)
    .order('label', { ascending: true })
  if (error) throw new Error(`Supabase options falló: ${error.message}`)
  return data || []
}

async function updateExplanationPg(client, questionId, explanation) {
  await client.query(
    `UPDATE public.icfes_questions
        SET explanation = $1,
            updated_at  = now()
      WHERE id = $2
        AND (explanation IS NULL OR btrim(explanation) = '')`,
    [explanation, questionId],
  )
}

async function updateExplanationSb(questionId, explanation) {
  // Idempotencia: filtramos por explanation null/'' antes de escribir.
  const { error } = await supabase
    .from('icfes_questions')
    .update({ explanation, updated_at: new Date().toISOString() })
    .eq('id', questionId)
    .or('explanation.is.null,explanation.eq.')
  if (error) throw new Error(`Supabase update falló: ${error.message}`)
}

async function processQuestion(q) {
  const client = pool ? await pool.connect() : null
  try {
    const options = pool
      ? await fetchOptionsPg(client, q.id)
      : await fetchOptionsSb(q.id)

    if (!options.length) {
      return { id: q.id, status: 'skipped', reason: 'sin opciones' }
    }
    const correct = options.find((o) => o.is_correct)
    if (!correct) {
      return { id: q.id, status: 'skipped', reason: 'sin opción correcta marcada' }
    }

    const userPrompt = buildUserPrompt({
      stem: q.stem,
      options,
      correct,
      area: q.area_name,
      topic: q.topic_name,
      subtopic: q.subtopic_name,
    })

    const raw = await generateExplanation(userPrompt)
    const explanation = sanitizeExplanation(raw)
    if (!explanation || explanation.length < 20) {
      return { id: q.id, status: 'failed', reason: 'explicación vacía/corta', preview: raw }
    }

    if (DRY_RUN) {
      return { id: q.id, status: 'dry-run', explanation }
    }

    if (pool) {
      await updateExplanationPg(client, q.id, explanation)
    } else {
      await updateExplanationSb(q.id, explanation)
    }
    return { id: q.id, status: 'updated', explanation }
  } catch (err) {
    return { id: q.id, status: 'error', error: err.message }
  } finally {
    if (client) client.release()
  }
}

// Pool de concurrencia simple
async function runWithConcurrency(items, worker, concurrency) {
  const results = []
  let i = 0
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = i++
      if (idx >= items.length) return
      const item = items[idx]
      const result = await worker(item)
      results[idx] = result
      const tag =
        result.status === 'updated'
          ? '✅'
          : result.status === 'dry-run'
          ? '📝'
          : result.status === 'skipped'
          ? '⏭️ '
          : '❌'
      console.log(
        `${tag} [${idx + 1}/${items.length}] q.id=${result.id} ${result.status}` +
          (result.reason ? ` (${result.reason})` : '') +
          (result.error ? ` (${result.error})` : ''),
      )
      if ((result.status === 'dry-run' || result.status === 'updated') && result.explanation) {
        const preview = result.explanation.slice(0, 140).replace(/\s+/g, ' ')
        console.log(`     → ${preview}${result.explanation.length > 140 ? '…' : ''}`)
      }
    }
  })
  await Promise.all(runners)
  return results
}

async function main() {
  const provider = HAS_OPENROUTER ? 'OpenRouter' : 'DeepSeek'
  const dbMode = pool ? 'Postgres directo' : 'Supabase JS'
  console.log(
    `🚀 icfes_fill_explanations — db=${dbMode}, llm=${provider}, dry-run=${DRY_RUN}, limit=${LIMIT ?? '∞'}, concurrency=${CONCURRENCY}`,
  )

  let pending
  if (pool) {
    const client = await pool.connect()
    try {
      pending = await fetchPendingQuestionsPg(client)
    } finally {
      client.release()
    }
  } else {
    pending = await fetchPendingQuestionsSb()
  }

  console.log(`📋 Preguntas sin explicación: ${pending.length}`)
  if (pending.length === 0) {
    if (pool) await pool.end()
    return
  }

  const results = await runWithConcurrency(pending, processQuestion, CONCURRENCY)

  const summary = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1
    return acc
  }, {})
  console.log('\n📊 Resumen:', summary)

  if (pool) await pool.end()
}

main().catch(async (err) => {
  console.error('❌ Error fatal:', err)
  try {
    if (pool) await pool.end()
  } catch {}
  process.exit(1)
})
