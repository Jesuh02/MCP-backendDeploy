#!/usr/bin/env node
/**
 * fix_ing_reading_passages.mjs
 *
 * Patches ING (English) questions in the database that are missing their
 * reading_passage field.  The original PDF ingest extracted individual
 * questions but did not capture the shared reading text for grouped items.
 *
 * Passage text is taken directly from the original ICFES PDFs:
 *   • "My Love of Traveling"  — Inglés2010.pdf  (2016 folder, 2010 exam)
 *   • "Smiling Often"         — Guia-Ingles-11-1.pdf (2020) & Ingle.pdf (2021)
 *
 * Env vars:
 *   SUPABASE_URL + SUPABASE_SERVICE_KEY   (or SUPABASE_KEY)
 *
 * Flags:
 *   --dry-run   Print what would change without writing.
 *   --force     Re-apply even if reading_passage is already set.
 *
 * Usage:
 *   node scripts/fix_ing_reading_passages.mjs --dry-run
 *   node scripts/fix_ing_reading_passages.mjs
 */

import { createClient } from '@supabase/supabase-js';

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE   = args.includes('--force');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Define SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// ─── Known reading passages ───────────────────────────────────────────────────

const RP_MY_LOVE_OF_TRAVELING = `MY LOVE OF TRAVELING

My Love of Traveling by Sam Harris

I grew up in Australia and was introduced to traveling at an early age. We moved around a lot because of my father's work. My main hobby was radios - I repaired old sets and listened to various programs from around the world. I had a map of the world on my bedroom wall with pins on it and I wrote postcards to foreign radio stations. I was an only child and I didn't have many friends; instead I tried to contact the outside world. We didn't have a television, so what I learned came from the radio and from encyclopedias. By the age of 13, I could draw maps of countries from memory and name all the capital cities.

I didn't actually leave Australia until I was twenty-five, when I went on a long trip through Asia. I arrived in Thailand thinking I was well prepared, but in fact, I knew little about its rich culture. Then I went to India, where my taste for adventure and different experiences grew. Every city there was different; there were cows on the streets, old cars, interesting food, and people everywhere.

I went from country to country without realizing how dangerous some of them were at that time. There was very little advice available. But now it's different - you can learn so much from the internet and just about everywhere you go, you'll find an internet café. It's really changed the way people travel.

The things I now like most about a trip are eating and shopping. I also love sitting on trains and talking to different people. I'm sure I'll never get bored with traveling, even though I've explored most countries in the world.`;

const RP_SMILING_OFTEN = `SMILING OFTEN

Smiling often has many benefits. People who smile regularly can experience an increase in their health and state of mind. Unfortunately, many people don't smile enough. It's a good idea to smile more often in order to feel better. Here are some reasons to smile more often. Smiling brings health benefits. It increases natural substances in the body which improve your state of mind. Besides, smiling helps your facial structure give you a more youthful look; combined with healthy teeth, smiling can make you seem healthier and more attractive. Smiling also has positive effects on the immune and cardiovascular systems. There are psychological benefits to smiling frequently, too. It makes you happy almost immediately. Sometimes when we can't smile, we find that anyone's smile helps us feel better. Smiling can also reduce stress levels since the body reacts quickly to it. A great way to make someone cheerful is to help them smile. Smiling more often can also make you look more attractive and confident. In general, people like to show happiness and be near those who are happy. Smiling in the presence of others shows you are a happy person, and you can transmit the feeling to them. People are naturally attracted to smiling; therefore, smiling frequently can help you get the attention you want from others. If you don't smile much, find ways to smile more often; try to make others smile more often too. Smiling is a fast way to feel happy. Feeling happy and making others feel happy is very positive and will bring many benefits. Although it seems difficult, it is in fact very easy; all it takes is moving some muscles and you will be happy almost immediately.`;

// ─── Groups: which source_reference prefixes map to which passage ─────────────

const GROUPS = [
  {
    label: 'My Love of Traveling (2010 exam, 2016 folder)',
    passage: RP_MY_LOVE_OF_TRAVELING,
    // Questions q31–q35 on page 9
    refs: [
      '2016/ingles/Inglés2010.pdf#q31p9',
      '2016/ingles/Inglés2010.pdf#q32p9',
      '2016/ingles/Inglés2010.pdf#q33p9',
      '2016/ingles/Inglés2010.pdf#q34p9',
      '2016/ingles/Inglés2010.pdf#q35p9',
    ],
  },
  {
    label: 'Smiling Often (2020 guide)',
    passage: RP_SMILING_OFTEN,
    refs: [
      '2020/ingles/Guia-Ingles-11-1.pdf#q15p51',
      '2020/ingles/Guia-Ingles-11-1.pdf#q16p51',
      '2020/ingles/Guia-Ingles-11-1.pdf#q17p51',
      '2020/ingles/Guia-Ingles-11-1.pdf#q18p51',
      '2020/ingles/Guia-Ingles-11-1.pdf#q19p51',
    ],
  },
  {
    label: 'Smiling Often (2021 exam)',
    passage: RP_SMILING_OFTEN,
    refs: [
      '2021/ingles/Ingle.pdf#q15p48',
      '2021/ingles/Ingle.pdf#q16p48',
      '2021/ingles/Ingle.pdf#q17p48',
      '2021/ingles/Ingle.pdf#q18p48',
      '2021/ingles/Ingle.pdf#q19p48',
    ],
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

let totalUpdated = 0;
let totalSkipped = 0;

for (const group of GROUPS) {
  console.log(`\n📖  ${group.label}`);

  const { data: rows, error } = await sb
    .from('icfes_questions')
    .select('id, stem, reading_passage, source_reference')
    .in('source_reference', group.refs);

  if (error) {
    console.error(`   ERROR fetching: ${error.message}`);
    continue;
  }

  if (!rows || rows.length === 0) {
    console.log('   (no questions found for this group)');
    continue;
  }

  for (const row of rows) {
    if (row.reading_passage && !FORCE) {
      console.log(`   ✅  [${row.source_reference}] already set — skip.`);
      totalSkipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`   [DRY-RUN] would set reading_passage for [${row.source_reference}]`);
      console.log(`            stem: "${(row.stem || '').slice(0, 80).replace(/\n/g, '↵')}"`);
      totalUpdated++;
      continue;
    }

    const { error: updateErr } = await sb
      .from('icfes_questions')
      .update({ reading_passage: group.passage, updated_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updateErr) {
      console.error(`   ❌  [${row.source_reference}] update failed: ${updateErr.message}`);
    } else {
      console.log(`   ✅  [${row.source_reference}] reading_passage set.`);
      totalUpdated++;
    }
  }
}

if (DRY_RUN) {
  console.log(`\n🔍  Dry-run complete. Would update ${totalUpdated} questions. (${totalSkipped} already set)`);
} else {
  console.log(`\n✅  Done. ${totalUpdated} updated, ${totalSkipped} skipped.`);
}

