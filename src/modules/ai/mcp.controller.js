/**
 * MCPController — Controlador HTTP para el protocolo MCP.
 *
 * Gestiona endpoints SSE y JSON-RPC para clientes VS Code.
 */

import { ValidationError } from '../../shared/errors/index.js';
import crypto from 'crypto';

export class MCPController {
    constructor({ mcpService }) {
        this.mcpService = mcpService;
        this.sseConnections = new Map();
    }

    /**
     * SSE endpoint para clientes MCP.
     */
    sseConnect = (req, res) => {
        const sessionId = crypto.randomUUID();

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        // Store connection
        this.sseConnections.set(sessionId, { res, connectedAt: Date.now() });

        // Send endpoint URL
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        res.write(`event: endpoint\ndata: ${baseUrl}/api/v1/mcp/message?sessionId=${sessionId}\n\n`);
        // Heartbeat
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30000);
        req.on('close', () => {
            clearInterval(heartbeat);
            this.sseConnections.delete(sessionId);
        });
    };

    /**
     * JSON-RPC message endpoint para clientes MCP.
     */
    handleMessage = async(req, res, next) => {
        try {
            const { sessionId } = req.query;
            const { method, params, id } = req.body;
            let response;

            switch (method) {
                case 'initialize':
                    response = {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            protocolVersion: '2024-11-05',
                            capabilities: { tools: { listChanged: true }, resources: { subscribe: false } },
                            serverInfo: { name: 'YisusCompany MCP Server', version: '3.0.0' },
                        },
                    };
                    break;

                case 'tools/list':
                    response = {
                        jsonrpc: '2.0',
                        id,
                        result: { tools: this.mcpService.getToolsList() },
                    };
                    break;

                case 'tools/call':
                    {
                        const result = await this._handleToolCall(params?.name, params?.arguments);
                        response = { jsonrpc: '2.0', id, result };
                        break;
                    }

                case 'notifications/initialized':
                    res.status(202).end();
                    return;

                default:
                    response = {
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32601, message: `Método no soportado: ${method}` },
                    };
            }

            // Send via SSE if connection exists, else via HTTP
            const conn = this.sseConnections.get(sessionId);
            if (conn && conn.res && !conn.res.writableEnded) {
                conn.res.write(`data: ${JSON.stringify(response)}\n\n`);
                res.status(202).end();
            } else {
                res.json(response);
            }
        } catch (err) { next(err); }
    };

    /**
     * Lista sesiones activas (debug).
     */
    listSessions = (req, res) => {
        const sessions = Array.from(this.sseConnections.entries()).map(([id, conn]) => ({
            id,
            connectedAt: new Date(conn.connectedAt).toISOString(),
        }));
        res.json({ success: true, data: { count: sessions.length, sessions } });
    };

    /** @private */
    async _handleToolCall(toolName, args) {
        switch (toolName) {
            case 'query_database':
            case 'get_database_schema':
                const schemaResult = await this.mcpService.getDatabaseSchema();
                return { content: [{ type: 'text', text: JSON.stringify(schemaResult.isOk() ? schemaResult.getValue() : { error: schemaResult.getError().message }) }] };

            case 'get_user_info':
                const userResult = await this.mcpService.getUserInfo(args);
                return { content: [{ type: 'text', text: JSON.stringify(userResult.isOk() ? userResult.getValue() : { error: userResult.getError().message }) }] };

            case 'get_course_info':
                const courseResult = await this.mcpService.getCourseInfo(args.courseId);
                return { content: [{ type: 'text', text: JSON.stringify(courseResult.isOk() ? courseResult.getValue() : { error: courseResult.getError().message }) }] };

            case 'get_task_submissions':
                const submResult = await this.mcpService.getTaskSubmissions(args.taskId);
                return { content: [{ type: 'text', text: JSON.stringify(submResult.isOk() ? submResult.getValue() : { error: submResult.getError().message }) }] };

            case 'send_notification':
                const notifResult = await this.mcpService.sendNotification(args);
                return { content: [{ type: 'text', text: JSON.stringify(notifResult.isOk() ? notifResult.getValue() : { error: notifResult.getError().message }) }] };

            default:
                return { content: [{ type: 'text', text: `Herramienta '${toolName}' no encontrada` }], isError: true };
        }
    }
}
export default MCPController;

