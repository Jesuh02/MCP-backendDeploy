/**
 * MCP Server - HTTP Mode
 * For Android app integration via HTTP
 * Uses JSON-RPC over HTTP (port 3000)
 */

import './config/env.js';
import express from 'express';
import os from 'os';
import { MCPService } from './domain/services/MCPService.js';
import { SupabaseService } from './infrastructure/database/SupabaseService.js';
import { configureRoutes } from './interfaces/routes/index.js';

const app = express();
// Railway uses PORT, fallback to MCP_HTTP_PORT for local development
const PORT = process.env.PORT || process.env.MCP_HTTP_PORT || 3000;

// Middleware
app.use(express.json());
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    const clientIp = req.ip || req.connection.remoteAddress;
    console.log(`📨 [${timestamp}] ${req.method} ${req.path} from ${clientIp}`);
    // Enable CORS for Android emulator
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ============================================================
// 🏥 CRITICAL: Health check endpoint MUST be defined FIRST
// This ensures Railway can verify the container is healthy
// even before services are initialized
// ============================================================
app.get('/health', (req, res) => {
    console.log('🏥 Health check requested from:', req.ip);
    res.status(200).json({
        status: 'ok',
        server: 'YisusCompany by YisusFactory MCP Server',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
    console.log('✅ Health check response sent (200 OK)');
});

// Initialize services AFTER health check endpoint
const supabase = SupabaseService.getInstance();
let mcpService;
try {
    mcpService = new MCPService();
} catch (error) {
    console.error('❌ Failed to initialize MCPService:', error);
}

// Configure Routes (Excel, Notifications, LLM, MCP)
configureRoutes(app);

// Compatibility route: accept legacy client POSTs to /procesar-prompt
app.post('/procesar-prompt', async (req, res) => {
    console.log('📨 Legacy POST /procesar-prompt received (compat route)');
    try {
        const body = req.body || {};
        const prompt = body.prompt || body.query || body.text || '';

        if (!prompt) {
            return res.status(400).json({ error: 'Missing prompt in request body' });
        }

        if (!mcpService) {
            return res.status(500).json({ error: 'MCPService not initialized' });
        }

        // Delegate to MCPService.processQuery which returns structured result
        const result = await mcpService.processQuery(prompt, { reason: 'legacy_procesar_prompt' });

        return res.json({ success: true, result });
    } catch (err) {
        console.error('❌ Error handling /procesar-prompt:', err);
        return res.status(500).json({ error: err.message || String(err) });
    }
});

/**
 * Start server
 */
async function main() {
    console.log('🚀 YisusCompany by YisusFactory MCP Server starting in HTTP mode...');
    console.log('📊 Connecting to Supabase...');

    try {
        await supabase.testConnection();
        console.log('✅ Supabase connected');

        // Helper to get local IP
        const getLocalIp = () => {
            const interfaces = os.networkInterfaces();
            for (const name of Object.keys(interfaces)) {
                for (const iface of interfaces[name]) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        return iface.address;
                    }
                }
            }
            return 'localhost';
        };

        const server = app.listen(PORT, '0.0.0.0', () => {
            const localIp = getLocalIp();
            console.log(`✅ MCP HTTP Server listening on http://0.0.0.0:${PORT}`);
            console.log(`📱 Android Emulator URL: http://10.0.2.2:${PORT}`);
            console.log(`💻 Local URL: http://localhost:${PORT}`);
            console.log(`🔌 Physical Device URL: http://${localIp}:${PORT} (Use this for physical devices)`);
        });

        // Set server timeout to 5 minutes (300000 ms) to handle long LLM/Excel generation
        server.setTimeout(300000);

        // Prevent server from shutting down unexpectedly
        process.on('SIGTERM', () => {
            console.log('⚠️ SIGTERM received, shutting down gracefully...');
            server.close(() => {
                console.log('✅ Server closed gracefully');
                process.exit(0);
            });
        });

        process.on('SIGINT', () => {
            console.log('⚠️ SIGINT received, shutting down gracefully...');
            server.close(() => {
                console.log('✅ Server closed gracefully');
                process.exit(0);
            });
        });

        // Keep the process alive
        process.on('uncaughtException', (error) => {
            console.error('❌ Uncaught Exception:', error);
            // Don't exit - log and continue
        });

        process.on('unhandledRejection', (reason, promise) => {
            console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
            // Don't exit - log and continue
        });

    } catch (error) {
        console.error('❌ Failed to connect to Supabase:', error);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});