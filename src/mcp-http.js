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
const PORT = process.env.MCP_HTTP_PORT || 3000;

// Middleware
app.use(express.json());
app.use((req, res, next) => {
    console.log(`📨 ${req.method} ${req.path}`);
    // Enable CORS for Android emulator
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Configure Routes (Excel, Notifications, LLM)
configureRoutes(app);

// Initialize services
const supabase = SupabaseService.getInstance();
let mcpService;
try {
    mcpService = new MCPService();
} catch (error) {
    console.error('❌ Failed to initialize MCPService:', error);
}

/**
 * Health check endpoint
 */
app.get('/health', async(req, res) => {
    try {
        const dbHealth = await supabase.healthCheck();

        // Test LLM connection
        let llmHealth = { status: 'not_tested' };
        try {
            if (mcpService && mcpService.llmService) {
                llmHealth = await mcpService.llmService.testConnection();
            }
        } catch (e) {
            llmHealth = { status: 'error', error: e.message };
        }

        res.json({
            status: 'ok',
            server: 'YisusCompany by YisusFactory MCP Server',
            version: '1.0.0',
            timestamp: new Date().toISOString(),
            services: {
                database: dbHealth,
                llm: llmHealth
            }
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * MCP initialize endpoint and Tools endpoints are now handled via mcpRoutes in index.js
 */

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
    } catch (error) {
        console.error('❌ Failed to connect to Supabase:', error);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});