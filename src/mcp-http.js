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

// Initialize services
const supabase = SupabaseService.getInstance();
const mcpService = new MCPService();

/**
 * Health check endpoint
 */
app.get('/health', async(req, res) => {
    try {
        const dbHealth = await supabase.healthCheck();

        // Test LLM connection
        let llmHealth = { status: 'not_tested' };
        try {
            llmHealth = await mcpService.llmService.testConnection();
        } catch (e) {
            llmHealth = { status: 'error', error: e.message };
        }

        res.json({
            status: 'ok',
            server: 'tareamov-mcp-server',
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
 * MCP initialize endpoint
 */
app.post('/initialize', async(req, res) => {
    console.log('🔧 MCP Initialize request received');

    try {
        await supabase.testConnection();
        console.log('✅ Supabase connected');

        res.json({
            jsonrpc: '2.0',
            id: req.body.id,
            result: {
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
            }
        });
    } catch (error) {
        console.error('❌ Initialize error:', error);
        res.status(500).json({
            jsonrpc: '2.0',
            id: req.body.id,
            error: {
                code: -32603,
                message: 'Internal error during initialization',
                data: error.message
            }
        });
    }
});

/**
 * MCP tools/list endpoint
 */
app.post('/tools/list', async(req, res) => {
    console.log('🔧 Tools list request received');

    res.json({
        jsonrpc: '2.0',
        id: req.body.id,
        result: {
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
usuarios, personas, courses, videos, topics, content_items, tasks, task_submissions, subscriptions, chat_messages, file_contexts, roles, recursos, rol_recursos, progreso_estudiante`,
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
                    description: `Get the complete Supabase database schema with all tables, columns, types, and relationships.

**RETURNS:**
- Table names and descriptions
- Column names, types, and constraints
- Primary keys and foreign keys
- Relationships between tables

**USE THIS TO:**
- Understand database structure before writing SQL
- Validate column names and types
- Discover relationships for JOINs
- Plan complex queries

**TIP:** Call this ONCE at the start of a conversation, then generate SQL queries based on the schema.`,
                    inputSchema: {
                        type: 'object',
                        properties: {},
                        description: 'No parameters required - returns full schema'
                    }
                },
                {
                    name: 'analyze_github_repo',
                    description: `Analyze and grade a GitHub repository. Extracts code, README, and structure to evaluate quality.

**CAPABILITIES:**
- Clone/read public GitHub repositories
- Extract source code files (Python, JavaScript, Java, Kotlin, etc.)
- Analyze project structure and organization
- Evaluate code quality, documentation, and best practices
- Generate grades (0-100) with detailed feedback

**HOW TO USE:**
Provide a GitHub URL and optional evaluation criteria.

**EXAMPLES:**
1. Basic: {"repoUrl": "https://github.com/user/project"}
2. With criteria: {"repoUrl": "https://github.com/user/project", "criteria": "Evaluar implementación de patrones de diseño"}
3. With task: {"repoUrl": "github.com/user/repo", "taskDescription": "Crear una API REST con autenticación"}

**SUPPORTED URL FORMATS:**
- https://github.com/owner/repo
- github.com/owner/repo
- owner/repo

**RETURNS:**
- Repository info (name, language, description)
- Grade (0-100) with justification
- Strengths and areas for improvement
- Detailed technical analysis
- List of analyzed files

**NOTE:** Only works with PUBLIC repositories. For private repos, configure GITHUB_TOKEN.`,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            repoUrl: {
                                type: 'string',
                                description: 'GitHub repository URL (e.g., https://github.com/user/repo)'
                            },
                            criteria: {
                                type: 'string',
                                description: 'Optional evaluation criteria or rubric'
                            },
                            taskDescription: {
                                type: 'string',
                                description: 'Optional task/assignment description for context'
                            },
                            fileTypes: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Optional file extensions to analyze (e.g., [".py", ".js"])'
                            }
                        },
                        required: ['repoUrl']
                    }
                }
            ]
        }
    });
});

/**
 * MCP tools/call endpoint
 */
app.post('/tools/call', async(req, res) => {
    const { params } = req.body;
    console.log('🔧 Tool call request:', params?.name);

    try {
        const { name, arguments: args } = params;

        if (name === 'query_database') {
            let result;
            // Check if it's likely SQL
            const isSQL = /^\s*(select|insert|update|delete|with)\s/i.test(args.query);

            if (isSQL) {
                console.log('📊 Executing raw SQL query...');
                result = await mcpService.processQuery(args.query, { includeSchema: true });
            } else {
                console.log('🤖 Processing Natural Language Query via Agent...');
                // Use Agent DIRECTLY for Natural Language (bypasses processQuery snapshot logic)
                try {
                    const agentResponse = await mcpService.processQueryWithAgent(args.query);

                    // Agent should return a natural language response string
                    console.log('✅ Agent response type:', typeof agentResponse);
                    console.log('✅ Agent response preview:', JSON.stringify(agentResponse).substring(0, 200));

                    // Return the agent's response as-is (should be argumentative text)
                    result = {
                        data: agentResponse,
                        sqlScript: "-- Executed via LLM Agent with tool calling"
                    };
                } catch (agentError) {
                    console.error('❌ Agent error:', agentError);
                    result = {
                        error: true,
                        message: `Error del agente LLM: ${agentError.message}`
                    };
                }
            }

            res.json({
                jsonrpc: '2.0',
                id: req.body.id,
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }]
                }
            });
        } else if (name === 'get_database_schema') {
            const schema = await mcpService.getDatabaseSchema();
            res.json({
                jsonrpc: '2.0',
                id: req.body.id,
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(schema, null, 2)
                    }]
                }
            });
        } else if (name === 'analyze_github_repo') {
            // Nueva herramienta para analizar y calificar repositorios de GitHub
            console.log('🐙 Analyzing GitHub repository:', args.repoUrl);

            try {
                const result = await mcpService.analyzeGitHubRepo(args.repoUrl, {
                    taskDescription: args.taskDescription,
                    gradingCriteria: args.gradingCriteria,
                    focusAreas: args.focusAreas,
                    maxFiles: args.maxFiles
                });

                res.json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(result, null, 2)
                        }]
                    }
                });
            } catch (githubError) {
                console.error('❌ GitHub analysis error:', githubError);
                res.json({
                    jsonrpc: '2.0',
                    id: req.body.id,
                    result: {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                error: true,
                                message: `Error analizando repositorio: ${githubError.message}`,
                                hint: mcpService.getGitHubErrorHint ? mcpService.getGitHubErrorHint(githubError.message) : null
                            }, null, 2)
                        }]
                    }
                });
            }
        } else {
            res.status(404).json({
                jsonrpc: '2.0',
                id: req.body.id,
                error: {
                    code: -32601,
                    message: `Tool not found: ${name}`
                }
            });
        }
    } catch (error) {
        console.error('❌ Tool call error:', error);
        // Devolvemos un JSON válido con el error para que el cliente Android lo procese
        // en lugar de un 500 genérico que rompe el flujo JSON-RPC
        res.json({
            jsonrpc: '2.0',
            id: req.body.id,
            result: {
                content: [{
                    type: 'text',
                    // Incluimos "SQL Error" para que el regex de Android lo detecte
                    text: `❌ Error executing tool: ${error.message}\nHint: Check table names and SQL syntax.`
                }]
            }
        });
    }
});

/**
 * Start server
 */
async function main() {
    console.log('🚀 TareaMov MCP Server starting in HTTP mode...');
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

        app.listen(PORT, '0.0.0.0', () => {
            const localIp = getLocalIp();
            console.log(`✅ MCP HTTP Server listening on http://0.0.0.0:${PORT}`);
            console.log(`📱 Android Emulator URL: http://10.0.2.2:${PORT}`);
            console.log(`💻 Local URL: http://localhost:${PORT}`);
            console.log(`🔌 Physical Device URL: http://${localIp}:${PORT} (Use this for physical devices)`);
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