#!/usr/bin/env node
/**
 * fix_lc2022_follower_passages.mjs
 *
 * Fixes follower questions that still have a [placeholder] stem and no
 * reading_passage, by copying the passage from the group leader's
 * reading_passage column and cleaning the stem.
 *
 * This handles the case where icfes_fill_lc2022_reading_passages.mjs was
 * run after the leader was already cleaned (stem no longer contains the
 * full passage), so followers were skipped.
 *
 * Env vars (same as fill script):
 *   DATABASE_URL   OR   SUPABASE_URL + SUPABASE_SERVICE_KEY
 *
 * Flags:
 *   --dry-run   Print changes without writing.
 *
 * Usage:
 *   node scripts/fix_lc2022_follower_passages.mjs --dry-run
 *   node scripts/fix_lc2022_follower_passages.mjs
 */

import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const { Pool } = pg;

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

const DATABASE_URL         = process.env.DATABASE_URL;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const USE_SUPABASE         = !DATABASE_URL && !!SUPABASE_URL && !!SUPABASE_SERVICE_KEY;

if (!DATABASE_URL && !USE_SUPABASE) {
  console.error('ERROR: Define DATABASE_URL, o bien SUPABASE_URL + SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

function inferSsl(url) {
  if (/sslmode=disable/i.test(url)) return false;
  if (/\b(supabase\.co|supabase\.net|neon\.tech|railway\.app|rds\.amazonaws\.com)\b/i.test(url))
    return { rejectUnauthorized: false };
  return false;
}

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: inferSsl(DATABASE_URL) })
  : null;

const supabase = USE_SUPABASE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

// Each group: leader reference → follower references (excluding leader itself)
const GROUPS = [
  { leader: 'LC-2022-Q01', followers: ['LC-2022-Q02', 'LC-2022-Q03'] },
  { leader: 'LC-2022-Q04', followers: ['LC-2022-Q05', 'LC-2022-Q06', 'LC-2022-Q07'] },
  { leader: 'LC-2022-Q08', followers: ['LC-2022-Q09', 'LC-2022-Q10', 'LC-2022-Q11'] },
  { leader: 'LC-2022-Q12', followers: ['LC-2022-Q13', 'LC-2022-Q14', 'LC-2022-Q15', 'LC-2022-Q16'] },
  { leader: 'LC-2022-Q17', followers: ['LC-2022-Q18', 'LC-2022-Q19', 'LC-2022-Q20'] },
];

/**
 * Removes the "TEXTO: «…»" header line and the [placeholder] line from the
 * follower's stem, leaving only the actual question text.
 *
 * Format:  "HEADER\n\n[placeholder or excerpt]\n\nQUESTION TEXT"
 * Result:  "QUESTION TEXT"
 */
function cleanFollowerStem(stem) {
  const parts = stem.replace(/\r\n/g, '\n').split('\n\n');
  if (parts.length < 3) {
    // Already cleaned or unexpected format — return as-is
    return stem.trim();
  }
  const secondPara = (parts[1] || '').trim();
  // Pure placeholder: starts and ends with brackets
  const isPurePlaceholder = /^\[[\s\S]*\]$/.test(secondPara);

  if (isPurePlaceholder) {
    // Drop header (parts[0]) + placeholder (parts[1]), keep the rest
    return parts.slice(2).join('\n\n').trim();
  } else {
    // Drop only the header (parts[0]), keep everything else
    return parts.slice(1).join('\n\n').trim();
  }
}

async function fetchQuestions(refs) {
  if (pool) {
    const client = pool;
    const { rows } = await client.query(
      `SELECT id, source_reference, stem, reading_passage
         FROM public.icfes_questions
        WHERE source_reference = ANY($1)`,
      [refs],
    );
    return rows;
  }
  const { data, error } = await supabase
    .from('icfes_questions')
    .select('id, source_reference, stem, reading_passage')
    .in('source_reference', refs);
  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  return data || [];
}

