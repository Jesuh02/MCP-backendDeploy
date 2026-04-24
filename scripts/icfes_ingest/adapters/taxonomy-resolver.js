// Resuelve el subtopic_id dado el areaCode y el texto del stem.
// Principio: la BD ya trae semilla de temas y subtemas (ver ddlpro.sql).
// El resolver los carga en memoria una vez y hace matching por palabras clave.
//
// Para área "MULTI" (cuadernillos generales) intenta inferir el área por keywords.

const AREA_KEYWORDS = {
  LC:  ['texto', 'lectura', 'autor', 'párrafo', 'enunciado del texto'],
  MAT: ['función', 'ecuación', 'triángulo', 'gráfica', 'probabilidad', 'x +', 'x=', 'pendiente'],
  SOC: ['constitución', 'democracia', 'colombia', 'gobierno', 'filosofía', 'sócrates', 'derecho'],
  CN:  ['célula', 'newton', 'fuerza', 'átomo', 'reacción', 'ecosistema', 'velocidad', 'masa'],
  ING: ['according to', 'passage', 'which of', 'the following', 'reading', 'it is said'],
}

// Palabras clave → subtopic name exacto (tal como en ddlpro.sql semilla).
// Solo se cubren los más frecuentes; si no hay match, se usa el primer subtopic
// del primer topic del área (default pedagógico sensato).
const SUBTOPIC_KEYWORDS = [
  // LC
  { area: 'LC',  re: /inferir|se deduce|implica/i,                 sub: 'Inferencia de significado por contexto' },
  { area: 'LC',  re: /tesis|intención|propósito del autor/i,       sub: 'Tesis e intención del autor' },
  { area: 'LC',  re: /argumento|validez|crítica/i,                 sub: 'Valoración argumentativa' },
  // MAT
  { area: 'MAT', re: /función cuadrática|parábola|x\^?2/i,          sub: 'Funciones cuadráticas' },
  { area: 'MAT', re: /seno|coseno|tangente|trigon/i,                sub: 'Trigonometría' },
  { area: 'MAT', re: /probabilidad|aleatorio/i,                     sub: 'Probabilidad básica' },
  { area: 'MAT', re: /media|mediana|moda|promedio/i,                sub: 'Medidas de tendencia central' },
  { area: 'MAT', re: /triángulo|pitágoras/i,                        sub: 'Triángulos y teorema de Pitágoras' },
  { area: 'MAT', re: /área|volumen|perímetro/i,                     sub: 'Áreas y volúmenes' },
  { area: 'MAT', re: /función lineal|pendiente/i,                   sub: 'Funciones lineales y afines' },
  // CN
  { area: 'CN',  re: /newton|fuerza|acelerac/i,                     sub: 'Dinámica y leyes de Newton' },
  { area: 'CN',  re: /velocidad|cinemát|movimiento/i,               sub: 'Cinemática' },
  { area: 'CN',  re: /energía|trabajo|potencia/i,                   sub: 'Trabajo, energía y potencia' },
  { area: 'CN',  re: /electric|circuito|voltaje/i,                  sub: 'Electricidad y magnetismo' },
  { area: 'CN',  re: /célula|mitosis|ribosoma/i,                    sub: 'Célula y bioquímica' },
  { area: 'CN',  re: /adn|genética|alelo|heredit/i,                 sub: 'Genética y herencia' },
  { area: 'CN',  re: /ecosistema|biodiversidad|cadena alimen/i,     sub: 'Ecología y ecosistemas' },
  { area: 'CN',  re: /átomo|tabla periódica|electrón/i,             sub: 'Estructura atómica y tabla periódica' },
  { area: 'CN',  re: /ph|ácido|base/i,                              sub: 'Ácido-base y pH' },
  { area: 'CN',  re: /estequiom|reacción química|mol\b/i,           sub: 'Estequiometría y reacciones' },
  // SOC
  { area: 'SOC', re: /constitución|derecho fundamental/i,           sub: 'Constitución política de Colombia' },
  { area: 'SOC', re: /democracia|participación|voto/i,              sub: 'Participación democrática' },
  { area: 'SOC', re: /sócrates|platón|aristóteles|medieval/i,       sub: 'Filosofía antigua y medieval' },
  { area: 'SOC', re: /kant|descartes|moderna/i,                     sub: 'Filosofía moderna' },
  // ING
  { area: 'ING', re: /verb\b|tense|past|present/i,                  sub: 'Tiempos verbales' },
  { area: 'ING', re: /preposition|however|although/i,               sub: 'Preposiciones y conectores' },
  { area: 'ING', re: /reading|passage|article/i,                    sub: 'Textos informativos' },
]

function inferArea(stem) {
  const s = stem.toLowerCase()
  let best = null, bestScore = 0
  for (const [code, kws] of Object.entries(AREA_KEYWORDS)) {
    const score = kws.reduce((a, k) => a + (s.includes(k) ? 1 : 0), 0)
    if (score > bestScore) { bestScore = score; best = code }
  }
  return best || 'LC'
}

/**
 * @param {import('pg').Pool} pool
 */
export async function createTaxonomyResolver(pool) {
  // Cargar semilla en memoria: subtopicId por (areaCode, subtopicName).
  const { rows } = await pool.query(`
    SELECT s.id AS subtopic_id, a.code AS area_code, t.name AS topic_name, s.name AS subtopic_name
    FROM icfes_subtopics s
    JOIN icfes_topics t ON t.id = s.topic_id
    JOIN icfes_areas a ON a.id = t.area_id
  `)
  const byArea = new Map()                               // areaCode -> subtopicId[] (fallback)
  const byKey  = new Map()                               // `${area}|${subName}` -> subtopicId
  for (const r of rows) {
    byKey.set(`${r.area_code}|${r.subtopic_name}`, r.subtopic_id)
    if (!byArea.has(r.area_code)) byArea.set(r.area_code, [])
    byArea.get(r.area_code).push(r.subtopic_id)
  }

  return {
    async resolve(areaCode, stem) {
      const area = areaCode === 'MULTI' ? inferArea(stem) : areaCode
      for (const rule of SUBTOPIC_KEYWORDS) {
        if (rule.area !== area) continue
        if (rule.re.test(stem)) {
          const id = byKey.get(`${area}|${rule.sub}`)
          if (id) return { subtopicId: id, areaCode: area }
        }
      }
      const fallback = byArea.get(area)?.[0]
      if (!fallback) throw new Error(`Sin subtopics para área ${area}`)
      return { subtopicId: fallback, areaCode: area }
    },
  }
}
