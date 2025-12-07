/**
 * Environment Configuration Loader
 * Loads environment variables before any other module
 * Must be imported first in index.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get current directory in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables - go up TWO levels from src/config/ to root
const result = dotenv.config({ path: join(__dirname, '../../.env') });

if (result.error) {
  console.error('❌ Error loading .env file:', result.error);
} else {
  // Use stderr instead of stdout (MCP uses stdout for JSON-RPC)
  console.error('✅ Environment variables loaded from .env');
}

export default result;
