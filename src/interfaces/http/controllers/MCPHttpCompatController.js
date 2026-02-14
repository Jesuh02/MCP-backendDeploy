/**
 * MCPHttpCompatController — Controlador HTTP para compatibilidad con Android MCPHttpClient.
 *
 * Maneja los endpoints /initialize, /tools/list, /tools/call que el cliente
 * Android envía directamente en formato JSON-RPC.
 *
 * Principio SRP: Solo gestiona la compatibilidad HTTP del protocolo MCP para Android.
 * Principio DIP: Recibe dependencias por inyección, no importa infraestructura.
 */

export class MCPHttpCompatController {
    /**
     * @param {Object} deps
     * @param {Object} deps.mcpService - MCPDomainService (hexagonal)
     * @param {Object} deps.mcpServiceLegacy - MCPService legacy (para query_database y analyze_github)
     */
    constructor({ mcpService, mcpServiceLegacy }) {
        this.mcpService = mcpService;
        this.mcpServiceLegacy = mcpServiceLegacy;
    }

    /**
     * POST /initialize — Handshake inicial del protocolo MCP.
     */
    initialize = async(req, res) => {
        try {
            res.json({
                jsonrpc: '2.0',
                id: req.body ?.id || 1,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: { listChanged: true },
                        resources: { subscribe: true, listChanged: true },
                    },
                    serverInfo: {
                        name: 'YisusCompany by YisusFactory MCP Server',
                        version: '3.0.0',
                    },
                },
            });
        } catch (error) {
            console.error('❌ Initialize error:', error);
            res.status(500).json({
                jsonrpc: '2.0',
                id: req.body ?.id || 1,
                error: { code: -32603, message: 'Internal error', data: error.message },
            });
        }
    };

    /**
     * POST /tools/list — Lista de herramientas MCP disponibles.
     */
    listTools = (_req, res) => {
            res.json({
                        jsonrpc: '2.0',
                        id: _req.body ?.id || 1,
                        result: {
                tools: [
                    {
                        name: 'query_database',
                        description: 'Execute queries on the YisusCompany Supabase database. Accepts raw SQL or natural language.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                query: { type: 'string', description: 'SQL or natural language query' },
                            },
                            required: ['query'],
                        },
                    },
                    {
                        name: 'get_database_schema',
                        description: 'Get the complete database schema with all tables and columns.',
                        inputSchema: { type: 'object', properties: {} },
                    },
                    {
                        name: 'analyze_github_repo',
                        description: 'Analyze and grade a GitHub repository.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                repoUrl: { type: 'string', description: 'GitHub repository URL' },
                                criteria: { type: 'string', description: 'Evaluation criteria' },
                                taskDescription: { type: 'string', description: 'Task description' },
                            },
                            required: ['repoUrl'],
                        },
                    },
                ],
            },
        });
    };

    /**
     * POST /tools/call — Ejecuta una herramienta MCP.
     */
    callTool = async (req, res) => {
        const { params } = req.body;
        const toolName = params?.name;
        const args = params?.arguments || {};

        try {
            if (!this.mcpServiceLegacy) {
                throw new Error('MCPService not initialized');
            }

            const result = await this._dispatchToolCall(toolName, args);

            res.json({
                jsonrpc: '2.0',
                id: req.body.id,
                result: {
                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                },
            });
        } catch (error) {
            console.error(`❌ Tool call error (${toolName}):`, error);
            res.json({
                jsonrpc: '2.0',
                id: req.body.id,
                result: {
                    content: [{ type: 'text', text: `❌ Error: ${error.message}` }],
                },
            });
        }
    };

    /**
     * Despacha la llamada a la herramienta correspondiente.
     * @private
     */
    async _dispatchToolCall(toolName, args) {
        switch (toolName) {
            case 'query_database':
                return this._handleQueryDatabase(args);

            case 'get_database_schema':
                return this.mcpServiceLegacy.getDatabaseSchema();

            case 'analyze_github_repo':
                return this._handleAnalyzeGitHub(args);

            default:
                throw new Error(`Tool not found: ${toolName}`);
        }
    }

    /**
     * Ejecuta query_database distinguiendo entre SQL directo y lenguaje natural.
     * @private
     */
    async _handleQueryDatabase(args) {
        const isSQLQuery = /^\s*(select|insert|update|delete|with)\s/i.test(args.query);

        if (isSQLQuery) {
            return this.mcpServiceLegacy.processQuery(args.query, { includeSchema: true });
        }

        try {
            const agentResponse = await this.mcpServiceLegacy.processQueryWithAgent(args.query);
            return { data: agentResponse, sqlScript: '-- Executed via LLM Agent' };
        } catch (agentErr) {
            console.error('❌ Agent error:', agentErr);
            return { error: true, message: `Error del agente LLM: ${agentErr.message}` };
        }
    }

    /**
     * Analiza un repositorio GitHub.
     * @private
     */
    async _handleAnalyzeGitHub(args) {
        return this.mcpServiceLegacy.analyzeGitHubRepo(args.repoUrl, {
            taskDescription: args.taskDescription,
            gradingCriteria: args.gradingCriteria,
        });
    }
}

export default MCPHttpCompatController;


