-- ============================================================================
--  FIX DE PROMEDIOS — progreso_curso y progreso_materia
--
--  PROBLEMA:
--    El backend calculaba el promedio dividiendo la suma de notas entre el
--    TOTAL de tareas del curso/materia (y no entre las tareas calificadas),
--    lo que hundía el promedio y marcaba estudiantes como 'Perdido'.
--
--  REGLA (acordada) — idéntica a _computeTaskAverage en progress.service.js:
--    promedio = AVG( nota_mas_reciente_por_tarea )  sobre las tareas CON nota.
--    - Solo cuentan tareas calificadas (grade IS NOT NULL). Nota 0 sí cuenta.
--    - Una nota por tarea: ante reenvíos se toma la entrega más reciente con
--      orden lexicográfico graded_at DESC NULLS LAST, submission_date DESC
--      NULLS LAST, id DESC.
--    - Aprobado ('Ganado') si promedio >= 6, si no 'Perdido'.
--
--  IMPORTANTE (revisión adversarial):
--    1. NO se usa INSERT ... ON CONFLICT. Las tablas progreso_curso /
--       progreso_materia NO tienen índice único sobre
--       (usuario_estudiante,curso_id[,materia_id]) y el repositorio evita
--       ON CONFLICT a propósito ("may not exist"). Por eso aquí se hace
--       UPDATE de los existentes + INSERT de los faltantes (patrón del repo).
--    2. Este SQL promedia SOLO tareas. El backend, además, mezcla notas
--       manuales (comportamiento/participación/exámenes) vía
--       _computeGeneralAverage cuando existen. Para estudiantes SIN notas
--       manuales (el caso general) ambos coinciden exactamente. Para los que
--       tengan notas manuales, el backend recalculará y sobrescribirá el valor
--       en la siguiente lectura/recálculo. Si quieres que el SQL también
--       incluya notas manuales, dímelo y uno la tabla de grades aquí.
--
--  Ejecutar en orden. Los pasos 0 y 1 son SELECT de verificación (no modifican).
--  Los pasos 2 y 3 corrigen la BD. Recomendado correr dentro de una transacción:
--      BEGIN;  ... pasos 2 y 3 ...  COMMIT;   (o ROLLBACK si algo no cuadra)
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
--  PASO 0 — VERIFICACIÓN por CURSO (misma fórmula AVG plano que el PASO 2)
--  Compara "promedio_real_curso" contra lo guardado en progreso_curso.
-- ════════════════════════════════════════════════════════════════════════════
WITH nota_por_tarea AS (
    SELECT DISTINCT ON (ts.student_id, ts.task_id)
           ts.student_id, ts.task_id, ts.grade
    FROM task_submissions ts
    WHERE ts.grade IS NOT NULL
    ORDER BY ts.student_id, ts.task_id,
             ts.graded_at DESC NULLS LAST,
             ts.submission_date DESC NULLS LAST,
             ts.id DESC
),
tarea_curso AS (
    SELECT t.id AS task_id, s.course_id
    FROM tasks t
    JOIN topics tp  ON tp.id = t.topic_id
    JOIN subjects s ON s.id = COALESCE(tp.materia_id, tp.subject_id)
)
SELECT tc.course_id,
       npt.student_id,
       ROUND(AVG(npt.grade)::numeric, 2) AS promedio_real_curso,
       COUNT(*)                          AS tareas_calificadas,
       pcur.promedio                     AS promedio_guardado,
       pcur.estado                       AS estado_guardado
FROM nota_por_tarea npt
JOIN tarea_curso tc ON tc.task_id = npt.task_id
LEFT JOIN progreso_curso pcur
       ON pcur.usuario_estudiante = npt.student_id
      AND pcur.curso_id = tc.course_id
GROUP BY tc.course_id, npt.student_id, pcur.promedio, pcur.estado
ORDER BY tc.course_id, npt.student_id;


