-- =============================================================================
--  SEED — ICFES Matemáticas 2020 (20 preguntas)
--  Idempotente: safe to run multiple times.
--  Usa source_reference = 'MAT-2020-NN' como natural-key.
--
--  Prerequisito: migration_icfes_schema.sql ya ejecutado (taxonomía MAT presente).
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_mat_area_id            INT;
  v_sub_prob               INT;   -- Probabilidad básica
  v_sub_mcentral           INT;   -- Medidas de tendencia central
  v_sub_fun_lin            INT;   -- Funciones lineales y afines
  v_sub_trig               INT;   -- Trigonometría
  v_sub_triangulos         INT;   -- Triángulos y teorema de Pitágoras
  v_sub_areas              INT;   -- Áreas y volúmenes

  v_qid INT;

  -- Image URLs (R2 CDN)
  URL_PISA_ANGULO  CONSTANT TEXT := 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/icfes/Captura%20de%20pantalla%202026-05-02%20211145.png';
  URL_PISA_TABLA   CONSTANT TEXT := 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/icfes/Captura%20de%20pantalla%202026-05-02%20211701.png';
  URL_PISCINAS     CONSTANT TEXT := 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/icfes/Captura%20de%20pantalla%202026-05-02%20211859.png';
  URL_Q9_GRAFICAS  CONSTANT TEXT := 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/icfes/Captura%20de%20pantalla%202026-05-02%20212032.png';
  URL_COMETA       CONSTANT TEXT := 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/icfes/Captura%20de%20pantalla%202026-05-02%20212311.png';
  URL_ENCUESTA     CONSTANT TEXT := 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/icfes/Captura%20de%20pantalla%202026-05-02%20212444.png';
  URL_Q12_GEOM     CONSTANT TEXT := 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/icfes/Captura%20de%20pantalla%202026-05-02%20212710.png';
  URL_RAMIREZ      CONSTANT TEXT := 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/icfes/Captura%20de%20pantalla%202026-05-02%20213202.png';
  URL_Q18_ARBOL    CONSTANT TEXT := 'https://pub-9f393625246c4018b5613be60b01bda1.r2.dev/icfes/Captura%20de%20pantalla%202026-05-02%20214432.png';

