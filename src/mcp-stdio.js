/**
 * MCP Server - STDIO Mode
 * For VS Code MCP Extension integration
 * Uses JSON-RPC over stdin/stdout (no HTTP server)
 */

import './config/env.js';
import { MCPService } from './domain/services/MCPService.js';
import { SupabaseService } from './infrastructure/database/SupabaseService.js';

// CRITICAL: Redirect ALL stdout to stderr before any other imports
// MCP protocol requires ONLY JSON-RPC messages on stdout
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => {
    // Check if it's a JSON-RPC message (starts with {"jsonrpc")
    const str = chunk.toString();
    if (str.trim().startsWith('{"jsonrpc')) {
        // This is a valid MCP message, write to stdout
        return originalStdoutWrite(chunk, encoding, callback);
    } else {
        // This is a log message, redirect to stderr
        return process.stderr.write(chunk, encoding, callback);
    }
};

// Disable console.log to avoid polluting stdout (MCP uses stdout for JSON-RPC)
console.log = (...args) => console.error('[LOG]', ...args);
console.info = (...args) => console.error('[INFO]', ...args);
console.warn = (...args) => console.error('[WARN]', ...args);

// Initialize services
const supabase = SupabaseService.getInstance();
const mcpService = new MCPService();

/**
 * Send JSON-RPC response to stdout
 */
function sendResponse(id, result = null, error = null) {
    const response = {
        jsonrpc: '2.0',
        id,
        ...(error ? { error } : { result })
    };

    console.error('[MCP] Sending response:', JSON.stringify(response).substring(0, 100));

    // Write to stdout (this is the only valid output for MCP)
    originalStdoutWrite(JSON.stringify(response) + '\n');
}

/**
 * Send JSON-RPC notification to stdout
 */
function sendNotification(method, params = {}) {
    const notification = {
        jsonrpc: '2.0',
        method,
        params
    };

    process.stdout.write(JSON.stringify(notification) + '\n');
}

/**
 * Handle MCP initialize request
 */
async function handleInitialize(id, params) {
    console.error('🔧 MCP Initialize request received');

    try {
        // Test Supabase connection
        await supabase.testConnection();
        console.error('✅ Supabase connected');

        sendResponse(id, {
            protocolVersion: '2024-11-05',
            capabilities: {
                tools: {
                    listChanged: true
                },
                resources: {
                    subscribe: true,
                    listChanged: true
                }
            },
            serverInfo: {
                name: 'tareamov-mcp-server',
                version: '1.0.0'
            }
        });
    } catch (error) {
        console.error('❌ Initialize error:', error);
        sendResponse(id, null, {
            code: -32603,
            message: 'Internal error during initialization',
            data: error.message
        });
    }
}

/**
 * Handle tools/list request
 */
async function handleToolsList(id) {
    console.error('🔧 Tools list request received');

    sendResponse(id, {
        tools: [{
                name: 'query_database',
                description: `Execute queries on the TareaMov Supabase database. Returns real-time data.

**CAPABILITIES:**
- Execute RAW PostgreSQL/SQL queries directly (SELECT, INSERT, UPDATE, DELETE)
- Process natural language queries that are auto-converted to SQL
- Full access to all Supabase tables and relationships
- Supports subqueries and simple JOINs if 'execute_sql' RPC is available.

**HOW TO USE:**
1. **Direct SQL**: Pass valid PostgreSQL syntax directly
   Example: "SELECT id, usuario, email FROM usuarios LIMIT 10"

2. **Natural Language**: Use Spanish or English, system converts to SQL
   Example: "dame todos los usuarios"

**BEST PRACTICES:**
- Always select 'id', 'usuario', 'email' for user queries.
- To check content creation (users who posted content):
  - Courses: match 'courses.creator_user_id' with 'usuarios.id'
  - Tasks: match 'task_submissions.student_username' with 'usuarios.usuario'
- For "users without content" (usuarios sin contenido), you MUST check BOTH tables:
  SELECT id, usuario FROM usuarios 
  WHERE id NOT IN (SELECT creator_user_id FROM courses) 
  AND usuario NOT IN (SELECT student_username FROM task_submissions)
- Use WHERE clauses for filtering
- Use ORDER BY and LIMIT for top/bottom results

**AVAILABLE TABLES:**
usuarios, personas, courses, videos, topics, content_items, tasks, task_submissions, subscriptions, chat_messages, file_contexts, roles, recursos, rol_recursos, progreso_estudiante, knowledge_base`,
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'SQL query (preferred) or natural language query. For complex analytics, use raw SQL with JOINs and aggregations.'
                        }
                    },
                    required: ['query']
                }
            },
            {
                name: 'get_database_schema',
                description: 'Get the complete database schema with all tables and columns',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            }
        ]
    });
}

