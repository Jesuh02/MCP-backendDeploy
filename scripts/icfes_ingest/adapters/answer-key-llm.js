// Adapter LLM: infiere la respuesta correcta usando OpenAI.
// - Se invoca SOLO como fallback (después del JSON manual).
// - Pide al modelo que devuelva { label, confidence, reasoning }.
// - Descarta respuestas con confidence < MIN_CONFIDENCE (0.8 por defecto):
//   preferimos DEJAR sin marcar a MARCAR MAL (dato sucio envenena las métricas).
// - Usa el modelo más barato por defecto (gpt-4o-mini) y caché en memoria.

import OpenAI from 'openai'

const MIN_CONFIDENCE = Number(process.env.ICFES_ANSWER_MIN_CONF ?? 0.8)

const SYSTEM = `Eres un experto en evaluación ICFES Saber 11 (Colombia).
Dada una pregunta de opción múltiple con 4 opciones (A,B,C,D), identifica la
respuesta correcta.

Responde EXCLUSIVAMENTE en JSON válido con el esquema:
{ "label": "A|B|C|D", "confidence": 0.0-1.0, "reasoning": "breve" }

- "confidence" debe ser honesta: 0.95+ solo si la respuesta es claramente
  deducible de los datos dados. Si el enunciado parece incompleto, requiere
  una imagen que no tienes, o es ambiguo → confidence ≤ 0.5.
- No inventes. Si no puedes decidir, usa confidence 0.0 y label "A".`

export function createLlmAnswerKeyResolver({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.ICFES_ANSWER_MODEL || 'gpt-4o-mini',
  minConfidence = MIN_CONFIDENCE,
  logger = console,
} = {}) {
  if (!apiKey) {
    logger.warn('[icfes] OPENAI_API_KEY ausente → LLM resolver deshabilitado')
    return { async resolve() { return null } }
  }
  const client = new OpenAI({ apiKey })
  const cache = new Map()   // key: sourceReference → { label, confidence }

  return {
    /** @param {import('../domain/models.js').Question} q */
    async resolve(q) {
      if (cache.has(q.sourceReference)) return cache.get(q.sourceReference)
      const prompt = buildPrompt(q)
      try {
        const r = await client.chat.completions.create({
          model, temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: prompt },
          ],
        })
        const parsed = JSON.parse(r.choices[0]?.message?.content || '{}')
        const label = String(parsed.label || '').toUpperCase()
        const confidence = Number(parsed.confidence ?? 0)
        if (!/^[ABCD]$/.test(label) || confidence < minConfidence) {
          cache.set(q.sourceReference, null)
          return null
        }
        const out = { label, confidence, source: 'llm' }
        cache.set(q.sourceReference, out)
        return out
      } catch (e) {
        logger.warn(`[icfes] LLM resolver fallo ${q.sourceReference}: ${e.message}`)
        return null
      }
    },
  }
}

function buildPrompt(q) {
  const opts = q.options.map(o => `${o.label}. ${o.content}`).join('\n')
  const imgNote = q.images?.length
    ? '\n\n[NOTA: la pregunta incluye imagen(es) que NO puedes ver. Si son críticas, confidence bajo.]'
    : ''
  return `Área ICFES: ${q.areaCode}
Enunciado: ${q.stem}

Opciones:
${opts}${imgNote}`
}
