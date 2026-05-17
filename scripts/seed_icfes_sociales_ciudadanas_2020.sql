-- =============================================================================
--  SEED — ICFES Ciencias Sociales y Ciudadanas 2020 (20 preguntas)
--  Idempotente: safe to run multiple times.
--  Usa source_reference = 'SOC-2020-NN' como natural-key.
--
--  Prerequisito: migration_icfes_schema.sql ya ejecutado (taxonomía SOC presente).
--
--  Subtopics existentes (SOC / Ciudadanía):
--    • Constitución política de Colombia
--    • Participación democrática
--  Subtopics nuevos que este seed añade (idempotente):
--    • Historia y sociedad colombiana
--    • Relaciones internacionales y geopolítica
--    • Pensamiento crítico y social
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_soc_area_id   INT;
  v_sub_const     INT;   -- Constitución política de Colombia
  v_sub_part      INT;   -- Participación democrática
  v_sub_hist      INT;   -- Historia y sociedad colombiana
  v_sub_inter     INT;   -- Relaciones internacionales y geopolítica
  v_sub_pens      INT;   -- Pensamiento crítico y social
  v_qid           INT;

BEGIN

  -- ── Resolve SOC area ──────────────────────────────────────────────────────
  SELECT a.id INTO v_soc_area_id FROM icfes_areas a WHERE a.code = 'SOC';
  IF v_soc_area_id IS NULL THEN
    RAISE EXCEPTION 'SOC area not found — run migration_icfes_schema.sql first';
  END IF;

  -- ── Bootstrap new subtopics (idempotente) ──────────────────────────────────
  INSERT INTO icfes_subtopics (topic_id, name)
  SELECT t.id, 'Historia y sociedad colombiana'
  FROM icfes_topics t
  WHERE t.name = 'Ciudadanía' AND t.area_id = v_soc_area_id
  ON CONFLICT (topic_id, name) DO NOTHING;

  INSERT INTO icfes_subtopics (topic_id, name)
  SELECT t.id, 'Relaciones internacionales y geopolítica'
  FROM icfes_topics t
  WHERE t.name = 'Ciudadanía' AND t.area_id = v_soc_area_id
  ON CONFLICT (topic_id, name) DO NOTHING;

  INSERT INTO icfes_subtopics (topic_id, name)
  SELECT t.id, 'Pensamiento crítico y social'
  FROM icfes_topics t
  WHERE t.name = 'Ciudadanía' AND t.area_id = v_soc_area_id
  ON CONFLICT (topic_id, name) DO NOTHING;

  -- ── Resolve subtopic IDs ──────────────────────────────────────────────────
  SELECT s.id INTO v_sub_const
    FROM icfes_subtopics s JOIN icfes_topics t ON t.id = s.topic_id
    WHERE t.area_id = v_soc_area_id AND s.name = 'Constitución política de Colombia';

  SELECT s.id INTO v_sub_part
    FROM icfes_subtopics s JOIN icfes_topics t ON t.id = s.topic_id
    WHERE t.area_id = v_soc_area_id AND s.name = 'Participación democrática';

  SELECT s.id INTO v_sub_hist
    FROM icfes_subtopics s JOIN icfes_topics t ON t.id = s.topic_id
    WHERE t.area_id = v_soc_area_id AND s.name = 'Historia y sociedad colombiana';

  SELECT s.id INTO v_sub_inter
    FROM icfes_subtopics s JOIN icfes_topics t ON t.id = s.topic_id
    WHERE t.area_id = v_soc_area_id AND s.name = 'Relaciones internacionales y geopolítica';

  SELECT s.id INTO v_sub_pens
    FROM icfes_subtopics s JOIN icfes_topics t ON t.id = s.topic_id
    WHERE t.area_id = v_soc_area_id AND s.name = 'Pensamiento crítico y social';

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 1 — Canción de los dinosaurios / dictadura argentina
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_part,
    'La siguiente es una estrofa de la Canción de los dinosaurios, compuesta e interpretada por el músico argentino Charlie García en 1983:
