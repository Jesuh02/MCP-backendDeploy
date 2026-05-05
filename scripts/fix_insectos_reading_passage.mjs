#!/usr/bin/env node
/**
 * fix_insectos_reading_passage.mjs
 *
 * Actualiza reading_passage de las preguntas LC-2022-Q04, Q05, Q06, Q07
 * («Insectos a la carta» — Infografía Chumpitazi 2014 / FAO) para que
 * incluyan el texto completo de la infografía. Sin esto, la pregunta
 *   "Los datos que se presentan en el texto se han tomado de..."
 * se muestra sin contexto y resulta imposible de responder.
 *
 * Uso:
 *   node scripts/fix_insectos_reading_passage.mjs --dry-run
 *   node scripts/fix_insectos_reading_passage.mjs
 */

import { createClient } from '@supabase/supabase-js';

const DRY_RUN = process.argv.includes('--dry-run');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Define SUPABASE_URL y SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const FULL_PASSAGE = `TEXTO: «Insectos a la carta» — Infografía (Chumpitazi, 2014 / FAO)

¿Cuántas especies podemos consumir? Actualmente se consumen 1.900 especies. De 1,4 millones de especies animales conocidas, 1 millón son insectos; solo 5 mil se consideran nocivas.

Producción de carne: Una vaca requiere 8 kg de alimento para producir 1 kg de carne, mientras que los insectos solo necesitan 2 kg para producir 1 kg de carne. Los insectos no necesitan refrigeración pues generan sustancias antibióticas. (Junto a esta comparación aparece un ícono de reciclaje que alude al uso eficiente de los recursos naturales y a la reducción de contaminantes.)

Anatomía de un insecto: Son artrópodos con cuerpo en tres partes (cabeza, tórax y abdomen). La mayor concentración de proteínas se encuentra entre el abdomen y el tórax.

Beneficios para los humanos: Los insectos aportan proteínas de alta calidad (100 g de saltamontes contienen entre 62 % y 75 % de proteínas; 100 g de carne de res, entre 54 % y 57 %). Son fuente de minerales como cobre, magnesio, hierro, zinc y fósforo. Son especialmente valiosos para combatir la desnutrición infantil.

Advertencia sanitaria (Rumpold y Schlüter): El consumo de insectos deberá tener las mismas garantías sanitarias que otros alimentos, pues algunos pueden ser tóxicos o portadores de parásitos.

Fuente: Chumpitazi, M. (2014). Insectos a la carta. Infografías S.O.S., con datos de Archivos FAO.`;

const REFS = ['LC-2022-Q04', 'LC-2022-Q05', 'LC-2022-Q06', 'LC-2022-Q07'];

// Algunas instalaciones tienen filas duplicadas ingeridas directamente desde el
// PDF sin la referencia canónica `LC-2022-QNN`. Cubrimos también esos
// `source_reference` (patrones q4p4..q7p4 / q4p45..q7p45 del PDF de lectura
// crítica 2022) para que también obtengan el pasaje completo.
const REF_LIKE_PATTERNS = [
  '2022/lectura critica/Lectura critica.pdf#q4p4',
  '2022/lectura critica/Lectura critica.pdf#q5p4',
  '2022/lectura critica/Lectura critica.pdf#q6p4',
  '2022/lectura critica/Lectura critica.pdf#q7p4',
  '2022/lectura critica/leectura critica.pdf#q4p45',
  '2022/lectura critica/leectura critica.pdf#q5p45',
  '2022/lectura critica/leectura critica.pdf#q6p45',
  '2022/lectura critica/leectura critica.pdf#q7p45',
];

async function run() {
  const allRefs = [...REFS, ...REF_LIKE_PATTERNS];
  const { data: questions, error: fetchErr } = await supabase
    .from('icfes_questions')
    .select('id, source_reference, reading_passage')
    .in('source_reference', allRefs);

  if (fetchErr) { console.error('Error fetching:', fetchErr.message); process.exit(1); }
  if (!questions?.length) { console.error('No se encontraron preguntas con esas referencias.'); process.exit(1); }

  for (const q of questions) {
    const current = (q.reading_passage || '').trim();
    if (current === FULL_PASSAGE.trim()) {
      console.log(`[SKIP] ${q.source_reference} — ya tiene el texto completo.`);
      continue;
    }
    console.log(`[UPDATE] ${q.source_reference} (id=${q.id})`);
    console.log(`  Antes:   ${current ? current.slice(0, 60) + '...' : '(vacío)'} (${current.length} chars)`);
    console.log(`  Después: ${FULL_PASSAGE.slice(0, 60)}... (${FULL_PASSAGE.length} chars)`);

    if (!DRY_RUN) {
      const { error: updErr } = await supabase
        .from('icfes_questions')
        .update({ reading_passage: FULL_PASSAGE })
        .eq('id', q.id);
      if (updErr) {
        console.error(`  ERROR al actualizar ${q.source_reference}:`, updErr.message);
      } else {
        console.log(`  ✓ Actualizado.`);
      }
    }
  }

  if (DRY_RUN) console.log('\n[DRY-RUN] No se realizaron cambios en la BD.');
  else console.log('\nListo.');
}

run().catch(e => { console.error(e); process.exit(1); });
