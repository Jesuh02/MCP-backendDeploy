#!/usr/bin/env node
/**
 * fix_tolstoi_reading_passage.mjs
 *
 * Actualiza reading_passage de las preguntas LC-2022-Q01, Q02, Q03
 * ("El origen del mal" — León Tolstoi) para incluir título, texto completo
 * con los cinco personajes y línea de atribución.
 *
 * Uso:
 *   node scripts/fix_tolstoi_reading_passage.mjs --dry-run
 *   node scripts/fix_tolstoi_reading_passage.mjs
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

// Texto completo con título y atribución
const FULL_PASSAGE = `TEXTO: «El origen del mal» — León Tolstoi

En un bosque vivía un ermitaño que entendía el lenguaje de las fieras y hasta podía conversar con ellas. En una ocasión en que descansaba debajo de un árbol, se cobijaron allí un cuervo, un palomo, un ciervo y una serpiente, y empezaron a discutir sobre el origen del mal.

—El mal procede del hambre —declaró el cuervo—. Cuando uno come hasta hartarse las cosas se le antojan color rosa. Pero, amigos, si durante días no se prueba bocado, cambia la situación y ya no parece tan hermosa la naturaleza. ¡Qué desasosiego! ¡Qué intranquilidad siente uno! Y si vislumbro un buen pedazo de carne, me abalanzo sobre él, ciegamente. Ni palos ni piedras, ni lobos enfurecidos serían capaces de hacerme soltar la presa. ¡Cuántos perecemos víctimas del hambre! No cabe duda de que es el origen del mal.

El palomo intervino. —El mal no proviene del hambre, sino del amor. Si viviéramos solos, sin hembras, sobrellevaríamos las penas. Más ¡ay!, vivimos en pareja y amamos tanto a nuestra compañera que no hallamos un minuto de sosiego, siempre pensando en ella. Y cuando se aleja un poco de nuestro lado, nos sentimos como perdidos y nos tortura la idea de que un gavilán la haya despedazado. Empezamos a buscarla por doquier, con loco afán. Y si desaparece, uno no come ni bebe; no hace más que buscarla y llorar. ¡Cuántos mueren así entre nosotros! Ya ven que todo el mal proviene del amor.

—No; el mal no viene ni del hambre ni del amor —arguyó la serpiente—. El mal viene de la ira. Si viviésemos tranquilos entonces todo iría bien. Pero, cuando algo se arregla de modo distinto a como quisiéramos, todo nos ofusca. Solo pensamos en descargar nuestra ira en el primero que encontramos. Entonces, como locos, nos retorcemos tratando de morder a alguien. En tales momentos no se tiene piedad de nadie; mordería uno a su propia madre; podríamos comernos a nosotros mismos. Sin duda alguna, todo el mal viene de la ira.

El ciervo no fue de este parecer. —No, no es de la ira ni del amor ni del hambre de donde procede el mal, sino del miedo. Si fuera posible no sentir miedo, todo marcharía bien. Podemos defendernos de un animal pequeño, con nuestros cuernos, y la huida nos preserva de los grandes. Pero es imposible no sentir miedo. Apenas cruje una rama en el bosque o se mueve una hoja, temblamos de terror. El corazón palpita, como si fuera a salirse del pecho, y echamos a correr. Siempre estamos alerta, llenos de terror. No hay modo de disfrutar de un poco de tranquilidad. Por eso el origen del mal está en el miedo.

Finalmente, intervino el ermitaño: —No es el hambre, el amor, la ira ni el miedo, la fuente de nuestros males, sino nuestra propia naturaleza. Ella es la que engendra el hambre, el amor, la ira y el miedo.

Tomado y adaptado de: Tolstoi, L. (s. f.). El origen del mal.`;

const REFS = ['LC-2022-Q01', 'LC-2022-Q02', 'LC-2022-Q03'];

async function run() {
  const { data: questions, error: fetchErr } = await supabase
    .from('icfes_questions')
    .select('id, source_reference, reading_passage')
    .in('source_reference', REFS);

  if (fetchErr) { console.error('Error fetching:', fetchErr.message); process.exit(1); }
  if (!questions?.length) { console.error('No se encontraron preguntas con esas referencias.'); process.exit(1); }

  for (const q of questions) {
    const current = (q.reading_passage || '').trim();
    if (current === FULL_PASSAGE.trim()) {
      console.log(`[SKIP] ${q.source_reference} — ya tiene el texto completo.`);
      continue;
    }
    console.log(`[UPDATE] ${q.source_reference} (id=${q.id})`);
    console.log(`  Antes: ${current.slice(0, 60)}... (${current.length} chars)`);
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
