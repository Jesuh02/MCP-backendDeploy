// Adapter manual: lee claves de respuesta desde JSON curado.
// Convención:
//   docs/icfes_content/answer-keys/<reference-slug>.json
// Donde el slug = reference con separadores '/' y espacios → '_'.
// Ejemplo:
//   reference: "2016/fisica/Fisica 2010.pdf"
//   slug:      "2016_fisica_Fisica_2010.pdf.json"
// Contenido:
//   { "1": "A", "2": "C", "3": "B", ... }
//
// Fuente verdad determinista. Siempre primera en la cadena de resolución.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const slugify = (ref) => ref.replace(/[\\\/\s]+/g, '_') + '.json'

// Valida la estructura del JSON al cargarlo: todos los keys deben ser enteros
// y todos los valores deben ser A|B|C|D. Se emiten warnings ruidosos para
// evitar fallos silenciosos (la raíz de bugs en este tipo de pipelines).
function validateKeyMap(map, slug, logger) {
  if (!map || typeof map !== 'object') {
    logger.warn(`[icfes] answer-key ${slug}: JSON no es objeto`)
    return false
  }
  const letters = new Set(['A','B','C','D'])
  const errors = []
  for (const [num, letter] of Object.entries(map)) {
    if (!/^\d+$/.test(num)) errors.push(`clave "${num}" no es entero`)
    if (!letters.has(String(letter).toUpperCase())) {
      errors.push(`valor "${letter}" en pregunta ${num} no es A|B|C|D`)
    }
  }
  if (errors.length) {
    logger.warn(`[icfes] answer-key ${slug}: ${errors.length} errores → ${errors.slice(0,5).join('; ')}${errors.length>5?'…':''}`)
    return false
  }
  logger.info(`[icfes] answer-key ${slug}: ${Object.keys(map).length} respuestas cargadas`)
  return true
}

export function createJsonAnswerKeyResolver({ root = 'docs/icfes_content/answer-keys', logger = console } = {}) {
  const cache = new Map()

  async function loadKey(reference) {
    const slug = slugify(reference)
    if (cache.has(slug)) return cache.get(slug)
    try {
      const raw = await readFile(join(root, slug), 'utf8')
      const map = JSON.parse(raw)
      if (!validateKeyMap(map, slug, logger)) { cache.set(slug, null); return null }
      // Normalizar letras a mayúsculas una sola vez.
      const normalized = Object.fromEntries(
        Object.entries(map).map(([k, v]) => [k, String(v).toUpperCase()])
      )
      cache.set(slug, normalized)
      return normalized
    } catch (e) {
      // Solo loggear si el error no es "no existe" — ausencia es esperable.
      if (e.code !== 'ENOENT') logger.warn(`[icfes] answer-key ${slug}: ${e.message}`)
      cache.set(slug, null)
      return null
    }
  }

  return {
    /** @param {import('../domain/models.js').Question} q */
    async resolve(q) {
      if (!q.questionNumber) return null
      const [reference] = q.sourceReference.split('#')
      const map = await loadKey(reference)
      const letter = map?.[String(q.questionNumber)]
      if (!letter || !/^[ABCD]$/.test(letter)) return null
      return { label: letter, confidence: 1, source: 'json' }
    },
  }
}
