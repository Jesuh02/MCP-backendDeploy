#!/usr/bin/env node
/**
 * icfes_fill_correct_answers.mjs
 *
 * Detecta preguntas en `public.icfes_questions` cuyas opciones en
 * `icfes_question_options` NO tienen ninguna fila con `is_correct = true`
 * (es decir, no hay respuesta correcta marcada) y, para cada una:
 *
 *   1. Envía a un LLM (OpenRouter, fallback DeepSeek) el enunciado + las 4
 *      opciones, pidiéndole que devuelva exclusivamente la letra de la opción
 *      correcta (A, B, C o D) en un JSON estricto, junto con una breve
 *      explicación.
 *   2. Marca esa opción como `is_correct = true` (y las demás como false,
 *      por seguridad) dentro de una transacción.
 *   3. Si la pregunta tampoco tiene `explanation`, la actualiza con la
 *      explicación devuelta por el LLM (sanitizada).
 *   4. Marca `answer_source = 'llm:<model>'` y `answer_confidence` en la
 *      opción correcta cuando esas columnas existen (ya están en el DDL).
 *
 * Idempotente: si por alguna razón se vuelve a ejecutar, sólo procesa
 * preguntas que SIGAN sin opción correcta.
 *
 * Variables de entorno:
 *   - DATABASE_URL                           o
 *     SUPABASE_URL + SUPABASE_SERVICE_KEY    (cualquiera)
 *   - OPENROUTER_API_KEY                     (recomendado)
 *   - DEEPSEEK_API_KEY                       (fallback)
 *
 * Opcionales:
 *   - OPENROUTER_CHAT_MODEL  default: deepseek/deepseek-chat
 *   - DEEPSEEK_MODEL         default: deepseek-chat
 *   - DEEPSEEK_BASE_URL      default: https://api.deepseek.com
 *
 * Flags CLI:
 *   --dry-run        No escribe; sólo muestra lo que decidiría el LLM.
 *   --limit=N        Procesa como máximo N preguntas.
 *   --concurrency=N  Llamadas LLM en paralelo (default: 3).
 *   --ids=1,2,3      Sólo procesa esos question.id.
 *   --no-explanation Omite el llenado de `explanation` aunque venga vacía.
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
const NO_EXPLANATION = getFlag('no-explanation')
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
  console.error('❌ Configura DATABASE_URL, o bien SUPABASE_URL + SUPABASE_SERVICE_KEY')
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

const OPENROUTER_MODEL =
  process.env.OPENROUTER_CHAT_MODEL || 'deepseek/deepseek-chat'
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'

const SYSTEM_PROMPT = `Eres un experto en el examen ICFES Saber 11 (Colombia) con dominio sólido en todas las áreas: matemáticas, lectura crítica, ciencias naturales, sociales y ciudadanas, e inglés.

Te entregaré una pregunta de opción múltiple con 4 opciones (A, B, C, D). Tu tarea es:
1. Determinar cuál opción es la correcta.
2. Justificarlo con una explicación pedagógica para un estudiante de secundaria (60–180 palabras, sin markdown ni listas).

Responde EXCLUSIVAMENTE con un objeto JSON válido (sin texto antes ni después, sin bloques de código), con esta forma exacta:

{"correct":"A","confidence":0.0,"explanation":"..."}

Donde:
- "correct" es UNA letra entre "A","B","C","D".
- "confidence" es un número entre 0 y 1 que refleja qué tan seguro estás.
- "explanation" es la justificación en español, sin comillas ni saltos de línea innecesarios.`

function buildUserPrompt({ stem, options, area, topic, subtopic }) {
  const optionsBlock = options
    .map((o) => `${o.label}. ${o.content}`)
    .join('\n')
  const ctxLines = []
  if (area) ctxLines.push(`Área: ${area}`)
  if (topic) ctxLines.push(`Tema: ${topic}`)
  if (subtopic) ctxLines.push(`Subtema: ${subtopic}`)
  const ctx = ctxLines.length ? ctxLines.join('\n') + '\n\n' : ''
  return (
    `${ctx}Enunciado:\n${stem}\n\n` +
    `Opciones:\n${optionsBlock}\n\n` +
    `Devuelve SOLO el JSON con la letra correcta y la explicación.`
  )
}

async function callOpenRouter(userPrompt) {
  const apiKey = process.env.OPENROUTER_API_KEY
  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 700,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://coursev.yisuscompany.com',
        'X-Title': 'ICFES Fill Correct Answers',
      },
      timeout: 120000,
    },
  )
  return {
    content: (res.data?.choices?.[0]?.message?.content || '').trim(),
    model: OPENROUTER_MODEL,
  }
}

async function callDeepSeek(userPrompt) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
  const res = await axios.post(
    `${baseUrl}/v1/chat/completions`,
    {
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 700,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    },
  )
  return {
    content: (res.data?.choices?.[0]?.message?.content || '').trim(),
    model: DEEPSEEK_MODEL,
  }
}

async function askLLM(userPrompt) {
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

// ---------- Parse / sanitize ----------
function extractJsonObject(text) {
  if (!text) return null
  // Quita fences ```json ... ``` si vinieran
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  // Toma desde el primer { hasta el último } para tolerar texto residual
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  const slice = t.slice(start, end + 1)
  try {
    return JSON.parse(slice)
  } catch {
    return null
  }
}

function sanitizeExplanation(text) {
  if (!text) return ''
  let t = String(text).trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    t = t.slice(1, -1).trim()
  }
  t = t.replace(/\n{3,}/g, '\n\n')
  return t
}

// ---------- DB queries ----------
async function fetchPendingQuestionsPg(client) {
  const where = [
    `(q.explanation IS NULL OR btrim(q.explanation) = '' OR TRUE)`, // placeholder; el filtro real es el NOT EXISTS
    `NOT EXISTS (
       SELECT 1 FROM public.icfes_question_options o
       WHERE o.question_id = q.id AND o.is_correct = true
     )`,
  ]
  const params = []
  if (ID_FILTER.length > 0) {
    params.push(ID_FILTER)
    where.push(`q.id = ANY($${params.length}::bigint[])`)
  }
  // El placeholder primero no tiene efecto; lo dejamos para legibilidad.
  let sql = `
    SELECT
      q.id,
      q.stem,
      q.explanation,
      q.subtopic_id,
      st.name AS subtopic_name,
      t.name  AS topic_name,
      a.name  AS area_name
    FROM public.icfes_questions q
    LEFT JOIN public.icfes_subtopics st ON st.id = q.subtopic_id
    LEFT JOIN public.icfes_topics    t  ON t.id  = st.topic_id
    LEFT JOIN public.icfes_areas     a  ON a.id  = t.area_id
    WHERE ${where.slice(1).join(' AND ')}
    ORDER BY q.id ASC
  `
  if (LIMIT) sql += ` LIMIT ${LIMIT}`
  const { rows } = await client.query(sql, params)
  return rows
}

async function fetchPendingQuestionsSb() {
  // Supabase no tiene NOT EXISTS directo en el query builder, así que:
  //  1. Traemos todas las question_id que tienen al menos una option is_correct=true.
  //  2. Listamos preguntas y excluimos esas IDs en cliente.
  const { data: correctRows, error: e1 } = await supabase
    .from('icfes_question_options')
    .select('question_id')
    .eq('is_correct', true)
  if (e1) throw new Error(`Supabase select correct options falló: ${e1.message}`)
  const withCorrect = new Set((correctRows || []).map((r) => r.question_id))

  // Paginar para evitar el límite por defecto (1000) de Supabase.
  const PAGE = 1000
  let from = 0
  const all = []
  while (true) {
    let q = supabase
      .from('icfes_questions')
      .select(
        `id, stem, explanation, subtopic_id,
         icfes_subtopics:subtopic_id (
           name,
           icfes_topics:topic_id (
             name,
             icfes_areas:area_id ( name )
           )
         )`,
      )
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (ID_FILTER.length > 0) q = q.in('id', ID_FILTER)
    const { data, error } = await q
    if (error) throw new Error(`Supabase select questions falló: ${error.message}`)
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  const flat = all
    .filter((r) => !withCorrect.has(r.id))
    .map((r) => {
      const st = r.icfes_subtopics
      const t = st?.icfes_topics
      const a = t?.icfes_areas
      return {
        id: r.id,
        stem: r.stem,
        explanation: r.explanation,
        subtopic_id: r.subtopic_id,
        subtopic_name: st?.name || null,
        topic_name: t?.name || null,
        area_name: a?.name || null,
      }
    })
  return LIMIT ? flat.slice(0, LIMIT) : flat
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

// ---------- Mutations ----------
async function applyAnswerPg(client, q, correctOption, allOptions, explanationToWrite, model, confidence) {
  await client.query('BEGIN')
  try {
    // Asegura que ninguna opción quede como is_correct salvo la elegida.
    const otherIds = allOptions.filter((o) => o.id !== correctOption.id).map((o) => o.id)
    if (otherIds.length > 0) {
      await client.query(
        `UPDATE public.icfes_question_options
            SET is_correct = false
          WHERE id = ANY($1::bigint[])`,
        [otherIds],
      )
    }
    await client.query(
      `UPDATE public.icfes_question_options
          SET is_correct = true,
              answer_source = COALESCE(answer_source, $2),
              answer_confidence = COALESCE(answer_confidence, $3)
        WHERE id = $1`,
      [correctOption.id, `llm:${model}`, confidence],
    )
    if (explanationToWrite) {
      await client.query(
        `UPDATE public.icfes_questions
            SET explanation = $1, updated_at = now()
          WHERE id = $2 AND (explanation IS NULL OR btrim(explanation) = '')`,
        [explanationToWrite, q.id],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

async function applyAnswerSb(q, correctOption, allOptions, explanationToWrite, model, confidence) {
  // 1. Limpia is_correct=false en las demás
  const otherIds = allOptions.filter((o) => o.id !== correctOption.id).map((o) => o.id)
  if (otherIds.length > 0) {
    const { error } = await supabase
      .from('icfes_question_options')
      .update({ is_correct: false })
      .in('id', otherIds)
    if (error) throw new Error(`Supabase clear is_correct falló: ${error.message}`)
  }
  // 2. Marca la correcta + audit cols (sólo si están null para no pisar)
  const { data: existing, error: e1 } = await supabase
    .from('icfes_question_options')
    .select('answer_source, answer_confidence')
    .eq('id', correctOption.id)
    .single()
  if (e1) throw new Error(`Supabase fetch correct option falló: ${e1.message}`)
  const updatePayload = { is_correct: true }
  if (existing && existing.answer_source == null) updatePayload.answer_source = `llm:${model}`
  if (existing && existing.answer_confidence == null) updatePayload.answer_confidence = confidence
  const { error: e2 } = await supabase
    .from('icfes_question_options')
    .update(updatePayload)
    .eq('id', correctOption.id)
  if (e2) throw new Error(`Supabase set is_correct falló: ${e2.message}`)
  // 3. Explicación (sólo si está vacía)
  if (explanationToWrite) {
    const { error: e3 } = await supabase
      .from('icfes_questions')
      .update({ explanation: explanationToWrite, updated_at: new Date().toISOString() })
      .eq('id', q.id)
      .or('explanation.is.null,explanation.eq.')
    if (e3) throw new Error(`Supabase set explanation falló: ${e3.message}`)
  }
}

// ---------- Per-question worker ----------
async function processQuestion(q) {
  const client = pool ? await pool.connect() : null
  try {
    const options = pool ? await fetchOptionsPg(client, q.id) : await fetchOptionsSb(q.id)
    if (!options.length) {
      return { id: q.id, status: 'skipped', reason: 'sin opciones' }
    }
    if (options.some((o) => o.is_correct)) {
      return { id: q.id, status: 'skipped', reason: 'ya tiene correcta (carrera concurrente)' }
    }

    const userPrompt = buildUserPrompt({
      stem: q.stem,
      options,
      area: q.area_name,
      topic: q.topic_name,
      subtopic: q.subtopic_name,
    })

    const { content, model } = await askLLM(userPrompt)
    const parsed = extractJsonObject(content)
    if (!parsed) {
      return { id: q.id, status: 'failed', reason: 'JSON no parseable', preview: content.slice(0, 200) }
    }

    const letter = String(parsed.correct || '').trim().toUpperCase()
    if (!['A', 'B', 'C', 'D'].includes(letter)) {
      return { id: q.id, status: 'failed', reason: `letra inválida "${letter}"` }
    }
    const correct = options.find((o) => String(o.label).toUpperCase() === letter)
    if (!correct) {
      return { id: q.id, status: 'failed', reason: `opción ${letter} no existe en BD` }
    }
    let confidence = Number(parsed.confidence)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) confidence = 0.7
    const explanation = sanitizeExplanation(parsed.explanation || '')

    const explanationToWrite =
      !NO_EXPLANATION &&
      (q.explanation == null || String(q.explanation).trim() === '') &&
      explanation.length >= 20
        ? explanation
        : null

    if (DRY_RUN) {
      return {
        id: q.id,
        status: 'dry-run',
        chosen: letter,
        confidence,
        wouldWriteExplanation: !!explanationToWrite,
        explanation,
      }
    }

    if (pool) {
      await applyAnswerPg(client, q, correct, options, explanationToWrite, model, confidence)
    } else {
      await applyAnswerSb(q, correct, options, explanationToWrite, model, confidence)
    }
    return {
      id: q.id,
      status: 'updated',
      chosen: letter,
      confidence,
      wroteExplanation: !!explanationToWrite,
      explanation,
    }
  } catch (err) {
    return { id: q.id, status: 'error', error: err.message }
  } finally {
    if (client) client.release()
  }
}

// ---------- Concurrency ----------
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
          (result.chosen ? ` → ${result.chosen} (conf=${result.confidence})` : '') +
          (result.reason ? ` (${result.reason})` : '') +
          (result.error ? ` (${result.error})` : ''),
      )
      if (result.explanation && (result.status === 'dry-run' || result.status === 'updated')) {
        const preview = result.explanation.slice(0, 140).replace(/\s+/g, ' ')
        console.log(`     → ${preview}${result.explanation.length > 140 ? '…' : ''}`)
      }
    }
  })
  await Promise.all(runners)
  return results
}

// ---------- Main ----------
async function main() {
  const provider = HAS_OPENROUTER ? `OpenRouter (${OPENROUTER_MODEL})` : `DeepSeek (${DEEPSEEK_MODEL})`
  const dbMode = pool ? 'Postgres directo' : 'Supabase JS'
  console.log(
    `🚀 icfes_fill_correct_answers — db=${dbMode}, llm=${provider}, dry-run=${DRY_RUN}, limit=${LIMIT ?? '∞'}, concurrency=${CONCURRENCY}, no-explanation=${NO_EXPLANATION}`,
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

  console.log(`📋 Preguntas sin opción correcta: ${pending.length}`)
  if (pending.length === 0) {
    if (pool) await pool.end()
    return
  }

  const results = await runWithConcurrency(pending, processQuestion, CONCURRENCY)

  const summary = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1
    return acc
  }, {})
  const updatedExpl = results.filter((r) => r.status === 'updated' && r.wroteExplanation).length
  console.log('\n📊 Resumen:', summary, `| explicaciones escritas en mismo paso: ${updatedExpl}`)

  if (pool) await pool.end()
}

main().catch(async (err) => {
  console.error('❌ Error fatal:', err)
  try {
    if (pool) await pool.end()
  } catch {}
  process.exit(1)
})
