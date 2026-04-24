// Recorre docs/icfes_content/** y produce una lista de PdfSource.
// Mapea nombre de carpeta -> areaCode (con algunas excepciones).

import { readdir, stat } from 'node:fs/promises'
import { join, basename, extname, sep } from 'node:path'

// Carpeta -> areaCode. "general" y "filosofia" requieren tratamiento especial.
const FOLDER_AREA = {
  'lectura critica': 'LC',
  'lenguaje': 'LC',
  'matematicas': 'MAT',
  'matemáticas': 'MAT',
  'sociales': 'SOC',
  'ciencias sociales y ciudadanas': 'SOC',
  'sociales y ciudadanas': 'SOC',
  'filosofia': 'SOC',        // filosofía pertenece al eje Sociales en ICFES Saber 11
  'filosofía': 'SOC',
  'naturales': 'CN',
  'fisica': 'CN',
  'física': 'CN',
  'quimica': 'CN',
  'química': 'CN',
  'biologia': 'CN',
  'biología': 'CN',
  'ingles': 'ING',
  'inglés': 'ING',
  // "general" = cuadernillo multi-área; el extractor tratará de clasificar por texto.
  'general': 'MULTI',
}

const yearFromName = (name) => {
  const m = name.match(/(20\d{2}|19\d{2})/)
  return m ? Number(m[1]) : null
}

/**
 * Escanea la raíz y devuelve un array de PdfSource.
 * @param {string} root directorio base (docs/icfes_content)
 */
export async function scanLibrary(root) {
  const out = []
  for (const yearDir of await readdir(root)) {
    const yearPath = join(root, yearDir)
    if (!(await stat(yearPath)).isDirectory()) continue
    const cohortYear = yearFromName(yearDir)
    for (const areaDir of await readdir(yearPath)) {
      const areaPath = join(yearPath, areaDir)
      if (!(await stat(areaPath)).isDirectory()) continue
      const areaCode = FOLDER_AREA[areaDir.toLowerCase()] ?? null
      if (!areaCode) continue
      for (const f of await readdir(areaPath)) {
        if (extname(f).toLowerCase() !== '.pdf') continue
        out.push({
          filePath: join(areaPath, f),
          areaCode,
          year: yearFromName(f) ?? cohortYear,
          reference: [yearDir, areaDir, f].join('/'),
        })
      }
    }
  }
  return out
}
