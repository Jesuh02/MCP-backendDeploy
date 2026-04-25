// Extractor de preguntas desde PDFs del ICFES.
//
// Flujo:
//   1. pdfjs-dist saca los items de texto con sus coordenadas (x,y) por página.
//   2. Agrupamos los items por líneas (mismo y) y ordenamos por y descendente.
//   3. Detectamos preguntas por regex: /^\s*(\d{1,3})[.)\s]+/ al inicio de línea.
//   4. Dentro de cada pregunta detectamos las 4 opciones A./B./C./D.
//      Guardamos el Y de cada marcador de opción para poder clasificar
//      imágenes después.
//   5. Recorremos la lista de operadores y trackeamos la matriz de
//      transformación corriente (CTM) con su pila save/restore. Cuando
//      aparece una operación de pintar imagen (`paintImageXObject`,
//      `paintJpegXObject`, `paintInlineImageXObject`) usamos la CTM activa
//      para conocer la posición Y de la imagen en la página.
//   6. Asociamos cada imagen a la pregunta cuyo rango [yBottom..yTop] la
//      contiene, y clasificamos su `position` como `stem` (por encima de la
//      primera opción) o `option_x` (más cercana por encima a la opción x).

import { readFile } from 'node:fs/promises'
import { newQuestion, newOption, newImage } from '../domain/models.js'

// pdfjs-dist es ESM; carga perezosa para no romper si no está instalado.
async function loadPdfjs() {
  // El build legacy corre bien en Node 18+ sin depender de DOM.
  // eslint-disable-next-line
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (mod.GlobalWorkerOptions) mod.GlobalWorkerOptions.workerSrc = ''
  return mod
}

const QUESTION_START = /^\s*(\d{1,3})\s*[.)]\s+/
const OPTION_START   = /^\s*([ABCD])\s*[.)]\s+/

// ───── Texto / líneas ─────────────────────────────────────────────────────

function groupLines(items) {
  const lines = new Map()
  for (const it of items) {
    if (!it.str?.trim()) continue
    const y = Math.round(it.transform[5])
    const x = it.transform[4]
    if (!lines.has(y)) lines.set(y, [])
    lines.get(y).push({ x, str: it.str })
  }
  return [...lines.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, arr]) => ({
      y,
      text: arr.sort((a, b) => a.x - b.x).map(t => t.str).join(' ').replace(/\s+/g, ' ').trim(),
    }))
}

function splitIntoQuestions(lines, pageNum, source) {
  const blocks = []
  let current = null
  for (const l of lines) {
    const m = l.text.match(QUESTION_START)
    if (m) {
      if (current) blocks.push(current)
      current = {
        number: Number(m[1]),
        yTop: l.y,
        yBottom: l.y,
        page: pageNum,
        lines: [{ y: l.y, text: l.text.replace(QUESTION_START, '') }],
      }
    } else if (current) {
      current.lines.push({ y: l.y, text: l.text })
      current.yBottom = l.y
    }
  }
  if (current) blocks.push(current)
  return blocks.map(b => parseBlock(b, source))
}

// Un bloque crudo → { question, block (con optionYs) } listo para imágenes.
function parseBlock(block, source) {
  const stemLines = []
  const opts = { A: [], B: [], C: [], D: [] }
  const optionYs = { A: null, B: null, C: null, D: null }
  let currentOpt = null
  for (const line of block.lines) {
    const m = line.text.match(OPTION_START)
    if (m) {
      currentOpt = m[1]
      if (optionYs[currentOpt] == null) optionYs[currentOpt] = line.y
      opts[currentOpt].push(line.text.replace(OPTION_START, ''))
    } else if (currentOpt) {
      opts[currentOpt].push(line.text)
    } else {
      stemLines.push(line.text)
    }
  }
  const options = ['A','B','C','D']
    .filter(k => opts[k].length > 0)
    .map(k => newOption(k, opts[k].join(' ').trim(), false))

  return {
    block: { ...block, optionYs },
    question: newQuestion({
      stem: stemLines.join(' ').trim(),
      options,
      images: [],
      sourceYear: source.year,
      sourceReference: `${source.reference}#q${block.number}p${block.page}`,
      areaCode: source.areaCode,
      questionNumber: block.number,
      pageNumber: block.page,
    }),
  }
}

