// Extractor de preguntas desde PDFs del ICFES.
// Estrategia:
//   1. pdfjs-dist saca los ítems de texto con sus coordenadas (x,y) por página.
//   2. Agrupamos los items por líneas (mismo y) y ordenamos por y descendente.
//   3. Detectamos preguntas por regex: /^\s*(\d{1,3})[.)\s]+/ al inicio de línea.
//   4. Dentro de cada pregunta detectamos las 4 opciones A./B./C./D.
//   5. Extraemos imágenes embebidas (paintImageXObject / paintJpegXObject) y
//      las asociamos a la pregunta cuyo rango vertical las contiene.
//
// El extractor emite preguntas aunque tengan <4 opciones (quedan descartadas
// en el caso de uso por isValidQuestion). Esto permite observabilidad.

import { readFile } from 'node:fs/promises'
import { newQuestion, newOption, newImage } from '../domain/models.js'

// pdfjs-dist es ESM; carga perezosa para no romper si no está instalado.
async function loadPdfjs() {
  // El build legacy corre bien en Node 18+ sin depender de DOM.
  // eslint-disable-next-line
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // pdfjs intenta cargar un worker por defecto; lo desactivamos para Node.
  if (mod.GlobalWorkerOptions) mod.GlobalWorkerOptions.workerSrc = ''
  return mod
}

const QUESTION_START = /^\s*(\d{1,3})\s*[.)]\s+/
const OPTION_START   = /^\s*([ABCD])\s*[.)]\s+/

// Agrupa items de texto de una página en líneas ordenadas top→bottom.
function groupLines(items) {
  const lines = new Map()
  for (const it of items) {
    if (!it.str?.trim()) continue
    const y = Math.round(it.transform[5])   // quantización para agrupar
    const x = it.transform[4]
    const key = y
    if (!lines.has(key)) lines.set(key, [])
    lines.get(key).push({ x, str: it.str })
  }
  return [...lines.entries()]
    .sort((a, b) => b[0] - a[0])             // y descendente = top primero
    .map(([y, arr]) => ({
      y,
      text: arr.sort((a, b) => a.x - b.x).map(t => t.str).join(' ').replace(/\s+/g, ' ').trim(),
    }))
}

// Parte las líneas de una página en bloques de pregunta.
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
        lines: [l.text.replace(QUESTION_START, '')],
      }
    } else if (current) {
      current.lines.push(l.text)
      current.yBottom = l.y
    }
  }
  if (current) blocks.push(current)
  return blocks.map(b => parseBlock(b, source))
}

// Convierte un bloque crudo en Question con stem + opciones.
function parseBlock(block, source) {
  const stemLines = []
  const opts = { A: [], B: [], C: [], D: [] }
  let currentOpt = null
  for (const line of block.lines) {
    const m = line.match(OPTION_START)
    if (m) {
      currentOpt = m[1]
      opts[currentOpt].push(line.replace(OPTION_START, ''))
    } else if (currentOpt) {
      opts[currentOpt].push(line)
    } else {
      stemLines.push(line)
    }
  }
  const options = ['A','B','C','D']
    .filter(k => opts[k].length > 0)
    .map(k => newOption(k, opts[k].join(' ').trim(), false))

  return {
    block,
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

// Lee imágenes embebidas de una página. Tolerante a errores.
async function extractPageImages(page, imageStorage, sourceKey) {
  const out = []
  let opList
  try { opList = await page.getOperatorList() } catch { return out }
  const OPS = opList.fnArray ? (await loadPdfjs()).OPS : null
  if (!OPS) return out
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintInlineImageXObject])

  for (let i = 0; i < opList.fnArray.length; i++) {
    if (!imageOps.has(opList.fnArray[i])) continue
    const args = opList.argsArray[i]
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
    if (saved) out.push(saved)
  }
  return out
}

// Normaliza el objeto imagen de pdfjs y lo envía al storage.
async function persistImage(img, storage, baseKey) {
  try {
    const data = img.data || (img.bitmap && await bitmapToBytes(img.bitmap))
    if (!data) return null
    // Si ya son bytes JPEG (FFD8FF), guardar tal cual.
    if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) {
      const url = await storage.save(data, 'jpg', baseKey)
      return { url, width: img.width, height: img.height }
    }
    // RGBA/RGB crudo → PNG vía pngjs (carga perezosa, opcional).
    const png = await tryEncodePng(data, img.width, img.height, img.kind)
    if (!png) return null
    const url = await storage.save(png, 'png', baseKey)
    return { url, width: img.width, height: img.height }
  } catch { return null }
}

async function bitmapToBytes(bitmap) {
  // En Node, bitmap suele ser { width, height, data:Uint8ClampedArray }
  if (bitmap?.data) return new Uint8Array(bitmap.data.buffer || bitmap.data)
  return null
}

async function tryEncodePng(data, width, height, kind) {
  if (!width || !height) return null
  let pngjs
  try { pngjs = (await import('pngjs')).PNG } catch { return null }
  const png = new pngjs({ width, height })
  // kind: 1=grayscale1bpp 2=RGB_24BPP 3=RGBA_32BPP (api pdfjs)
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
  if (data.length === px) {            // grayscale 8bpp
    for (let i = 0; i < px; i++) { out[i*4]=out[i*4+1]=out[i*4+2]=data[i]; out[i*4+3]=255 }
    return out
  }
  return null
}

/**
 * Fábrica del adaptador.
 * @param {{ save:(b:Uint8Array,ext:string,key:string)=>Promise<string> }} imageStorage
 * @returns {{ extract:(src:any)=>AsyncGenerator<import('../domain/models.js').Question> }}
 */
export function createPdfExtractor(imageStorage) {
  return {
    async *extract(src) {
      const pdfjs = await loadPdfjs()
      const buf = await readFile(src.filePath)
      const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), disableWorker: true, isEvalSupported: false }).promise
      const sourceKey = src.reference.replace(/[^\w]+/g, '_')

      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p)
        const tc = await page.getTextContent()
        const lines = groupLines(tc.items)
        const parsed = splitIntoQuestions(lines, p, src)
        if (!parsed.length) { page.cleanup(); continue }

        const images = await extractPageImages(page, imageStorage, `${sourceKey}_p${p}`)
        // Asociar cada imagen a la pregunta cuyo rango [yTop..yBottom] la contiene.
        // pdfjs no da la Y del XObject; como heurística MVP las asociamos a la
        // primera pregunta de la página (position='stem').
        for (const { question, block } of parsed) {
          const pageImgs = images.splice(0, Math.min(images.length, 1))
          const withImgs = {
            ...question,
            images: pageImgs.map((img, i) =>
              newImage('stem', img.url, `${src.reference} p${block.page} q${block.number}`, i)),
          }
          yield withImgs
        }
        page.cleanup()
      }
      await doc.destroy()
    },
  }
}
