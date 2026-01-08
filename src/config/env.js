/**
 * Environment Configuration Loader
 * Loads environment variables before any other module
 * Must be imported first in index.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

// Get current directory in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to .env file (go up TWO levels from src/config/ to root)
const envPath = join(__dirname, '../../.env');
const localEnvPath = join(process.cwd(), '.env');

// Only try to load .env if it exists (Railway uses environment variables directly)
let result = { parsed: {} };

// Try loading from standard path
if (fs.existsSync(envPath)) {
  console.log(`Loading .env from: ${envPath}`);
  result = dotenv.config({ path: envPath });
} 
// Fallback: Try loading from current working directory
else if (fs.existsSync(localEnvPath)) {
  console.log(`Loading .env from: ${localEnvPath}`);
  result = dotenv.config({ path: localEnvPath });
}

if (result.error) {
  console.error('❌ Error loading .env file:', result.error);
} else if (result.parsed) {
  const keys = Object.keys(result.parsed);
  console.log(`✅ Environment variables loaded from .env (${keys.length} keys found)`);
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
} else {
  // In production (Railway), environment variables are set directly
  console.error('ℹ️  No .env file found - using system environment variables (Railway/Production mode)');
}

export default result;
