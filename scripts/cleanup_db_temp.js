import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load env vars
const __dirname = path.dirname(fileURLToPath(
    import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Use Service Key for Admin rights

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing Supabase credentials in .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function cleanup() {
    console.log('🧹 Starting Database Cleanup & Hardening...');

    // 1. Check for Nulls
    const { count: nullEmbeds, error: e1 } = await supabase
        .from('questions_history')
        .select('*', { count: 'exact', head: true })
        .is('question_embedding', null);

    const { count: nullHashes, error: e2 } = await supabase
        .from('questions_history')
        .select('*', { count: 'exact', head: true })
        .is('question_hash', null);

    const { count: nullOptions, error: e3 } = await supabase
        .from('question_options')
        .select('*', { count: 'exact', head: true })
        .is('option_embedding', null);

    console.log(`📊 Current Status:`);
    console.log(`   - Null Question Embeddings: ${nullEmbeds || 0}`);
    console.log(`   - Null Question Hashes: ${nullHashes || 0}`);
    console.log(`   - Null Option Embeddings: ${nullOptions || 0}`);

    if ((nullEmbeds === 0 && nullHashes === 0 && nullOptions === 0)) {
        console.log('✅ No corrupt data found. The database is clean.');
    } else {
        console.log('🚧 Deleting corrupt records...');

        // Delete Options first
        if (nullOptions > 0) {
            const { error: delOptError } = await supabase
                .from('question_options')
                .delete()
                .is('option_embedding', null);
            if (delOptError) console.error('Error deleting options:', delOptError);
            else console.log('   ✅ Deleted corrupt options');
        }

        // Delete Questions (Options will cascade delete if FK is set, assuming they are linked, but we delete explicitly above just in case)
        if (nullEmbeds > 0 || nullHashes > 0) {
            const { error: delQError } = await supabase
                .from('questions_history')
                .delete()
                .or('question_embedding.is.null,question_hash.is.null');

            if (delQError) console.error('Error deleting questions:', delQError);
            else console.log('   ✅ Deleted corrupt questions');
        }
    }

    // 2. Try to Apply Constraints via RPC (if function exists) or raw SQL
    // Since we can't easily run DDL via JS client without a specific RPC function like 'exec_sql',
    // We will try a common pattern if the user has enabled the extension.
    // If not, we will just warn the user to run the .sql file.

    console.log('🔒 Attempting to apply NOT NULL constraints...');

    // Check if we can run raw SQL
    try {
        const { error: rpcError } = await supabase.rpc('execute_sql', {
            sql_query: `
                ALTER TABLE public.questions_history ALTER COLUMN question_embedding SET NOT NULL;
                ALTER TABLE public.questions_history ALTER COLUMN question_hash SET NOT NULL;
                ALTER TABLE public.question_options ALTER COLUMN option_embedding SET NOT NULL;
            `
        });

        if (rpcError) {
            console.warn('⚠️ Could not apply constraints via RPC (expected if execute_sql function is missing).');
            console.warn('👉 PLEASE RUN scripts/enforce_strict_constraints.sql MANUALLY in Supabase SQL Editor.');
        } else {
            console.log('✅ Constraints applied successfully! Future NULLs will be rejected by the Database.');
        }
    } catch (e) {
        console.warn('⚠️ RPC call failed.');
    }
}

cleanup();