/**
 * Handle resources/list request
 */
async function handleResourcesList(id) {
    console.error('🔧 Resources list request received');

    try {
        const tables = await supabase.getTables();

        const resources = tables.map(table => ({
            uri: `supabase://tareamov/${table}`,
            name: `Table: ${table}`,
            mimeType: 'application/json',
            description: `Access data from ${table} table`
        }));

        sendResponse(id, { resources });
    } catch (error) {
        console.error('❌ Resources list error:', error);
        sendResponse(id, null, {
            code: -32603,
            message: 'Failed to list resources',
            data: error.message
        });
    }
}

/**
 * Handle tools/call request
 */
async function handleToolsCall(id, params) {
    console.error('🔧 Tool call request:', params.name);

    try {
        const { name, arguments: args } = params;

        if (name === 'query_database') {
            const result = await mcpService.processQuery(args.query);
            sendResponse(id, {
                content: [{
                    type: 'text',
                    text: JSON.stringify(result, null, 2)
                }]
            });
        } else if (name === 'get_database_schema') {
            const schema = await mcpService.getDatabaseSchema();
            sendResponse(id, {
                content: [{
                    type: 'text',
                    text: JSON.stringify(schema, null, 2)
                }]
            });
        } else {
            sendResponse(id, null, {
                code: -32601,
                message: `Tool not found: ${name}`
            });
        }
    } catch (error) {
        console.error('❌ Tool call error:', error);
        sendResponse(id, null, {
            code: -32603,
            message: 'Tool execution failed',
            data: error.message
        });
    }
}

/**
 * Handle resources/read request
 */
async function handleResourcesRead(id, params) {
    console.error('🔧 Resource read request:', params.uri);

    try {
        const match = params.uri.match(/^supabase:\/\/tareamov\/(.+)$/);
        if (!match) {
            throw new Error('Invalid resource URI');
        }

        const tableName = match[1];
        const result = await supabase.executeRawSql(`SELECT * FROM ${tableName} LIMIT 100`);

        sendResponse(id, {
            contents: [{
                uri: params.uri,
                mimeType: 'application/json',
                text: JSON.stringify(result, null, 2)
            }]
        });
    } catch (error) {
        console.error('❌ Resource read error:', error);
        sendResponse(id, null, {
            code: -32603,
            message: 'Failed to read resource',
            data: error.message
        });
    }
}

/**
 * Process incoming JSON-RPC request
 */
async function handleRequest(request) {
    const { id, method, params } = request;

    console.error(`📨 Received: ${method}`);

    switch (method) {
        case 'initialize':
            await handleInitialize(id, params);
            break;

        case 'tools/list':
            await handleToolsList(id);
            break;

        case 'tools/call':
            await handleToolsCall(id, params);
            break;

        case 'resources/list':
            await handleResourcesList(id);
            break;

        case 'resources/read':
            await handleResourcesRead(id, params);
            break;

        default:
            sendResponse(id, null, {
                code: -32601,
                message: `Method not found: ${method}`
            });
    }
}

/**
 * Main: Read from stdin and process JSON-RPC requests
 */
async function main() {
    console.error('🚀 TareaMov MCP Server starting in STDIO mode...');
    console.error('📊 Connecting to Supabase...');

    try {
        await supabase.testConnection();
        console.error('✅ Ready to receive MCP requests');
    } catch (error) {
        console.error('❌ Failed to connect to Supabase:', error);
        process.exit(1);
    }

    let buffer = '';

    // Read from stdin
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async(chunk) => {
        buffer += chunk;

        // Process complete lines (JSON-RPC messages end with \n)
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const request = JSON.parse(line);
                await handleRequest(request);
            } catch (error) {
                console.error('❌ Failed to parse request:', error);
                console.error('Raw line:', line);
            }
        }
    });

    process.stdin.on('end', () => {
        console.error('📪 stdin closed, shutting down...');
        process.exit(0);
    });

    process.stdin.on('error', (error) => {
        console.error('❌ stdin error:', error);
        process.exit(1);
    });
}

// Start the server
main().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});