async function updateQuestion(client, id, newStem, passage) {
  if (pool) {
    await client.query(
      `UPDATE public.icfes_questions
          SET stem            = $1,
              reading_passage = $2,
              updated_at      = now()
        WHERE id = $3`,
      [newStem, passage, id],
    );
    return;
  }
  const { error } = await supabase
    .from('icfes_questions')
    .update({ stem: newStem, reading_passage: passage, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
}

async function run() {
  const client = pool ? await pool.connect() : null;
  let totalUpdated = 0;

  try {
    if (client) await client.query('BEGIN');

    for (const group of GROUPS) {
      const allRefs   = [group.leader, ...group.followers];
      const rows      = await fetchQuestions(allRefs);
      const byRef     = new Map(rows.map(r => [r.source_reference, r]));

      const leaderRow = byRef.get(group.leader);
      if (!leaderRow) {
        console.warn(`⚠️  Leader ${group.leader} not found — skipping group.`);
        continue;
      }

      // The passage to propagate: prefer reading_passage already set on leader,
      // fallback to extracting from stem (if leader was not cleaned yet).
      let passage = leaderRow.reading_passage;

      if (!passage) {
        // Leader not yet processed: extract from stem
        const parts = leaderRow.stem.replace(/\r\n/g, '\n').split('\n\n');
        passage = parts.slice(1, -1).join('\n\n').trim();
        if (!passage || passage.length < 20) {
          console.warn(`⚠️  ${group.leader}: cannot extract passage (${passage?.length ?? 0} chars) — skipping group.`);
          continue;
        }
        console.log(`\n📖  Group ${group.leader}: passage extracted from stem (${passage.length} chars)`);

        // Also update the leader itself
        const leaderCleanStem = leaderRow.stem.replace(/\r\n/g, '\n').split('\n\n').slice(-1)[0].trim();
        if (!DRY_RUN) {
          await updateQuestion(client, leaderRow.id, leaderCleanStem, passage);
          totalUpdated++;
          console.log(`    ✅ ${group.leader} (leader) — stem cleaned, passage set.`);
        } else {
          console.log(`    [DRY-RUN] ${group.leader} (leader) — would set passage + clean stem.`);
        }
      } else {
        console.log(`\n📖  Group ${group.leader}: passage from DB reading_passage (${passage.length} chars)`);
      }

      // Process each follower
      for (const ref of group.followers) {
        const row = byRef.get(ref);
        if (!row) {
          console.warn(`    ⚠️  ${ref} not found — skip.`);
          continue;
        }

        const alreadyHasPassage = !!row.reading_passage;
        const stemHasPlaceholder = /^\[[\s\S]*\]/.test((row.stem.split('\n\n')[1] || '').trim());
        const stemHasHeader = row.stem.startsWith('TEXTO:');

        if (alreadyHasPassage && !stemHasHeader && !stemHasPlaceholder) {
          console.log(`    ✅ ${ref} already clean — skip.`);
          continue;
        }

        const newStem = (stemHasHeader || stemHasPlaceholder)
          ? cleanFollowerStem(row.stem)
          : row.stem;

        if (DRY_RUN) {
          console.log(`    [DRY-RUN] ${ref}`);
          console.log(`      stem → "${newStem.slice(0, 100).replace(/\n/g, '↵')}"`);
          console.log(`      passage set: ${passage.length} chars`);
          continue;
        }

        await updateQuestion(client, row.id, newStem, passage);
        totalUpdated++;
        console.log(`    ✅ ${ref} — passage set, stem cleaned.`);
      }
    }

    if (DRY_RUN) {
      if (client) await client.query('ROLLBACK');
      console.log('\n🔍  Dry-run complete. No changes committed.');
    } else {
      if (client) await client.query('COMMIT');
      console.log(`\n✅  Done. ${totalUpdated} questions updated.`);
    }
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('❌  Error:', err.message);
    throw err;
  } finally {
    if (client) client.release();
    if (pool) await pool.end();
  }
}

run().catch(() => process.exit(1));
