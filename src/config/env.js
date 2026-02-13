/**
 * Environment Configuration Loader
 * Loads environment variables before any other module.
 * Must be imported first in index.js.
 *
 * Supports multi-environment setups:
 *   NODE_ENV=qa          → loads .env.qa   (if present)
 *   NODE_ENV=production  → loads .env.production (if present)
 *   Otherwise            → loads .env
 *
 * On Railway, environment variables are injected directly — no .env file needed.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

// Get current directory in ES Modules
const __filename = fileURLToPath(
    import.meta.url);
const __dirname = dirname(__filename);

// Root of the project (two levels up from src/config/)
const projectRoot = join(__dirname, '../..');
const cwd = process.cwd();

// Determine which .env file to load based on NODE_ENV
const nodeEnv = process.env.NODE_ENV || 'development';
const envSuffix = (nodeEnv === 'production' || nodeEnv === 'qa') ? `.${nodeEnv}` : '';

// Candidate paths in priority order
const candidates = [
    envSuffix ? join(projectRoot, `.env${envSuffix}`) : null,
    envSuffix ? join(cwd, `.env${envSuffix}`) : null,
    join(projectRoot, '.env'),
    join(cwd, '.env'),
].filter(Boolean);

let result = { parsed: {} };
let loadedPath = null;

for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
        console.log(`Loading .env from: ${candidate}`);
        result = dotenv.config({ path: candidate });
        loadedPath = candidate;
        break;
    }
}

if (result.error) {
    console.error('❌ Error loading .env file:', result.error);
} else if (result.parsed) {
    const keys = Object.keys(result.parsed);
    console.log(`✅ Environment variables loaded from ${loadedPath} (${keys.length} keys found)`);
    console.log(`📌 APP_ENVIRONMENT: ${process.env.APP_ENVIRONMENT || nodeEnv}`);
    // Log specific critical keys presence (without values)
    const criticalKeys = [
        'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
        'PAYU_API_KEY', 'PAYU_PUBLIC_KEY', 'PAYU_INTEGRITY_SECRET', 'PAYU_EVENT_SECRET'
    ];
    const missingKeys = criticalKeys.filter(k => !keys.includes(k));
    if (missingKeys.length > 0) {
        console.warn(`⚠️ Missing critical keys in .env: ${missingKeys.join(', ')}`);
    } else {
        console.log('✅ All critical R2 keys present in .env');
    }

    // Log WhatsApp integration keys presence
    const whatsappKeys = ['WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_APP_SECRET'];
    const presentWA = whatsappKeys.filter(k => keys.includes(k) || process.env[k]);
    if (presentWA.length > 0) {
        console.log(`📱 WhatsApp keys present: ${presentWA.length}/${whatsappKeys.length}`);
    }
} else {
    // In production (Railway), environment variables are set directly
    console.log('ℹ️  No .env file found — using system environment variables (Railway mode)');
    console.log(`📌 APP_ENVIRONMENT: ${process.env.APP_ENVIRONMENT || nodeEnv}`);
}

export default result;