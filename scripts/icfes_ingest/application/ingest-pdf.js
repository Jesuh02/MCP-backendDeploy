// Caso de uso: ingestar un PDF. Orquesta los puertos sin conocer detalles.
// SOLID: dependencias inyectadas, este archivo no toca fs/pg/pdfjs directo.

import { isValidQuestion, newOption } from '../domain/models.js'

/**
 * Aplica la clave de respuesta a las opciones: marca is_correct=true a la
 * letra resuelta. Si el resolver no encuentra → devuelve las opciones tal cual
 * (quedan sin correcta, lo que la BD permite; se revisará manualmente después).
 */
async function applyAnswerKey(q, answerKey, stats) {
  const hit = await answerKey.resolve(q)
  if (!hit) { stats.unresolved++; return q }
  stats.resolved[hit.source] = (stats.resolved[hit.source] ?? 0) + 1
  return {
    ...q,
    options: q.options.map(o =>
      newOption(o.label, o.content, o.label === hit.label)),
    answerMeta: { source: hit.source, confidence: hit.confidence },
  }
}

/**
 * @param {{
 *   extractor: { extract:(src:any)=>AsyncIterable<any> },
 *   taxonomy:  { resolve:(area:string, stem:string)=>Promise<{subtopicId:number, areaCode:string}> },
 *   answerKey: { resolve:(q:any)=>Promise<{label:string,confidence:number,source:string}|null> },
 *   repo:      { insert:(q:any, subtopicId:number)=>Promise<number|null> },
 *   logger?:   Console,
 *   dryRun?:   boolean,
 * }} deps
 */
export function createIngestPdfUseCase({ extractor, taxonomy, answerKey, repo, logger = console, dryRun = false }) {
  return async function ingestPdf(src) {
    const stats = { inserted: 0, skipped: 0, invalid: 0, unresolved: 0, resolved: {} }
    for await (const qRaw of extractor.extract(src)) {
      if (!isValidQuestion(qRaw)) { stats.invalid++; continue }
      const q = await applyAnswerKey(qRaw, answerKey, stats)
      const { subtopicId, areaCode } = await taxonomy.resolve(q.areaCode, q.stem)
      const resolved = { ...q, areaCode }
      if (dryRun) { stats.inserted++; continue }
      const id = await repo.insert(resolved, subtopicId)
      if (id) stats.inserted++; else stats.skipped++
    }
    logger.info(`[icfes] ${src.reference} → ins=${stats.inserted} dup=${stats.skipped} inv=${stats.invalid} unres=${stats.unresolved} res=${JSON.stringify(stats.resolved)}`)
    return stats
  }
}
