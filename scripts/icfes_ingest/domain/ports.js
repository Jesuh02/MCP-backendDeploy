// Puertos (interfaces) — contratos que la capa de aplicación necesita.
// En JS se documentan con JSDoc; los adapters implementan estas firmas.

/**
 * @typedef {Object} PdfSource
 * @property {string} filePath  ruta absoluta al PDF
 * @property {string} areaCode  LC|MAT|SOC|CN|ING
 * @property {number|null} year año lectivo (null si desconocido)
 * @property {string} reference etiqueta legible (ej. "2016/fisica/Fisica 2010.pdf")
 */

/** @typedef {import('./models.js').Question} Question */

/**
 * @typedef {Object} QuestionExtractorPort
 * @property {(src:PdfSource)=>AsyncIterable<Question>} extract
 */

/**
 * @typedef {Object} ImageStoragePort
 * @property {(bytes:Uint8Array, ext:string, key:string)=>Promise<string>} save  devuelve URL pública
 */

/**
 * @typedef {Object} TaxonomyResolverPort
 * @property {(areaCode:string, stem:string)=>Promise<{subtopicId:number}>} resolve
 */

/**
 * @typedef {Object} QuestionRepositoryPort
 * @property {(q:Question, subtopicId:number)=>Promise<number>} insert  devuelve questionId
 * @property {()=>Promise<void>} close
 */

/**
 * @typedef {Object} EmbedderPort
 * @property {(text:string)=>Promise<number[]|null>} embed
 */

/**
 * @typedef {Object} AnswerKeyResolverPort
 * @property {(q:Question)=>Promise<{label:'A'|'B'|'C'|'D', confidence:number, source:string}|null>} resolve
 */

export {}
