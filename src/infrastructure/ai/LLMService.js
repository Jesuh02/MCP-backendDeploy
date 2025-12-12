import { ChatOllama } from "@langchain/community/chat_models/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, ToolMessage, AIMessage } from "@langchain/core/messages";

export class LLMService {
    static instance = null;

    static getInstance() {
        if (!LLMService.instance) {
            LLMService.instance = new LLMService();
        }
        return LLMService.instance;
    }

    constructor() {
        // Prevent multiple instances
        if (LLMService.instance) {
            return LLMService.instance;
        }

        // Check if DeepSeek is configured
        const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
        const useDeepSeek = process.env.USE_LLM === 'true' && deepSeekApiKey;

        if (useDeepSeek) {
            console.log("Initializing DeepSeek LLM...");
            this.provider = 'deepseek';
            this.model = new ChatOpenAI({
                openAIApiKey: deepSeekApiKey,
                configuration: {
                    baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
                },
                modelName: process.env.DEEPSEEK_MODEL || "deepseek-chat",
                temperature: 0.3,
                timeout: 30000,
                maxRetries: 1
            });
        } else {
            console.log("Initializing Ollama LLM...");
            this.provider = 'ollama';
            // Initialize Ollama with Llama 3:8b
            this.model = new ChatOllama({
                baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
                model: "llama3:8b",
                temperature: 0,
                // Reduced timeout to 30s to prevent long hangs
                timeout: 30000
            });
        }

        LLMService.instance = this;
    }

    async testConnection() {
        if (!this.model) return { status: 'disabled', error: 'Model not initialized' };
        try {
            // Simple test with timeout
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection test timeout')), 10000)
            );
            await Promise.race([this.model.invoke("Hello"), timeoutPromise]);
            return {
                status: 'connected',
                provider: this.provider,
                model: this.provider === 'deepseek' ? (process.env.DEEPSEEK_MODEL || "deepseek-chat") : 'llama3:8b'
            };
        } catch (error) {
            console.error("LLM Connection failed:", error);
            return { status: 'error', error: error.message };
        }
    }

    /**
     * Generate a response from the LLM, potentially calling tools.
     * @param {Array} messages - History of messages
     * @param {Array} tools - List of tool definitions (JSON Schema)
     */
    async generateResponse(messages, tools = []) {
        if (!this.model) throw new Error("LLM disabled");

        try {
            // Sanitize messages to avoid DeepSeek API errors
            const sanitizedMessages = this.sanitizeMessages(messages);

            // If no tools, just invoke directly
            if (!tools || tools.length === 0) {
                const response = await this.model.invoke(sanitizedMessages);
                return response;
            }

            const modelWithTools = this.model.bind({
                tools: tools.map(t => ({
                    type: "function",
                    function: t
                }))
            });

            const response = await modelWithTools.invoke(sanitizedMessages);
            return response;
        } catch (error) {
            console.error("Error generating LLM response:", error);

            // If the error is about tool_calls, try without tools
            if (error.message && error.message.includes('tool_calls')) {
                console.warn("Tool call error detected, retrying without tools...");
                try {
                    const sanitizedMessages = this.sanitizeMessages(messages);
                    const response = await this.model.invoke(sanitizedMessages);
                    return response;
                } catch (retryError) {
                    throw retryError;
                }
            }
            throw error;
        }
    }

    /**
     * Sanitize messages to avoid DeepSeek API errors.
     * Removes empty tool_calls arrays and ensures proper message format.
     */
    sanitizeMessages(messages) {
        return messages.map(msg => {
            // If it's an AIMessage with empty tool_calls, remove the tool_calls property
            if (msg instanceof AIMessage || (msg._getType && msg._getType() === 'ai')) {
                if (msg.tool_calls && msg.tool_calls.length === 0) {
                    // Create a new AIMessage without tool_calls
                    return new AIMessage({
                        content: msg.content || ""
                    });
                }
                // If there ARE tool_calls, ensure each has the required fields
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    const validToolCalls = msg.tool_calls.filter(tc => tc && tc.id && tc.name);
                    if (validToolCalls.length === 0) {
                        return new AIMessage({ content: msg.content || "" });
                    }
                }
            }
            return msg;
        });
    }
}