BEGIN

  -- ── Resolve taxonomy IDs ──────────────────────────────────────────────────
  SELECT a.id INTO v_mat_area_id FROM icfes_areas a WHERE a.code = 'MAT';
  IF v_mat_area_id IS NULL THEN
    RAISE EXCEPTION 'MAT area not found — run migration_icfes_schema.sql first';
  END IF;

  SELECT s.id INTO v_sub_prob
    FROM icfes_subtopics s JOIN icfes_topics t ON t.id = s.topic_id
    WHERE t.area_id = v_mat_area_id AND s.name = 'Probabilidad básica';

  SELECT s.id INTO v_sub_mcentral
    FROM icfes_subtopics s JOIN icfes_topics t ON t.id = s.topic_id
    WHERE t.area_id = v_mat_area_id AND s.name = 'Medidas de tendencia central';

  SELECT s.id INTO v_sub_fun_lin
    FROM icfes_subtopics s JOIN icfes_topics t ON t.id = s.topic_id
    WHERE t.area_id = v_mat_area_id AND s.name = 'Funciones lineales y afines';

  SELECT s.id INTO v_sub_trig
    FROM icfes_subtopics s JOIN icfes_topics t ON t.id = s.topic_id
    WHERE t.area_id = v_mat_area_id AND s.name = 'Trigonometría';

  SELECT s.id INTO v_sub_triangulos
    FROM icfes_subtopics s JOIN icfes_topics t ON t.id = s.topic_id
    WHERE t.area_id = v_mat_area_id AND s.name = 'Triángulos y teorema de Pitágoras';

  SELECT s.id INTO v_sub_areas
    FROM icfes_subtopics s JOIN icfes_topics t ON t.id = s.topic_id
    WHERE t.area_id = v_mat_area_id AND s.name = 'Áreas y volúmenes';

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 1 — Probabilidad de bolas de colores
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_prob,
    'En una bolsa hay 3 bolas rojas, 3 negras y 12 blancas. Una persona afirma que al sacar una bola al azar, los tres colores tienen la misma probabilidad de salir. Esta afirmación es...',
    'Hay 18 bolas en total. P(roja)=3/18, P(negra)=3/18, P(blanca)=12/18. Como 3 < 12, el color blanco tiene mayor probabilidad; los tres colores NO son equiprobables.',
    2, 2020, 'MAT-2020-01', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-01';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'verdadera, pues el número de bolas de cada color no importa.',    FALSE, 'manual', 1.0),
    (v_qid, 'B', 'falsa, pues no se sabe el número total de bolas en la bolsa.',    FALSE, 'manual', 1.0),
    (v_qid, 'C', 'falsa, pues hay más bolas de un color que de los otros dos.',     TRUE,  'manual', 1.0),
    (v_qid, 'D', 'verdadera, pues las bolas están repartidas de igual manera.',     FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 2 — Ángulo en la torre de Pisa
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_triangulos,
    'La torre de Pisa, con respecto a la vertical, se ha inclinado 4° como se muestra en la imagen. ¿Cuánto mide el otro ángulo formado entre la torre y el suelo horizontal?',
    'La suma de los dos ángulos debe ser 90°. Como uno mide 4°, el otro mide 90° − 4° = 86°.',
    2, 2020, 'MAT-2020-02', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-02';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', '4°',   FALSE, 'manual', 1.0),
    (v_qid, 'B', '14°',  FALSE, 'manual', 1.0),
    (v_qid, 'C', '86°',  TRUE,  'manual', 1.0),
    (v_qid, 'D', '90°',  FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM icfes_question_images WHERE question_id = v_qid AND position = 'stem') THEN
    INSERT INTO icfes_question_images (question_id, position, url, alt, order_index)
    VALUES (v_qid, 'stem', URL_PISA_ANGULO, 'Diagrama de la torre de Pisa inclinada 4° respecto a la vertical', 0);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 3 — Porcentaje sin reserva (Torre de Pisa)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_mcentral,
    E'La torre de Pisa recibió visitas durante una semana: 3.100 visitantes sin reserva y 3.900 con reserva (total 7.000). Las entradas sin reserva cuestan 17 € y con reserva 22,5 €. (Ver tabla en imagen)\n\nAproximadamente, ¿qué porcentaje del total de personas que visitaron la torre esa semana entraron sin hacer reserva?',
    '3.100 sin reserva sobre 7.000 total: (3.100/7.000)×100 ≈ 44%.',
    3, 2020, 'MAT-2020-03', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-03';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', '56%', FALSE, 'manual', 1.0),
    (v_qid, 'B', '50%', FALSE, 'manual', 1.0),
    (v_qid, 'C', '44%', TRUE,  'manual', 1.0),
    (v_qid, 'D', '40%', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM icfes_question_images WHERE question_id = v_qid AND position = 'stem') THEN
    INSERT INTO icfes_question_images (question_id, position, url, alt, order_index)
    VALUES (v_qid, 'stem', URL_PISA_TABLA, 'Tabla de visitantes y precios de la torre de Pisa', 0);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 4 — Proceso de recaudo (Torre de Pisa)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_fun_lin,
    E'El proceso para obtener el dinero recaudado en la semana es:\n1. Sumar la cantidad de personas por tipo de entrada.\n2. Multiplicar esa cantidad por el precio de la entrada.\n3. Comparar los recaudos.\n\n¿Cuál de las siguientes preguntas NO se puede resolver empleando una parte del proceso anterior?',
    'Con el proceso solo se calcula el dinero recaudado por entradas. La ganancia total requiere conocer también los gastos, que son desconocidos.',
    3, 2020, 'MAT-2020-04', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-04';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', '¿Con cuál tipo de entrada se recaudó más dinero?',    FALSE, 'manual', 1.0),
    (v_qid, 'B', '¿Cuántas personas ingresaron en la semana?',          FALSE, 'manual', 1.0),
    (v_qid, 'C', '¿Cuál es la ganancia total del sitio turístico?',     TRUE,  'manual', 1.0),
    (v_qid, 'D', '¿Cuánto dinero se recaudó por tipo de entrada?',      FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM icfes_question_images WHERE question_id = v_qid AND position = 'stem') THEN
    INSERT INTO icfes_question_images (question_id, position, url, alt, order_index)
    VALUES (v_qid, 'stem', URL_PISA_TABLA, 'Tabla de visitantes y precios de la torre de Pisa', 0);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 5 — Recaudo total de la semana (Torre de Pisa)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_fun_lin,
    'El recaudo total de la semana de la Torre de Pisa, registrado en la tabla, fue aproximadamente de...',
    'Sin reserva: 3.100 × 17 = 52.700 €. Con reserva: 3.900 × 22,5 = 87.750 €. Total ≈ 140.450 € ≈ 140 mil euros.',
    3, 2020, 'MAT-2020-05', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-05';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', '14 mil euros.',    FALSE, 'manual', 1.0),
    (v_qid, 'B', '140 mil euros.',   TRUE,  'manual', 1.0),
    (v_qid, 'C', '120 euros.',       FALSE, 'manual', 1.0),
    (v_qid, 'D', '120.000 euros.',   FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM icfes_question_images WHERE question_id = v_qid AND position = 'stem') THEN
    INSERT INTO icfes_question_images (question_id, position, url, alt, order_index)
    VALUES (v_qid, 'stem', URL_PISA_TABLA, 'Tabla de visitantes y precios de la torre de Pisa', 0);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 6 — La mediana y los turistas (Torre de Pisa)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_mcentral,
    E'La mediana de la cantidad de turistas sin reserva que ingresan a la torre es 300 y la de los que ingresan con reserva es 600. Solamente teniendo esto en cuenta, ¿es correcto afirmar que entran el doble de turistas con reserva que sin ella?',
    'La mediana es el valor central de los datos ordenados, no representa el total ni el promedio. No se puede concluir que entran el doble de turistas con reserva.',
    3, 2020, 'MAT-2020-06', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-06';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'No, la mediana es una medida de localización central.',    TRUE,  'manual', 1.0),
    (v_qid, 'B', 'No, la mediana muestra la dispersión de los datos.',       FALSE, 'manual', 1.0),
    (v_qid, 'C', 'Sí, la mediana me da el promedio de los datos.',           FALSE, 'manual', 1.0),
    (v_qid, 'D', 'Sí, la mediana me da la mitad de los datos.',              FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM icfes_question_images WHERE question_id = v_qid AND position = 'stem') THEN
    INSERT INTO icfes_question_images (question_id, position, url, alt, order_index)
    VALUES (v_qid, 'stem', URL_PISA_TABLA, 'Tabla de visitantes de la torre de Pisa', 0);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 7 — Baldosas en piscinas (patrón)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_fun_lin,
    'El dueño de un parque recreativo planea construir tres piscinas y decorar sus bordes con baldosas blancas y azules. Según la observación de las figuras 1, 2 y 3 de la imagen, puede afirmarse correctamente que el número de baldosas...',
    'En la figura 1 hay 12 baldosas azules, en la 2 hay 18 (+6) y en la 3 hay 24 (+6). El número de baldosas azules aumenta en 6 de una piscina a la siguiente.',
    3, 2020, 'MAT-2020-07', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-07';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'azules se incrementa en seis de una piscina a la del siguiente tamaño.',        TRUE,  'manual', 1.0),
    (v_qid, 'B', 'blancas aumenta en ocho a medida que crece el tamaño de las piscinas.',         FALSE, 'manual', 1.0),
    (v_qid, 'C', 'azules es el doble de la cantidad de baldosas blancas en cada piscina.',        FALSE, 'manual', 1.0),
    (v_qid, 'D', 'blancas es la tercera parte de la cantidad de las baldosas azules.',            FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM icfes_question_images WHERE question_id = v_qid AND position = 'stem') THEN
    INSERT INTO icfes_question_images (question_id, position, url, alt, order_index)
    VALUES (v_qid, 'stem', URL_PISCINAS, 'Tres piscinas con bordes de baldosas blancas y azules de tamaño creciente', 0);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 8 — Fichas de dos caras (probabilidad imposible)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_prob,
    'Se lanzan cuatro fichas que tienen dos caras cada una. Una ficha es azul por sus dos caras, otra es blanca por sus dos caras, y las otras dos tienen una cara azul y una cara blanca. ¿Cuál de los siguientes eventos es imposible que ocurra?',
    'La ficha totalmente blanca siempre mostrará blanco en cualquier lanzamiento. Por tanto, es imposible obtener cuatro caras azules y cero blancas.',
    4, 2020, 'MAT-2020-08', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-08';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'Obtener una cara azul y tres caras blancas.',      FALSE, 'manual', 1.0),
    (v_qid, 'B', 'Obtener dos caras azules y dos caras blancas.',    FALSE, 'manual', 1.0),
    (v_qid, 'C', 'Obtener tres caras azules y una cara blanca.',     FALSE, 'manual', 1.0),
    (v_qid, 'D', 'Obtener cuatro caras azules y cero blancas.',      TRUE,  'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 9 — Función a trozos: costo en cinema (opciones son gráficas)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_fun_lin,
    E'El costo de la boleta en un cinema depende de la edad de la persona: menores de 8 años: $5.000; de 8 a 16 años: $7.000; de 16 a 56 años: $10.000; mayores de 56 años: $6.000.\n\nObserva las cuatro gráficas de la imagen y selecciona la que representa correctamente esta función a trozos.',
    'La gráfica A muestra correctamente los cuatro tramos: $5.000 (0–8), $7.000 (8–16), $10.000 (16–56) y $6.000 (mayores de 56), con intervalos abiertos/cerrados apropiados en cada tramo.',
    3, 2020, 'MAT-2020-09', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-09';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'Gráfica A', TRUE,  'manual', 1.0),
    (v_qid, 'B', 'Gráfica B', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'Gráfica C', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'Gráfica D', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM icfes_question_images WHERE question_id = v_qid AND position = 'stem') THEN
    INSERT INTO icfes_question_images (question_id, position, url, alt, order_index)
    VALUES (v_qid, 'stem', URL_Q9_GRAFICAS,
      'Cuatro gráficas (A, B, C y D) que representan posibles funciones a trozos para el costo del cine según la edad', 0);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 10 — Cometa triangular: error en análisis de pasos
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_triangulos,
    'En la figura se muestra la construcción de una cometa triangular con un ángulo de 150°. Se realiza un análisis por pasos para determinar si la cometa volará. Observa la imagen e identifica el paso en el que se comete un error.',
    'La suma de los ángulos internos de un triángulo es siempre 180°, no 160° como afirma el paso III. Allí está el error.',
    3, 2020, 'MAT-2020-10', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-10';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'Paso I',                                                                               FALSE, 'manual', 1.0),
    (v_qid, 'B', 'Paso III, porque la suma de los ángulos internos de un triángulo debe ser 180°',       TRUE,  'manual', 1.0),
    (v_qid, 'C', 'Paso VII',                                                                             FALSE, 'manual', 1.0),
    (v_qid, 'D', 'Paso VIII',                                                                            FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM icfes_question_images WHERE question_id = v_qid AND position = 'stem') THEN
    INSERT INTO icfes_question_images (question_id, position, url, alt, order_index)
    VALUES (v_qid, 'stem', URL_COMETA, 'Análisis por pasos de la cometa triangular con ángulo de 150°', 0);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 11 — Encuesta a 200 clientes
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_mcentral,
    'Se realizó una encuesta a 200 clientes sobre la calidad del servicio. El 35% la calificó como "bueno". ¿Cuál de las siguientes afirmaciones es verdadera? (Ver gráfica en imagen)',
    '35% de 200 = 70 clientes calificaron el servicio como "bueno". Por tanto, es verdadero que más de 60 clientes la consideran buena.',
    2, 2020, 'MAT-2020-11', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-11';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'Más de 30 clientes consideran que la calidad del servicio es excelente.',     FALSE, 'manual', 1.0),
    (v_qid, 'B', 'Menos de 50 clientes consideran que la calidad del servicio es regular.',     FALSE, 'manual', 1.0),
    (v_qid, 'C', 'Menos de 55 clientes están satisfechos con el servicio.',                     FALSE, 'manual', 1.0),
    (v_qid, 'D', 'Más de 60 clientes consideran que la calidad del servicio es bueno.',         TRUE,  'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM icfes_question_images WHERE question_id = v_qid AND position = 'stem') THEN
    INSERT INTO icfes_question_images (question_id, position, url, alt, order_index)
    VALUES (v_qid, 'stem', URL_ENCUESTA, 'Gráfica de resultados de la encuesta de calidad del servicio a 200 clientes', 0);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 12 — Construcción geométrica para bisectriz de MN
  --                (opciones son imágenes de construcciones)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_triangulos,
    E'En una clase de Matemáticas se pide dividir un segmento MN en dos partes congruentes mediante construcción geométrica con compás y regla.\n\nObserva las cuatro construcciones de la imagen y selecciona la que realizó correctamente el estudiante.',
    'La construcción D es correcta: se trazan dos arcos desde M y N con el mismo radio para obtener los puntos P y Q, y la recta PQ intersecta a MN en su punto medio R.',
    4, 2020, 'MAT-2020-12', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-12';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'Construcción A', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'Construcción B', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'Construcción C', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'Construcción D', TRUE,  'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM icfes_question_images WHERE question_id = v_qid AND position = 'stem') THEN
    INSERT INTO icfes_question_images (question_id, position, url, alt, order_index)
    VALUES (v_qid, 'stem', URL_Q12_GEOM,
      'Cuatro construcciones geométricas (A, B, C y D) para dividir el segmento MN en dos partes iguales', 0);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 13 — Tiempo adicional familia Ramírez
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_fun_lin,
    E'La familia Ramírez tiene contratado un plan de telefonía con 220 minutos locales incluidos. En enero el consumo total fue de 331 minutos en llamadas locales. Los minutos adicionales se cobran a una tarifa diferente. (Ver tabla en imagen)\n\nEl tiempo adicional consumido por la familia Ramírez en enero fue:',
    'Plan local = 220 min. Consumo enero = 331 min. Diferencia = 331 − 220 = 111 minutos = 1 hora y 51 minutos.',
    2, 2020, 'MAT-2020-13', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-13';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', '1 hora y 11 minutos.', FALSE, 'manual', 1.0),
    (v_qid, 'B', '1 hora y 51 minutos.', TRUE,  'manual', 1.0),
    (v_qid, 'C', '3 horas y 40 minutos.',FALSE, 'manual', 1.0),
    (v_qid, 'D', '5 horas y 31 minutos.',FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM icfes_question_images WHERE question_id = v_qid AND position = 'stem') THEN
    INSERT INTO icfes_question_images (question_id, position, url, alt, order_index)
    VALUES (v_qid, 'stem', URL_RAMIREZ, 'Tabla de la factura telefónica de la familia Ramírez en enero', 0);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 14 — Dato innecesario para diferencia de tarifas (familia Ramírez)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_fun_lin,
    E'Usando la información de la factura de la familia Ramírez (ver imagen), ¿cuál de los siguientes datos NO se necesita para hallar la diferencia entre el valor del minuto del plan local y el valor del minuto adicional?',
    'Para calcular la diferencia entre el valor por minuto del plan y el valor por minuto adicional solo se necesita el costo y los minutos del plan local, y el costo y los minutos adicionales. El total de cargos del mes es innecesario.',
    3, 2020, 'MAT-2020-14', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-14';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'La cantidad de minutos del plan.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'El valor del consumo adicional.',  FALSE, 'manual', 1.0),
    (v_qid, 'C', 'El total de cargos del mes.',      TRUE,  'manual', 1.0),
    (v_qid, 'D', 'El valor del plan local.',         FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM icfes_question_images WHERE question_id = v_qid AND position = 'stem') THEN
    INSERT INTO icfes_question_images (question_id, position, url, alt, order_index)
    VALUES (v_qid, 'stem', URL_RAMIREZ, 'Tabla de la factura telefónica de la familia Ramírez', 0);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 15 — Personas por hora en el hospital
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_fun_lin,
    'Isabel llegó al hospital con el turno número 180 (Nivel III). Tras 6 horas, el tablero electrónico marca el turno 240. ¿Aproximadamente cuántas personas por hora llegaron en ese tiempo?',
    'En 6 horas llegaron 240 − 180 = 60 personas. Entonces 60 ÷ 6 = 10 personas por hora.',
    2, 2020, 'MAT-2020-15', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-15';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', '60 personas por hora.', FALSE, 'manual', 1.0),
    (v_qid, 'B', '40 personas por hora.', FALSE, 'manual', 1.0),
    (v_qid, 'C', '15 personas por hora.', FALSE, 'manual', 1.0),
    (v_qid, 'D', '10 personas por hora.', TRUE,  'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 16 — Coordenadas de vértices de cuadrilátero trasladado
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_areas,
    'Se traslada y amplía un cuadrilátero en el plano cartesiano. Dos de los vértices de la figura resultante están en (−5, 7) y (−1, 1). ¿Cuáles son las coordenadas de los otros dos vértices?',
    'Al realizar la traslación y ampliación descrita, los vértices resultantes completan la figura en las coordenadas (−1, 5) y (3, 7).',
    3, 2020, 'MAT-2020-16', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-16';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', '(−1, 5) y (3, 7)',     TRUE,  'manual', 1.0),
    (v_qid, 'B', '(5, −1) y (7, 3)',     FALSE, 'manual', 1.0),
    (v_qid, 'C', '(5, 7) y (1, 1)',      FALSE, 'manual', 1.0),
    (v_qid, 'D', '(1, 5) y (−5, −7)',    FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 17 — Cuotas del apartamento (proporcionalidad inversa)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_fun_lin,
    'Un empresario compra un apartamento de $80.000.000 y puede pagarlo en diferentes cantidades de cuotas iguales (sin intereses). Respecto a la tabla de cuotas, es verdadero afirmar que...',
    'El número de cuotas y el valor de cada cuota son inversamente proporcionales: a mayor número de cuotas, menor valor por cuota, ya que el total siempre es $80.000.000.',
    3, 2020, 'MAT-2020-17', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-17';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'el empresario paga más por el apartamento dependiendo de la cantidad de cuotas que decida pagar.',  FALSE, 'manual', 1.0),
    (v_qid, 'B', 'de manera proporcional, a mayor cantidad de cuotas menor valor se pagará en cada una de ellas.',    TRUE,  'manual', 1.0),
    (v_qid, 'C', 'el empresario paga solo el valor del apartamento únicamente cuando elige el menor número de cuotas.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'de manera proporcional, a mayor valor pagado por cuota, más tiempo se tardará en pagar la deuda.',   FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 18 — Diagrama de árbol para 3 CD (opciones son diagramas)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_prob,
    E'Para ambientar una reunión se cuenta con 3 CD, cada uno con canciones de salsa (S) y merengue (M). Se desea seleccionar una canción de cada CD.\n\nObserva los cuatro diagramas de árbol de la imagen y selecciona el que representa correctamente todas las posibles selecciones.',
    'El diagrama A es correcto: tiene una sola raíz que se bifurca en S y M para el CD1; cada rama se bifurca en S y M para el CD2; y cada rama vuelve a bifurcarse en S y M para el CD3, generando 8 resultados posibles.',
    3, 2020, 'MAT-2020-18', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-18';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'Diagrama A', TRUE,  'manual', 1.0),
    (v_qid, 'B', 'Diagrama B', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'Diagrama C', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'Diagrama D', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM icfes_question_images WHERE question_id = v_qid AND position = 'stem') THEN
    INSERT INTO icfes_question_images (question_id, position, url, alt, order_index)
    VALUES (v_qid, 'stem', URL_Q18_ARBOL,
      'Cuatro diagramas de árbol (A, B, C y D) para seleccionar una canción de cada uno de los 3 CD', 0);
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 19 — Función trigonométrica de temperatura de un animal
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_trig,
    E'La temperatura corporal de un animal varía periódicamente. La temperatura mínima es 34°C, la máxima es 38°C y el período de variación es 3 horas. En t = 0 la temperatura es 36°C y va en aumento. ¿Cuál de las siguientes expresiones corresponde a la función que describe la temperatura en función del tiempo?',
    'La amplitud es (38−34)/2 = 2, el desplazamiento vertical es 36 y el período es 3 h, por lo que ω = 2π/3. En t = 0 la temperatura es 36°C y crece, lo que corresponde a la función seno: F(t) = 2 sen(2π/3 · t) + 36.',
    4, 2020, 'MAT-2020-19', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-19';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'F(t) = 2 cos(2π/3 · t) + 36', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'F(t) = 3 cos(2π/3 · t) + 38', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'F(t) = 2 sen(2π/3 · t) + 36', TRUE,  'manual', 1.0),
    (v_qid, 'D', 'F(t) = 3 sen(2π/3 · t) + 38', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 20 — Velocidad máxima y distancia (afirmación de Pilar)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_fun_lin,
    'La velocidad máxima de un automóvil es 100 km/h. Pilar afirma que en 100 horas el auto avanzará solamente 1 km. La afirmación de Pilar es...',
    '100 km/h significa que cada hora recorre 100 km. En 100 horas recorrería 100 × 100 = 10.000 km. La afirmación de Pilar es falsa.',
    2, 2020, 'MAT-2020-20', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'MAT-2020-20';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'falsa, porque a la velocidad máxima en una hora recorrerá 100 km.',                     TRUE,  'manual', 1.0),
    (v_qid, 'B', 'verdadera, porque al dividir la velocidad máxima entre 100 horas se obtiene 1 km.',    FALSE, 'manual', 1.0),
    (v_qid, 'C', 'falsa, porque en 100 horas el auto recorrerá 100 km.',                                 FALSE, 'manual', 1.0),
    (v_qid, 'D', 'verdadera, porque al dividir 100 entre 1, se obtiene el valor 100.',                   FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  RAISE NOTICE 'Seed MAT 2020 completado: 20 preguntas, opciones e imágenes insertadas (idempotente).';
END $$;

COMMIT;
