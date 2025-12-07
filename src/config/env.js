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

// Only try to load .env if it exists (Railway uses environment variables directly)
let result = { parsed: {} };
if (fs.existsSync(envPath)) {
  result = dotenv.config({ path: envPath });
  if (result.error) {
    console.error('❌ Error loading .env file:', result.error);
  } else {
    console.error('✅ Environment variables loaded from .env');
  }
} else {
  // In production (Railway), environment variables are set directly
  console.error('ℹ️  No .env file found - using system environment variables (Railway/Production mode)');
}

export default result;
