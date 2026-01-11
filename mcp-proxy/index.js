import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import EventSource from "eventsource";

// Polyfill EventSource for Node.js
global.EventSource = EventSource;

const REMOTE_URL = "https://mcp-backenddeploy-production.up.railway.app/mcp/sse";
const API_KEY = "YisusCompany-mcp-api-key-2025-secure";

async function main() {
    console.error(`[MCP Proxy] Starting proxy to ${REMOTE_URL}...`);

    // 1. Initialize Client (Connection to Railway)
    const transport = new SSEClientTransport(
        new URL(REMOTE_URL),
        {
            eventSourceInit: {
                headers: {
                    "X-API-Key": API_KEY
                }
            }
        }
    );

    const client = new Client({
        name: "mcp-proxy-client",
        version: "1.0.0"
    }, {
        capabilities: {
            sampling: {}
        }
    });

    try {
        await client.connect(transport);
        console.error("[MCP Proxy] Connected to remote Railway backend!");
    } catch (error) {
        console.error("[MCP Proxy] Failed to connect to remote backend:", error);
        process.exit(1);
    }

    // 2. Initialize Server (Stdio for Claude/VSCode)
    const server = new Server({
        name: "YisusCompany-Proxy",
        version: "1.0.0"
    }, {
        capabilities: {
            tools: {},
            resources: {},
            prompts: {}
        }
    });

    // 3. Set up Proxy Handlers
    // Forward Tools
    server.setRequestHandler("tools/list", async () => {
        try {
            return await client.listTools();
        } catch (e) {
            console.error("[MCP Proxy] Error listing tools:", e);
            throw e;
        }
    });

    server.setRequestHandler("tools/call", async (request) => {
        try {
            return await client.callTool({
                name: request.params.name,
                arguments: request.params.arguments
            });
        } catch (e) {
            console.error(`[MCP Proxy] Error calling tool ${request.params.name}:`, e);
            throw e;
        }
    });

    // Forward Resources
    server.setRequestHandler("resources/list", async () => {
        try {
            return await client.listResources();
        } catch (e) {
            console.error("[MCP Proxy] Error listing resources:", e);
            throw e;
        }
    });

    server.setRequestHandler("resources/read", async (request) => {
        try {
            return await client.readResource(request.params);
        } catch (e) {
            console.error(`[MCP Proxy] Error reading resource ${request.params.uri}:`, e);
            throw e;
        }
    });

    // Forward Prompts
    server.setRequestHandler("prompts/list", async () => {
        try {
            return await client.listPrompts();
        } catch (e) {
            console.error("[MCP Proxy] Error listing prompts:", e);
            throw e;
        }
    });

    server.setRequestHandler("prompts/get", async (request) => {
        try {
            return await client.getPrompt(request.params);
        } catch (e) {
            console.error(`[MCP Proxy] Error getting prompt ${request.params.name}:`, e);
            throw e;
        }
    });

    // 4. Start Stdio Server
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error("[MCP Proxy] Server listening on stdio");
}

main().catch(err => {
    console.error("[MCP Proxy] Fatal error:", err);
    process.exit(1);
});
