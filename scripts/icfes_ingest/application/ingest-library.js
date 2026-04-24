// Caso de uso: ingestar una librería completa (varios PDFs). Secuencial por
// defecto para no saturar memoria al parsear PDFs grandes.
export function createIngestLibraryUseCase({ catalog, ingestPdf, logger = console }) {
  return async function ingestLibrary(root, { filter } = {}) {
    const sources = (await catalog.scan(root)).filter(s => !filter || filter(s))
    const totals = {
      inserted: 0, skipped: 0, invalid: 0, unresolved: 0,
      resolved: {}, files: sources.length, failures: [],
    }
    logger.info(`[icfes] ${sources.length} PDFs en cola`)
    for (const src of sources) {
      try {
        const r = await ingestPdf(src)
        totals.inserted += r.inserted
        totals.skipped += r.skipped
        totals.invalid += r.invalid
        totals.unresolved += r.unresolved ?? 0
        for (const [k, v] of Object.entries(r.resolved ?? {})) {
          totals.resolved[k] = (totals.resolved[k] ?? 0) + v
        }
      } catch (e) {
        logger.error(`[icfes] FALLÓ ${src.reference}: ${e.message}`)
        totals.failures.push({ reference: src.reference, error: e.message })
      }
    }
    return totals
  }
}