// ───── CTM tracking + extracción de imágenes con coordenadas ───────────────

// Multiplicación de matrices afines 2D (formato pdf: [a,b,c,d,e,f]).
function mul(m1, m2) {
  return [
    m1[0]*m2[0] + m1[2]*m2[1],
    m1[1]*m2[0] + m1[3]*m2[1],
    m1[0]*m2[2] + m1[2]*m2[3],
    m1[1]*m2[2] + m1[3]*m2[3],
    m1[0]*m2[4] + m1[2]*m2[5] + m1[4],
    m1[1]*m2[4] + m1[3]*m2[5] + m1[5],
  ]
}

async function extractPageImages(page, imageStorage, sourceKey) {
  const out = []
  let opList
  try { opList = await page.getOperatorList() } catch { return out }
  if (!opList?.fnArray?.length) return out
  const pdfjs = await loadPdfjs()
  const OPS = pdfjs.OPS
  if (!OPS) return out

  const imageOps = new Set([
    OPS.paintImageXObject,
    OPS.paintJpegXObject,
    OPS.paintInlineImageXObject,
  ])

  const stack = []
  let ctm = [1, 0, 0, 1, 0, 0]

  for (let i = 0; i < opList.fnArray.length; i++) {
    const op = opList.fnArray[i]
    const args = opList.argsArray[i]

    if (op === OPS.save) { stack.push(ctm); continue }
    if (op === OPS.restore) { ctm = stack.pop() ?? ctm; continue }
    if (op === OPS.transform && Array.isArray(args) && args.length === 6) {
      ctm = mul(ctm, args)
      continue
    }
    if (!imageOps.has(op)) continue

    const name = args?.[0]
    if (!name) continue

    let img
    try {
      img = await new Promise((res, rej) => {
        const got = page.objs.get(name, (obj) => obj ? res(obj) : rej(new Error('null')))
        if (got) res(got)
      })
    } catch { continue }

    const saved = await persistImage(img, imageStorage, `${sourceKey}_${name}`)
    if (!saved) continue

    // Bbox aproximado del XObject: el espacio de imagen va de (0,0) a (1,1)
    // y se transforma por la CTM. Bottom-left ≈ (e, f); altura visible ≈ |d|.
    const x0 = ctm[4]
    const y0 = ctm[5]
    const h  = Math.abs(ctm[3]) || 0
    out.push({
      url: saved.url,
      width: img.width,
      height: img.height,
      x: x0,
      y: y0,
      yCenter: y0 + h / 2,
      yTop: y0 + h,
    })
  }
  return out
}

async function persistImage(img, storage, baseKey) {
  try {
    const data = img.data || (img.bitmap && await bitmapToBytes(img.bitmap))
    if (!data) return null
    if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) {
      const url = await storage.save(data, 'jpg', baseKey)
      return { url, width: img.width, height: img.height }
    }
    const png = await tryEncodePng(data, img.width, img.height, img.kind)
    if (!png) return null
    const url = await storage.save(png, 'png', baseKey)
    return { url, width: img.width, height: img.height }
  } catch { return null }
}

async function bitmapToBytes(bitmap) {
  if (bitmap?.data) return new Uint8Array(bitmap.data.buffer || bitmap.data)
  return null
}

async function tryEncodePng(data, width, height, kind) {
  if (!width || !height) return null
  let pngjs
  try { pngjs = (await import('pngjs')).PNG } catch { return null }
  const png = new pngjs({ width, height })
  const rgba = toRgba(data, width, height, kind)
  if (!rgba) return null
  png.data = Buffer.from(rgba)
  return pngjs.sync.write(png)
}