-- ════════════════════════════════════════════════════════════════════════════
--  PASO 1 — VERIFICACIÓN por MATERIA
-- ════════════════════════════════════════════════════════════════════════════
WITH nota_por_tarea AS (
    SELECT DISTINCT ON (ts.student_id, ts.task_id)
           ts.student_id, ts.task_id, ts.grade
    FROM task_submissions ts
    WHERE ts.grade IS NOT NULL
    ORDER BY ts.student_id, ts.task_id,
             ts.graded_at DESC NULLS LAST,
             ts.submission_date DESC NULLS LAST,
             ts.id DESC
)
SELECT s.course_id,
       s.id                               AS materia_id,
       npt.student_id,
       ROUND(AVG(npt.grade)::numeric, 2)  AS promedio_real_materia,
       COUNT(*)                           AS tareas_calificadas,
       pm.promedio                        AS promedio_guardado,
       pm.estado                          AS estado_guardado
FROM nota_por_tarea npt
JOIN tasks    t  ON t.id = npt.task_id
JOIN topics   tp ON tp.id = t.topic_id
JOIN subjects s  ON s.id = COALESCE(tp.materia_id, tp.subject_id)
LEFT JOIN progreso_materia pm
       ON pm.usuario_estudiante = npt.student_id
      AND pm.curso_id  = s.course_id
      AND pm.materia_id = s.id
GROUP BY s.course_id, s.id, npt.student_id, pm.promedio, pm.estado
ORDER BY s.course_id, s.id, npt.student_id;


-- ════════════════════════════════════════════════════════════════════════════
--  PASO 2 — CORRECCIÓN de progreso_curso
--  (A) UPDATE de filas existentes   (B) INSERT de las que faltan
--  Sin ON CONFLICT: no requiere índice único y tolera duplicados preexistentes.
-- ════════════════════════════════════════════════════════════════════════════

-- Vista temporal con el cálculo por (curso, estudiante). Se materializa como
-- tabla temporal para reutilizarla en el UPDATE y el INSERT dentro de la misma
-- sesión/transacción.
DROP TABLE IF EXISTS tmp_calc_curso;
CREATE TEMP TABLE tmp_calc_curso AS
WITH nota_por_tarea AS (
    SELECT DISTINCT ON (ts.student_id, ts.task_id)
           ts.student_id, ts.task_id, ts.grade
    FROM task_submissions ts
    WHERE ts.grade IS NOT NULL
    ORDER BY ts.student_id, ts.task_id,
             ts.graded_at DESC NULLS LAST,
             ts.submission_date DESC NULLS LAST,
             ts.id DESC
),
tarea_curso AS (
    SELECT t.id AS task_id, s.course_id
    FROM tasks t
    JOIN topics tp  ON tp.id = t.topic_id
    JOIN subjects s ON s.id = COALESCE(tp.materia_id, tp.subject_id)
),
totales AS (
    SELECT course_id, COUNT(*) AS tareas_totales
    FROM tarea_curso GROUP BY course_id
),
entregadas AS (
    SELECT tc.course_id, ts.student_id,
           COUNT(DISTINCT ts.task_id) AS tareas_completadas
    FROM task_submissions ts
    JOIN tarea_curso tc ON tc.task_id = ts.task_id
    GROUP BY tc.course_id, ts.student_id
),
calculo AS (
    SELECT tc.course_id, npt.student_id,
           ROUND(AVG(npt.grade)::numeric, 2) AS promedio
    FROM nota_por_tarea npt
    JOIN tarea_curso tc ON tc.task_id = npt.task_id
    GROUP BY tc.course_id, npt.student_id
)
SELECT c.course_id,
       c.student_id::bigint                 AS student_id,
       c.promedio,
       COALESCE(e.tareas_completadas, 0)    AS tareas_completadas,
       COALESCE(tot.tareas_totales, 0)      AS tareas_totales,
       CASE WHEN COALESCE(tot.tareas_totales,0) > 0
            THEN ROUND((COALESCE(e.tareas_completadas,0)::numeric / tot.tareas_totales) * 100, 2)
            ELSE 0 END                        AS porcentaje_progreso,
       CASE WHEN c.promedio >= 6 THEN 'Ganado' ELSE 'Perdido' END AS estado
FROM calculo c
LEFT JOIN entregadas e ON e.course_id = c.course_id AND e.student_id = c.student_id
LEFT JOIN totales   tot ON tot.course_id = c.course_id;

