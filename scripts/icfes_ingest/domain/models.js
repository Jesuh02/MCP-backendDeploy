// Dominio puro: entidades y factorías. Sin dependencias externas.
// Cada entidad es un objeto inmutable creado por su factory (freeze).

const freeze = Object.freeze

/** @typedef {{ code:'LC'|'MAT'|'SOC'|'CN'|'ING', name:string }} Area */
/** @typedef {{ area_code:string, name:string }} Topic */
/** @typedef {{ area_code:string, topic_name:string, name:string }} Subtopic */

/** @typedef {{ label:'A'|'B'|'C'|'D', content:string, isCorrect:boolean }} Option */
/** @typedef {{ position:'stem'|'option_a'|'option_b'|'option_c'|'option_d', url:string, alt?:string, orderIndex?:number }} ImageRef */
/** @typedef {{
 *   stem:string,
 *   options:Option[],
 *   images:ImageRef[],
 *   difficulty:number,
 *   sourceYear:number|null,
 *   sourceReference:string,
 *   areaCode:string,
 *   topicName:string|null,
 *   subtopicName:string|null,
 *   questionNumber:number|null,
 *   pageNumber:number|null,
 * }} Question */

export const newQuestion = (partial) => freeze({
  stem: '', options: [], images: [], difficulty: 3,
  sourceYear: null, sourceReference: '', areaCode: '',
  topicName: null, subtopicName: null,
  questionNumber: null, pageNumber: null, ...partial,
})

export const newOption = (label, content, isCorrect = false) =>
  freeze({ label, content, isCorrect })

export const newImage = (position, url, alt = null, orderIndex = 0) =>
  freeze({ position, url, alt, orderIndex })

// Invariantes del dominio (usadas en el caso de uso antes de persistir).
export const isValidQuestion = (q) =>
  !!q.stem && q.options.length === 4 &&
  q.options.filter(o => o.isCorrect).length <= 1 &&
  ['LC','MAT','SOC','CN','ING'].includes(q.areaCode)