"Los amigos del barrio pueden desaparecer
Los cantores de radio pueden desaparecer
Los que están en los diarios pueden desaparecer
La persona que amas puede desaparecer.
Los que están en el aire pueden desaparecer, en el aire.
Los que están en la calle pueden desaparecer, en la calle.
Los amigos del barrio pueden desaparecer,
Pero los dinosaurios van a desaparecer".
Tomado de: García, C. (1983). Los dinosaurios. En: Clics modernos [LP]. Buenos Aires, Argentina: SG Discos.
Puede afirmarse que la letra de esta canción:',
    'La repetición de la palabra "desaparecer" es una clara referencia a la desaparición forzada de personas, práctica sistemática de la dictadura militar argentina (1976-1983). El arte funciona como registro histórico y herramienta de denuncia frente a la vulneración de derechos humanos.',
    2, 2020, 'SOC-2020-01', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-01';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'tiene relación con la época de la dictadura argentina, porque Charlie García tiene esa nacionalidad.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'no tiene relación con la dictadura, en tanto en este tipo de gobierno se respetan los derechos civiles y políticos.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'tiene relación con la dictadura argentina, en tanto describe la persecución social y política característica de los regímenes dictatoriales.', TRUE, 'manual', 1.0),
    (v_qid, 'D', 'no tiene relación con la dictadura argentina, dado que el arte y la política son ámbitos independientes de la vida social.', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 2 — Libertad de culto (niño en colegio público)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_const,
    'Un niño presenta una entrevista para ingresar en un colegio público. Durante la entrevista, le preguntan a qué religión pertenece. Al finalizar la entrevista, le dicen al niño que pueden admitirlo si accede a participar en las ceremonias religiosas del colegio, aunque él profese una religión distinta. El derecho fundamental que se le violaría al niño en este caso sería:',
    'La Constitución protege el derecho fundamental a la libertad de culto (y de religión), lo que implica que ninguna persona puede ser obligada a participar en prácticas o ritos de una religión que no es la suya. Condicionar la educación de un niño en una institución pública a dicha participación es una violación directa de este derecho.',
    1, 2020, 'SOC-2020-02', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-02';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'a la libertad de culto.', TRUE, 'manual', 1.0),
    (v_qid, 'B', 'a la libre personalidad.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'a la libertad de conciencia.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'a la libre expresión.', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 3 — Movilidad urbana y demanda inducida
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_pens,
    'Uno de los principales problemas de las grandes ciudades es la dificultad para movilizarse debido a la gran cantidad de automóviles. Tradicionalmente, se ha propuesto que la mejor solución para este problema es construir más vías que permitan el flujo de más automóviles. Esta solución puede ser efectiva, pero puede generar efectos no deseados. ¿Cuál es uno de estos efectos?',
    'En planificación urbana existe el fenómeno de la ''demanda inducida'': si se construyen más vías, el viaje en automóvil se vuelve más cómodo, lo que motiva a más personas a usar carro. A largo plazo, las nuevas vías se congestionan igual, anulando la solución inicial.',
    3, 2020, 'SOC-2020-03', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-03';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'Construir más vías genera más empleos en la construcción.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'Construir más vías incentiva el uso del automóvil.', TRUE, 'manual', 1.0),
    (v_qid, 'C', 'Construir más vías disminuye la velocidad de circulación de los automóviles.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'Construir más vías, y su posterior utilización, genera más contaminación.', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 4 — Reforma pensiones y el Congreso
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_const,
    'El presidente de la República de Colombia quiere reformar las leyes que regulan el sistema de pensiones. Para lograr esta reforma, su propuesta debe ser aprobada por:',
    'En la división de poderes de Colombia, la rama ejecutiva puede proponer proyectos de ley, pero es la rama legislativa (el Congreso de la República, compuesto por el Senado y la Cámara de Representantes) la encargada de debatir y aprobar o rechazar dichas reformas por regla de mayoría.',
    1, 2020, 'SOC-2020-04', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-04';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'el voto unánime de la Corte Constitucional.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'la totalidad de miembros de la Cámara de Representantes.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'la mayoría de la rama judicial del poder público.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'la mayoría de miembros del Congreso de la República.', TRUE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 5 — Debate adopción parejas homosexuales
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_pens,
    'Hay en Colombia un gran debate sobre la posible adopción de niños por parte de parejas homosexuales. Quienes están a favor cuestionan la tesis de que es necesario que la familia empiece con un hombre y una mujer. Un vocero de este grupo dijo que nada garantiza que la orientación sexual de los cónyuges determine la preferencia sexual del menor. Además, sostiene que hay muchos niños abandonados que se beneficiarían de crecer en una familia, independientemente de la composición de esta. Por otro lado, un opositor argumenta que, desde el punto de vista psicológico, los niños adoptados por parejas homosexuales muy probablemente van a aprender "conductas equivocadas". Además, sostiene que "Dios concibió al hombre y la mujer para ser pareja y procrear".
Entre las siguientes opciones, ¿cuál presenta lo que cada una de las partes probablemente quiere lograr?',
    'Aunque ambas partes tienen posturas radicalmente opuestas, ambos basan sus argumentos en lo que consideran mejor para el niño: el vocero cree que lo mejor es darles un hogar; el opositor cree que lo mejor es protegerlos de las ''conductas equivocadas''. Ambos invocan el bienestar infantil.',
    3, 2020, 'SOC-2020-05', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-05';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'El opositor busca defender la familia tradicional y cuidar de los niños; el vocero busca cambiar la forma de la familia nuclear sin importarle el bienestar de los niños.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'El vocero quiere que se permita adoptar a las parejas homosexuales; el opositor quiere mantener la familia tradicional, y ambos buscan bienestar para los niños.', TRUE, 'manual', 1.0),
    (v_qid, 'C', 'El opositor está preocupado por la manera en que debe estar formada la familia, sin importarle el bienestar de los niños; el vocero defiende el bienestar de estos.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'El vocero busca cambiar la constitución de la familia tradicional; el opositor está de acuerdo, y ambos quieren facilitar la adopción de niños abandonados.', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 6 — Patente de examen de embarazo (conflicto)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_pens,
    'Un profesor de una prestigiosa universidad invierte dinero y tiempo en diseñar un examen novedoso que determina con mayor exactitud y más rapidez si una mujer está embarazada. El profesor y sus estudiantes realizan muchos experimentos para demostrar la efectividad de su prueba antes de publicar sus resultados. La universidad patenta el examen antes de sacarlo al mercado. Una vez la prueba sale al mercado, se crea un conflicto.
¿Cuál de las siguientes afirmaciones NO plantea un posible escenario de conflicto entre las partes involucradas?',
    'Las opciones A, B y C representan claros conflictos legales y económicos (plagio de patente, demandas por negligencia, disputas de autoría). La opción D —divulgar resultados académicos en foros internacionales— es la práctica normal y esperada; dado que la universidad ya patentó el producto, la divulgación académica no genera conflicto de derechos.',
    3, 2020, 'SOC-2020-06', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-06';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'Un laboratorio privado desarrolla y comercializa el mismo examen de detección temprana de embarazos.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'Las mujeres partícipes del estudio demandan a la universidad porque los resultados no son tan acertados como el profesor sugiere.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'El profesor quiere quedarse con la patente de la prueba y comercializarla por su cuenta.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'Los estudiantes participantes en la investigación divulgan los resultados de la investigación en diversos escenarios internacionales.', TRUE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 7 — Guantánamo y Uruguay (argumento opositor)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_inter,
    'En marzo de 2014, Estados Unidos pidió a varios países recibir como refugiados a varias personas detenidas en la prisión de Guantánamo desde hace más de una década. Esta prisión ha sido objeto de varias controversias y debates por violaciones a los derechos humanos de los presos. El presidente de Uruguay fue uno de los primeros en responder positivamente la petición. "Hay 120 tipos que están presos hace 13 años. No han visto un juez, un fiscal, no tuvieron ningún proceso. La decisión contribuirá a garantizar los derechos humanos de estas personas, que están hace más de 10 años tras las rejas sin juicio", afirmó el mandatario. Aunque varias organizaciones humanitarias han celebrado esta decisión, sectores políticos uruguayos la critican.
¿Cuál de los siguientes podría ser un argumento afín a quienes se oponen a la decisión del presidente uruguayo?',
    'Quienes se oponen a recibir prisioneros de Guantánamo suelen argumentar el riesgo a la seguridad nacional: al ser personas detenidas bajo sospechas de terrorismo (aunque sin juicio), la oposición argumenta que introducirlos al país supone un riesgo potencial para los ciudadanos.',
    2, 2020, 'SOC-2020-07', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-07';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'La decisión favorecería el derecho de los defendidos a tener un juicio.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'La decisión estaría dándole la posibilidad a los refugiados de vivir como hombres libres e integrarse de nuevo a la sociedad.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'La decisión pondría en peligro la seguridad del país, pues no se sabe qué personas llegarán al país.', TRUE, 'manual', 1.0),
    (v_qid, 'D', 'La decisión causaría un mayor hacinamiento en las cárceles de Uruguay, al recibir presos de la cárcel de Guantánamo.', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 8 — Movimiento estudiantil MANE y democracia
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_part,
    'En el 2011, el movimiento estudiantil colombiano se organizó a través de la Mesa Amplia Nacional Estudiantil (MANE), con el fin de protestar en contra del proyecto de ley de Reforma a la Educación Superior propuesto por el Gobierno nacional.
Los estudiantes exigían una discusión amplia y democrática del contenido de la reforma, la cual ya estaba siendo discutida en el Congreso de la República. Ante las protestas, algunos sectores sociales insistieron en que tales manifestaciones generaban inestabilidad y que las reclamaciones debían tramitarse por las vías institucionales de representación democrática, tales como el legislativo.
Finalmente, y después de dos meses de movilizaciones, el Gobierno decidió retirar el proyecto de ley y generar un proceso de socialización con la sociedad civil, incluidos estudiantes, profesores y directivos universitarios, entre otros.
De acuerdo con la situación descrita, ¿cuál de las siguientes opciones describe adecuadamente la relación entre los movimientos sociales y la democracia?',
    'El caso demuestra que la democracia no se limita a votar y dejar todo en manos del Congreso. La movilización social pacífica es una herramienta legítima que enriquece la democracia porque obliga al Estado a escuchar y dialogar con los sectores directamente afectados.',
    2, 2020, 'SOC-2020-08', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-08';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'Los movimientos sociales derivan en protestas que generan un ambiente de inestabilidad y debilitan la democracia.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'Los movimientos sociales solo son democráticos cuando hacen uso de las vías institucionales de representación.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'Los movimientos sociales permiten canalizar y expresar demandas sociales y, por tanto, fortalecen la democracia.', TRUE, 'manual', 1.0),
    (v_qid, 'D', 'Los movimientos sociales son los únicos mecanismos de representación y participación en una democracia como la colombiana.', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 9 — Pueblos indígenas y propiedad colectiva de la tierra
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_hist,
    'Un informe de la UNICEF sobre los pueblos indígenas en Colombia señala lo siguiente:
"La tierra para los indígenas tiene un significado amplio, que comprende no solo la superficie sino los recursos naturales —flora, fauna, ríos, lagos, etc.— que hay en ella. En contraste con el concepto de propiedad individual, propio de la cultura occidental, la tierra y los recursos son, generalmente, poseídos y utilizados en forma comunitaria por los indígenas".
Analizando el contenido de este fragmento, se puede afirmar que hay diferencias culturales entre los pueblos indígenas y otros grupos sociales que habitan en Colombia, porque los indígenas:',
    'El texto hace un contraste explícito entre la visión occidental de la tierra (como "propiedad individual") y la visión indígena (como un todo de uso "comunitario"). Esto evidencia una profunda diferencia en la concepción, uso y tenencia de los recursos naturales.',
    2, 2020, 'SOC-2020-09', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-09';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'tienen prácticas más avanzadas de protección del medio ambiente que otros grupos sociales.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'consideran que la propiedad colectiva es más rentable que la propiedad privada.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'no recibieron ninguna influencia de las culturas occidentales que llegaron al continente.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'tienen concepciones distintas sobre el uso y aprovechamiento de los recursos naturales.', TRUE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 10 — Narcotráfico y violencia urbana en Colombia (década 1980)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_hist,
    '"… con el surgimiento del narcotráfico de una manera organizada y alrededor del tema de la producción, distribución, circulación y protección de los narcotraficantes, llegaron propuestas de organización de grupos delincuenciales a los barrios populares con distintas funciones: cuidar el negocio, ajustar cuentas y cobrar venganza. Se fortaleció entonces un aparato militar, al lado de una cultura de enriquecimiento fácil y de solución violenta de los conflictos…".
Tomado de: Yarse, E. (2007). En series el Colombiano.
De acuerdo con los elementos incluidos en el artículo anterior, se podría deducir que en este se hace referencia a la violencia urbana de la década de:',
    'El texto describe exactamente el fenómeno ocurrido en Colombia durante los años 80, cuando los grandes carteles de la droga reclutaron jóvenes de barrios populares, creando estructuras sicariales y promoviendo la cultura del dinero fácil (particularmente en Medellín y Cali). La opción A es correcta por mencionar específicamente la influencia de los carteles.',
    2, 2020, 'SOC-2020-10', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-10';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', '1980, porque se describe la influencia de los carteles en la configuración de prácticas delictivas.', TRUE, 'manual', 1.0),
    (v_qid, 'B', '1990, porque se ubica como protagonistas a bandas criminales financiadas por paramilitares.', FALSE, 'manual', 1.0),
    (v_qid, 'C', '1980, porque se hace referencia a una práctica violenta como forma de solucionar los problemas.', FALSE, 'manual', 1.0),
    (v_qid, 'D', '1960, porque se instala como escenario del conflicto a la ciudad, en particular los barrios populares.', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 11 — Integración económica y la Unión Europea
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_inter,
    'La integración económica se da cuando países cercanos acuerdan unificar aspectos de su política económica y social. Esto se traduce en el uso de una misma moneda y en la libre circulación de mercancías y personas dentro de sus territorios.
En la actualidad, el ejemplo más visible y claro de integración económica lo constituye:',
    'La Unión Europea es el estadio más avanzado de integración económica y política en el mundo actual. Cumple con los criterios del texto: moneda común (el euro) y libre circulación de personas, bienes, servicios y capitales (espacio Schengen y Mercado Único Europeo).',
    2, 2020, 'SOC-2020-11', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-11';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'el Mercado Común del Sur (Mercosur).', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'los Estados Unidos de Norteamérica.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'el Tratado de Libre Comercio (TLC).', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'la Unión Europea (EU).', TRUE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 12 — Estado de excepción y la Corte Constitucional
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_const,
    'En Colombia, si el presidente quisiera declarar el estado de excepción para controlar a los medios de comunicación de la oposición, ¿cuál debería ser la posición de la Corte Constitucional?',
    'En el ordenamiento jurídico colombiano (Constitución de 1991), los estados de excepción le dan poderes extraordinarios al presidente para afrontar crisis, pero tienen un límite estricto: no pueden suspender los derechos humanos ni las libertades fundamentales como la libertad de prensa y expresión. La Corte Constitucional está obligada a velar por esta norma.',
    3, 2020, 'SOC-2020-12', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-12';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'Rechazar la propuesta del presidente, porque solo la Corte puede declarar el estado de excepción.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'Apoyar la petición, pues a veces los medios transmiten información que puede generar caos.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'Rechazar este uso del estado de excepción, porque esta figura no puede usarse para vulnerar las libertades fundamentales.', TRUE, 'manual', 1.0),
    (v_qid, 'D', 'Apoyar al presidente, pues la Corte Constitucional debe trabajar junto al poder ejecutivo para favorecer la unidad del Estado.', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 13 — Conflictos armados África vs. Latinoamérica
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_inter,
    'Un informe sobre las causas de los conflictos armados entre etnias en África plantea que los ejércitos insurgentes financian sus operaciones mediante el saqueo de recursos naturales. Por tanto, se propone en este informe que una de las posibles soluciones a los conflictos armados sea evitar que los grupos armados tengan acceso a estos recursos. ¿Es posible adaptar esta solución a los conflictos latinoamericanos?',
    'La solución propuesta ataca la fuente de financiamiento del grupo armado, no su motivación ideológica o étnica. Si en América Latina los grupos armados ilegales se financian extrayendo y vendiendo recursos naturales (minería ilegal, pasta base de coca), la estrategia de cortarles el acceso es totalmente aplicable, independientemente del origen del conflicto.',
    3, 2020, 'SOC-2020-13', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-13';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'No, porque los conflictos armados en América Latina no se relacionan con conflictos entre etnias.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'No, porque los conflictos armados en África tienen raíces históricas distintas a los de América Latina.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'Sí, si los conflictos armados en América Latina, como los africanos, tienen causas étnicas.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'Sí, si se comprueba que los ejércitos insurgentes en América Latina financian sus actividades con la explotación de recursos naturales.', TRUE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 14 — Unión Patriótica y Bernardo Jaramillo Ossa
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_hist,
    '"La Unión Patriótica no puede asumir el compromiso de la combinación de todas las formas de lucha, porque ni es una organización marxista-leninista, ni representa los intereses de una sola clase social, y su política es eminentemente civilista. Nosotros, las víctimas propiciatorias de la guerra sucia, mal haríamos en reivindicar la lucha armada como una opción política". Este testimonio pertenece a Bernardo Jaramillo Ossa, político y militante de izquierda, asesinado en Bogotá, D. C. en 1990.
De esta alocución, se puede concluir que la intención del autor es:',
    'La frase ''combinación de todas las formas de lucha'' era una doctrina explícita de grupos guerrilleros (particularmente las FARC). Al rechazar este concepto y afirmar que la política del partido es "eminentemente civilista", Jaramillo Ossa intentaba trazar una línea clara para separar a su partido político legal (la UP) de la insurgencia armada.',
    3, 2020, 'SOC-2020-14', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-14';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'buscar alternativas de paz para la desmovilización de una organización guerrillera.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'denunciar la persecución política a los militantes de los partidos de izquierda.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'defender el derecho a la participación política de la Unión Patriótica.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'desmarcar la Unión Patriótica de la ideología de los grupos subversivos.', TRUE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 15 — Ruptura de relaciones diplomáticas
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_inter,
    'El Gobierno nacional ha decidido romper relaciones con un Gobierno vecino después de recibir información de algunos campesinos que habitan en la frontera, en el sentido de que ha habido movimientos del ejército del país vecino y que, según ellos, ese país vecino se prepara para invadir a Colombia.
La decisión de romper relaciones con el país vecino es:',
    'En las relaciones internacionales, romper lazos diplomáticos es una medida extrema que puede llevar a crisis severas. Tomar esa decisión basándose únicamente en el testimonio de habitantes locales, sin inteligencia militar, verificación satelital ni canales diplomáticos oficiales, es altamente imprudente e insuficiente.',
    3, 2020, 'SOC-2020-15', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-15';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'adecuada siempre que los campesinos no hayan sido manipulados por los políticos locales.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'apresurada porque se sustenta en información insuficiente y posiblemente parcializada.', TRUE, 'manual', 1.0),
    (v_qid, 'C', 'adecuada y acorde con la protección de nuestro interés general.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'apresurada porque la declaración de unos campesinos no puede ser confiable.', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 16 — Derecho a la libre asociación (sindicato)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_const,
    'En una empresa, uno de los miembros de la junta directiva le dice al gerente general: "Hay un grupo de empleados que está inconforme con las políticas laborales que implementamos recientemente. Esto preocupa, porque es un grupo muy activo que, al parecer, está movilizando a varios empleados con el objetivo de conformar un sindicato". Ante esto, el gerente afirmó: "Propongo hablar con ese grupo para comunicarle que aquí están prohibidas las protestas y las movilizaciones, y que, si tienen alguna inquietud, será atendida de manera individual con cada empleado". ¿Qué derecho constitucional podría ponerse en riesgo con la propuesta del gerente?',
    'La Constitución Política protege el derecho a la libre asociación y, específicamente, el derecho de los trabajadores a conformar sindicatos para defender sus intereses laborales (libertad sindical). La prohibición del gerente de movilizarse y su insistencia en tratar quejas individualmente busca destruir este derecho colectivo.',
    2, 2020, 'SOC-2020-16', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-16';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'El derecho al libre acceso a la información.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'El derecho a la participación política.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'El derecho a la libertad de creencias.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'El derecho a la libre asociación.', TRUE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 17 — Acción solidaria y la Constitución Política
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_const,
    '¿Cuál de las siguientes situaciones requiere una acción solidaria, derivada de lo contemplado en la Constitución Política de Colombia?',
    'El principio constitucional de solidaridad social obliga al Estado y a los ciudadanos a responder con acciones humanitarias ante situaciones que pongan en peligro inminente la vida o la salud de las personas. Un desastre natural con heridos graves y riesgo de nuevos deslizamientos requiere intervención solidaria inmediata. Los demás escenarios son temas de derechos civiles o económicos, no de acción solidaria ante emergencias vitales.',
    2, 2020, 'SOC-2020-17', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-17';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'Hubo un deslizamiento de tierras que dejó varios heridos graves. Las familias no han sido evacuadas de la zona, la cual podría presentar más deslizamiento.', TRUE, 'manual', 1.0),
    (v_qid, 'B', 'Los estudiantes de un colegio reclaman poder ir al colegio con el pelo largo o tinturado, ante lo cual las directivas han respondido con un no rotundo.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'Un grupo numeroso de ciudadanos y ciudadanas homosexuales reclaman su derecho a casarse, pero los organismos pertinentes no han respondido.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'El 46 % de la población rural trabaja en condiciones que hacen que su capacidad adquisitiva haya disminuido en los últimos años.', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 18 — Reglamento de vecinos (denominador común: el ruido)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_pens,
    'Los vecinos de un conjunto de viviendas se reúnen para redactar conjuntamente el reglamento de habitantes. Un grupo de vecinos considera que no se deben permitir mascotas en el conjunto, por el ruido y suciedad que estas pueden producir. Otro grupo considera que se pueden permitir las mascotas, pero que no se deben permitir las fiestas en las noches. De acuerdo con lo anterior, los puntos de vista de los dos grupos son semejantes, porque creen que:',
    'Ambos grupos tienen un denominador común: les molesta el ruido (de las mascotas al primer grupo, y de las fiestas nocturnas al segundo). Ambos fundamentan sus restricciones en la necesidad de mantener la tranquilidad del conjunto para no incomodar al resto de vecinos.',
    2, 2020, 'SOC-2020-18', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-18';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'es más importante la limpieza del conjunto que las preferencias de los residentes.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'es responsabilidad de todos los residentes cuidar los espacios comunes del conjunto.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'es importante que los residentes eviten hacer ruido que moleste a los demás vecinos.', TRUE, 'manual', 1.0),
    (v_qid, 'D', 'se debe respetar el derecho de todos de disponer de sus predios como les parezca.', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 19 — Portal educativo en internet (brecha digital)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_pens,
    'Un político propuso que, para asegurar la calidad en la educación escolar y que todos los estudiantes tengan acceso a los mismos libros de texto, estos deberían publicarse en un portal de internet.
¿Cuál de las siguientes opciones expresa condiciones que dificultan la implementación de esta propuesta?',
    'La principal barrera para digitalizar completamente el material educativo en Colombia es la profunda brecha digital. Muchas escuelas, especialmente en zonas rurales o marginadas, carecen de conexión a internet o de dispositivos electrónicos suficientes para acceder al portal web.',
    2, 2020, 'SOC-2020-19', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-19';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'La propuesta no tiene en cuenta las condiciones tecnológicas de las instituciones de todo el país.', TRUE, 'manual', 1.0),
    (v_qid, 'B', 'Los políticos no son expertos en pedagogía y por eso sus propuestas no son adecuadas.', FALSE, 'manual', 1.0),
    (v_qid, 'C', 'La propuesta no tiene en cuenta que los libros en internet suelen tener información errada.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'Los estudiantes no deberían tener libros iguales porque sus condiciones socioeconómicas son distintas.', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════════
  --  PREGUNTA 20 — Hotel Tayrona y bosque seco (énfasis ambiental)
  -- ═══════════════════════════════════════════════════════════════════════════
  INSERT INTO icfes_questions (subtopic_id, stem, explanation, difficulty, source_year, source_reference, is_active)
  VALUES (
    v_sub_pens,
    'Un periódico colombiano publicó la siguiente noticia: "Luego de que la autoridad nacional a cargo de las licencias ambientales autorizara la construcción de un hotel ecoturístico dentro del parque Tayrona, territorio ancestral indígena, el ministro de Ambiente y Desarrollo Sostenible puso en duda la viabilidad de esa obra. De acuerdo con el ministro, la licencia que tiene este hotel no es viable porque permite talar una porción de bosque seco, ecosistema que está casi extinto en Colombia".
Tomado y adaptado de: Redacción Vida de Hoy (2013, 10 de enero). Gobierno considera inviable hotel en el Tayrona. El Tiempo.
En esta noticia, el narrador está dándole un mayor énfasis a:',
    'Aunque la noticia menciona el territorio indígena y cita a un actor político (el ministro), el núcleo del argumento expuesto para detener la obra es puramente ecológico: impedir la tala del "bosque seco", descrito como un ecosistema "casi extinto". El énfasis está puesto en el grave peligro ambiental y la protección de los recursos naturales del parque.',
    3, 2020, 'SOC-2020-20', TRUE
  ) ON CONFLICT (source_reference) DO NOTHING;
  SELECT id INTO v_qid FROM icfes_questions WHERE source_reference = 'SOC-2020-20';

  INSERT INTO icfes_question_options (question_id, label, content, is_correct, answer_source, answer_confidence) VALUES
    (v_qid, 'A', 'el efecto político del proyecto porque registra la reacción del Gobierno nacional.', FALSE, 'manual', 1.0),
    (v_qid, 'B', 'el riesgo que corren los recursos de un parque nacional, debido a la licencia ambiental.', TRUE, 'manual', 1.0),
    (v_qid, 'C', 'la restricción económica del proyecto hotelero, pues habla de su viabilidad.', FALSE, 'manual', 1.0),
    (v_qid, 'D', 'la construcción de un hotel ecoturístico en un territorio ancestral indígena.', FALSE, 'manual', 1.0)
  ON CONFLICT (question_id, label) DO NOTHING;

END $$;

COMMIT;