-- (A) Actualizar las filas que ya existen
UPDATE progreso_curso pc
SET tareas_completadas     = t.tareas_completadas,
    tareas_totales         = t.tareas_totales,
    promedio               = t.promedio,
    calificacion_ponderada = t.promedio,
    porcentaje_progreso    = t.porcentaje_progreso,
    estado                 = t.estado,
    ultima_calculada_en    = now()
FROM tmp_calc_curso t
WHERE pc.usuario_estudiante = t.student_id
  AND pc.curso_id           = t.course_id;

-- (B) Insertar las que no existían
INSERT INTO progreso_curso (
    curso_id, usuario_estudiante,
    tareas_completadas, tareas_totales,
    promedio, calificacion_ponderada,
    porcentaje_progreso, estado, ultima_calculada_en
)
SELECT t.course_id, t.student_id,
       t.tareas_completadas, t.tareas_totales,
       t.promedio, t.promedio,
       t.porcentaje_progreso, t.estado, now()
FROM tmp_calc_curso t
WHERE NOT EXISTS (
    SELECT 1 FROM progreso_curso pc
    WHERE pc.usuario_estudiante = t.student_id
      AND pc.curso_id           = t.course_id
);


-- ════════════════════════════════════════════════════════════════════════════
--  PASO 3 — CORRECCIÓN de progreso_materia  (mismo patrón UPDATE + INSERT)
-- ════════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS tmp_calc_materia;
CREATE TEMP TABLE tmp_calc_materia AS
WITH nota_por_tarea AS (
    SELECT DISTINCT ON (ts.student_id, ts.task_id)
           ts.student_id, ts.task_id, ts.grade
    FROM task_submissions ts
    WHERE ts.grade IS NOT NULL
    ORDER BY ts.student_id, ts.task_id,
             ts.graded_at DESC NULLS LAST,
             ts.submission_date DESC NULLS LAST,
             ts.id DESC
),
tarea_materia AS (
    SELECT t.id AS task_id, s.id AS materia_id, s.course_id
    FROM tasks t
    JOIN topics tp  ON tp.id = t.topic_id
    JOIN subjects s ON s.id = COALESCE(tp.materia_id, tp.subject_id)
),
totales AS (
    SELECT materia_id, course_id, COUNT(*) AS tareas_totales
    FROM tarea_materia GROUP BY materia_id, course_id
),
entregadas AS (
    SELECT tm.materia_id, tm.course_id, ts.student_id,
           COUNT(DISTINCT ts.task_id) AS tareas_completadas
    FROM task_submissions ts
    JOIN tarea_materia tm ON tm.task_id = ts.task_id
    GROUP BY tm.materia_id, tm.course_id, ts.student_id
),
calculo AS (
    SELECT tm.materia_id, tm.course_id, npt.student_id,
           ROUND(AVG(npt.grade)::numeric, 2) AS promedio
    FROM nota_por_tarea npt
    JOIN tarea_materia tm ON tm.task_id = npt.task_id
    GROUP BY tm.materia_id, tm.course_id, npt.student_id
)
SELECT c.course_id,
       c.materia_id,
       c.student_id::bigint                 AS student_id,
       c.promedio,
       COALESCE(e.tareas_completadas, 0)    AS tareas_completadas,
       COALESCE(tot.tareas_totales, 0)      AS tareas_totales,
       CASE WHEN COALESCE(tot.tareas_totales,0) > 0
            THEN ROUND((COALESCE(e.tareas_completadas,0)::numeric / tot.tareas_totales) * 100, 2)
            ELSE 0 END                        AS porcentaje_progreso,
       CASE WHEN c.promedio >= 6 THEN 'Ganado' ELSE 'Perdido' END AS estado
FROM calculo c
LEFT JOIN entregadas e
       ON e.materia_id = c.materia_id AND e.student_id = c.student_id
LEFT JOIN totales tot
       ON tot.materia_id = c.materia_id;

-- (A) Actualizar existentes
UPDATE progreso_materia pm
SET tareas_completadas     = t.tareas_completadas,
    tareas_totales         = t.tareas_totales,
    promedio               = t.promedio,
    calificacion_ponderada = t.promedio,
    porcentaje_progreso    = t.porcentaje_progreso,
    estado                 = t.estado,
    ultima_calculada_en    = now()
