// Repositorio Postgres para preguntas ICFES. Idempotente por source_reference.
// Usa `pg` (ya en package.json) y transacciones para garantizar consistencia.

import pg from 'pg'
const { Pool } = pg

/**
 * @param {string} connectionString
 */
export function createPgRepository(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL no configurada')
  const pool = new Pool({ connectionString, max: 4 })
  let auditColsChecked = false
  let hasAuditCols = false

  // Detecta una sola vez si la migración de auditoría ya se aplicó.
  async function ensureAuditCols(client) {
    if (auditColsChecked) return hasAuditCols
    const { rowCount } = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='icfes_question_options'
        AND column_name='answer_source'`)
    hasAuditCols = rowCount > 0
    auditColsChecked = true
    return hasAuditCols
  }

  /**
   * Inserta una pregunta con sus opciones e imágenes. Si ya existe
   * (mismo source_reference) la omite.
   * @param {import('../domain/models.js').Question & { answerMeta?: { source:string, confidence:number } }} q
   * @param {number} subtopicId
   * @returns {Promise<number|null>} questionId o null si duplicada
   */
  async function insert(q, subtopicId) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const dup = await client.query(
        'SELECT id FROM icfes_questions WHERE source_reference = $1 LIMIT 1',
        [q.sourceReference]
      )
      if (dup.rowCount) { await client.query('ROLLBACK'); return null }

      const qi = await client.query(`
        INSERT INTO icfes_questions
          (subtopic_id, stem, explanation, difficulty, source_year, source_reference)
        VALUES ($1, $2, NULL, $3, $4, $5)
        RETURNING id`,
        [subtopicId, q.stem, q.difficulty, q.sourceYear, q.sourceReference])
      const questionId = qi.rows[0].id

      const withAudit = await ensureAuditCols(client)
      const meta = q.answerMeta

      // Opciones
      const optionIds = {}
      for (const o of q.options) {
        const oi = withAudit
          ? await client.query(`
              INSERT INTO icfes_question_options
                (question_id, label, content, is_correct, answer_source, answer_confidence)
              VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
              [questionId, o.label, o.content, o.isCorrect,
               o.isCorrect ? meta?.source ?? null : null,
               o.isCorrect ? meta?.confidence ?? null : null])
          : await client.query(`
              INSERT INTO icfes_question_options (question_id, label, content, is_correct)
              VALUES ($1,$2,$3,$4) RETURNING id`,
              [questionId, o.label, o.content, o.isCorrect])
        optionIds[o.label] = oi.rows[0].id
      }

      // Imágenes
      for (const img of q.images) {
        const optId = img.position === 'stem'
          ? null
          : optionIds[img.position.slice(-1).toUpperCase()] ?? null
        await client.query(`
          INSERT INTO icfes_question_images
            (question_id, option_id, position, url, alt, order_index)
          VALUES ($1,$2,$3,$4,$5,$6)`,
          [questionId, optId, img.position, img.url, img.alt, img.orderIndex ?? 0])
      }

      await client.query('COMMIT')
      return questionId
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  return { pool, insert, close: () => pool.end() }
}
