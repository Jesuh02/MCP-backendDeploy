#!/usr/bin/env node
// CLI. Composition root: cablea adapters con los casos de uso.
// Uso:
//   node scripts/icfes_ingest/index.js                 # ingesta completa
//   node scripts/icfes_ingest/index.js --dry-run       # no escribe en DB
//   node scripts/icfes_ingest/index.js --area=CN       # filtrar por área
//   node scripts/icfes_ingest/index.js --year=2023     # filtrar por año
//
// Requiere: DATABASE_URL en .env y estar instaladas las deps:
//   pdfjs-dist, pngjs  (además de pg ya presente).

import 'dotenv/config'
import { resolve } from 'node:path'
import { scanLibrary } from './adapters/folder-catalog.js'
import { createPdfExtractor } from './adapters/pdf-extractor.js'
import { createLocalImageStorage } from './adapters/image-storage.js'
import { createTaxonomyResolver } from './adapters/taxonomy-resolver.js'
import { createPgRepository } from './adapters/pg-repository.js'
import { createJsonAnswerKeyResolver } from './adapters/answer-key-json.js'
import { createLlmAnswerKeyResolver } from './adapters/answer-key-llm.js'
import { createAnswerKeyChain } from './adapters/answer-key-chain.js'
import { createIngestPdfUseCase } from './application/ingest-pdf.js'
import { createIngestLibraryUseCase } from './application/ingest-library.js'

function parseArgs(argv) {
  const opts = { dryRun: false, area: null, year: null, noLlm: false }
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--no-llm') opts.noLlm = true
    else if (a.startsWith('--area=')) opts.area = a.slice(7).toUpperCase()
    else if (a.startsWith('--year=')) opts.year = Number(a.slice(7))
    else if (a.startsWith('--root=')) opts.root = a.slice(7)
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv)
  const root = opts.root || resolve(process.cwd(), 'docs/icfes_content')

  const imageStorage = createLocalImageStorage()
  const extractor    = createPdfExtractor(imageStorage)
  const repo         = opts.dryRun ? { insert: async () => 1, close: async () => {} } : createPgRepository()
  const taxonomy     = opts.dryRun
    ? { resolve: async () => ({ subtopicId: 1, areaCode: 'LC' }) }
    : await createTaxonomyResolver(repo.pool)

  // Cadena de resolvers de respuesta correcta: JSON manual primero, LLM fallback.
  const resolvers = [createJsonAnswerKeyResolver()]
  if (!opts.noLlm) resolvers.push(createLlmAnswerKeyResolver())
  const answerKey = createAnswerKeyChain(resolvers)

  const ingestPdf = createIngestPdfUseCase({
    extractor, taxonomy, answerKey, repo, dryRun: opts.dryRun,
  })
  const ingestLibrary = createIngestLibraryUseCase({
    catalog: { scan: scanLibrary }, ingestPdf,
  })

  const filter = (s) =>
    (!opts.area || s.areaCode === opts.area) &&
    (!opts.year || s.year === opts.year)

  const totals = await ingestLibrary(root, { filter })
  console.log('\n=== RESUMEN ICFES ===')
  console.log(JSON.stringify(totals, null, 2))
  await repo.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