FROM tmp_calc_materia t
WHERE pm.usuario_estudiante = t.student_id
  AND pm.curso_id           = t.course_id
  AND pm.materia_id         = t.materia_id;

-- (B) Insertar faltantes
INSERT INTO progreso_materia (
    curso_id, materia_id, usuario_estudiante,
    tareas_completadas, tareas_totales,
    promedio, calificacion_ponderada,
    porcentaje_progreso, estado, ultima_calculada_en
)
SELECT t.course_id, t.materia_id, t.student_id,
       t.tareas_completadas, t.tareas_totales,
       t.promedio, t.promedio,
       t.porcentaje_progreso, t.estado, now()
FROM tmp_calc_materia t
WHERE NOT EXISTS (
    SELECT 1 FROM progreso_materia pm
    WHERE pm.usuario_estudiante = t.student_id
      AND pm.curso_id           = t.course_id
      AND pm.materia_id         = t.materia_id
);


-- ════════════════════════════════════════════════════════════════════════════
--  PASO 4 (OPCIONAL) — VERIFICACIÓN POST-FIX
--  Debe devolver 0 filas: todo promedio guardado coincide con el real.
-- ════════════════════════════════════════════════════════════════════════════
WITH nota_por_tarea AS (
    SELECT DISTINCT ON (ts.student_id, ts.task_id)
           ts.student_id, ts.task_id, ts.grade
    FROM task_submissions ts
    WHERE ts.grade IS NOT NULL
    ORDER BY ts.student_id, ts.task_id,
             ts.graded_at DESC NULLS LAST,
             ts.submission_date DESC NULLS LAST,
             ts.id DESC
),
tarea_curso AS (
    SELECT t.id AS task_id, s.course_id
    FROM tasks t
    JOIN topics tp  ON tp.id = t.topic_id
    JOIN subjects s ON s.id = COALESCE(tp.materia_id, tp.subject_id)
),
reales AS (
    SELECT tc.course_id, npt.student_id,
           ROUND(AVG(npt.grade)::numeric, 2) AS promedio_real
    FROM nota_por_tarea npt
    JOIN tarea_curso tc ON tc.task_id = npt.task_id
    GROUP BY tc.course_id, npt.student_id
)
SELECT r.course_id, r.student_id, r.promedio_real, pc.promedio AS promedio_guardado
FROM reales r
JOIN progreso_curso pc
  ON pc.usuario_estudiante = r.student_id AND pc.curso_id = r.course_id
WHERE ABS(COALESCE(pc.promedio, -1) - r.promedio_real) > 0.01   -- tolerancia por real vs numeric
ORDER BY r.course_id, r.student_id;


-- ════════════════════════════════════════════════════════════════════════════
--  NOTA — EFECTO COLATERAL EN CERTIFICADOS
--  Al subir los promedios, más estudiantes cruzan el umbral >= 6 y pasan a
--  'Ganado'. Este SQL solo marca el estado; NO inserta en `certificates`.
--  El backend auto-emite el certificado en el siguiente recálculo
--  (_recalculateAndUpsertUserCourseProgress → updateCertificate). Si necesitas
--  emitirlos inmediatamente desde SQL, pídemelo y añado el INSERT a certificates
--  respetando el guard fn_check_certificate_ganado.
--
--  NOTA — ÍNDICES ÚNICOS (opcional, mejora estructural)
--  Si en el futuro quieres habilitar ON CONFLICT y evitar filas duplicadas,
--  primero deduplica y luego crea los índices (fuera del alcance de este fix):
--    -- deduplicar conservando la fila más reciente:
--    -- DELETE FROM progreso_curso a USING progreso_curso b
--    --   WHERE a.usuario_estudiante=b.usuario_estudiante AND a.curso_id=b.curso_id
--    --     AND a.id < b.id;
--    -- CREATE UNIQUE INDEX ux_progreso_curso_user_course
--    --   ON progreso_curso (usuario_estudiante, curso_id);
-- ════════════════════════════════════════════════════════════════════════════