function toRgba(data, w, h, kind) {
  const px = w * h
  const out = new Uint8Array(px * 4)
  if (kind === 3 || data.length === px * 4) {
    out.set(data.subarray(0, px * 4)); return out
  }
  if (kind === 2 || data.length === px * 3) {
    for (let i = 0, j = 0; i < px; i++, j += 3) {
      out[i*4] = data[j]; out[i*4+1] = data[j+1]; out[i*4+2] = data[j+2]; out[i*4+3] = 255
    }
    return out
  }
  if (data.length === px) {
    for (let i = 0; i < px; i++) { out[i*4]=out[i*4+1]=out[i*4+2]=data[i]; out[i*4+3]=255 }
    return out
  }
  return null
}

// ───── Asociación imagen → pregunta y clasificación de posición ────────────

function findOwnerBlock(blocks, img) {
  // Pdf y crece hacia arriba: yTop > yBottom en valor numérico.
  for (const b of blocks) {
    if (img.yCenter <= b.block.yTop && img.yCenter >= b.block.yBottom) return b
  }
  // Fallback: pregunta más cercana por encima (típico cuando la imagen
  // queda en medio del bloque y no hay líneas debajo registradas).
  let best = null, bestDist = Infinity
  for (const b of blocks) {
    if (b.block.yTop < img.yCenter) continue
    const d = b.block.yTop - img.yCenter
    if (d < bestDist) { bestDist = d; best = b }
  }
  return best
}

function classifyImagePosition(img, optionYs) {
  const yc = img.yCenter
  const ys = ['A','B','C','D']
    .map(k => ({ k, y: optionYs[k] }))
    .filter(o => o.y != null)
    .sort((a, b) => b.y - a.y) // de mayor Y (A) a menor (D)
  if (!ys.length) return 'stem'
  const firstOptY = ys[0].y
  if (yc > firstOptY) return 'stem'
  // Encuentra la opción cuyo Y sea el más cercano por encima del centro.
  let owner = ys[ys.length - 1]
  for (const o of ys) {
    if (o.y >= yc) owner = o
  }
  return `option_${owner.k.toLowerCase()}`
}

// ───── Fábrica del extractor ──────────────────────────────────────────────

/**
 * @param {{ save:(b:Uint8Array,ext:string,key:string)=>Promise<string> }} imageStorage
 * @returns {{ extract:(src:any)=>AsyncGenerator<import('../domain/models.js').Question> }}
 */
export function createPdfExtractor(imageStorage) {
  return {
    async *extract(src) {
      const pdfjs = await loadPdfjs()
      const buf = await readFile(src.filePath)
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(buf),
        disableWorker: true,
        isEvalSupported: false,
      }).promise
      const sourceKey = src.reference.replace(/[^\w]+/g, '_')

      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p)
        const tc = await page.getTextContent()
        const lines = groupLines(tc.items)
        const parsed = splitIntoQuestions(lines, p, src)
        if (!parsed.length) { page.cleanup(); continue }

        const images = await extractPageImages(page, imageStorage, `${sourceKey}_p${p}`)

        // Buckets de imágenes por bloque (pregunta) con posición clasificada.
        const buckets = new Map(parsed.map(b => [b.block.number, []]))
        for (const img of images) {
          const owner = findOwnerBlock(parsed, img)
          if (!owner) continue
          const position = classifyImagePosition(img, owner.block.optionYs)
          buckets.get(owner.block.number).push({ ...img, position })
        }

        for (const b of parsed) {
          const bucket = buckets.get(b.block.number) || []
          // Orden estable: stem primero, luego A→D, luego por Y descendente.
          bucket.sort((a, c) => {
            const order = (p) => p === 'stem' ? 0 : 1 + 'abcd'.indexOf(p.slice(-1))
            return order(a.position) - order(c.position) || c.yCenter - a.yCenter
          })
          const out = {
            ...b.question,
            images: bucket.map((img, i) =>
              newImage(
                img.position,
                img.url,
                `${src.reference} p${b.block.page} q${b.block.number}`,
                i,
              )),
          }
          yield out
        }
        page.cleanup()
      }
      await doc.destroy()
    },
  }
}
