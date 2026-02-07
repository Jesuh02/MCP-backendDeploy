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
            // DeepSeek V3 (Chat) is preferred over Reasoner for generic tasks to avoid loops/timeouts
            // API Docs: https://api-docs.deepseek.com/
            const modelName = process.env.DEEPSEEK_MODEL || "deepseek-chat";
            console.log(`🧠 Initializing DeepSeek ${modelName} ...`);
            this.provider = 'deepseek';
            this.model = new ChatOpenAI({
                openAIApiKey: deepSeekApiKey,
                configuration: {
                    baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
                },
                modelName: modelName,
                temperature: 0.3,
                timeout: 300000,
                maxRetries: 2
            });
        } else {
            console.warn("⚠️ No DeepSeek API Key provided and Local LLM is disabled.");
            this.provider = 'none';
            this.model = null;
        }

        LLMService.instance = this;
    }

    async testConnection() {
        if (!this.model) return { status: 'disabled', error: 'Model not initialized' };
        try {
            // Simple test with timeout (longer for reasoning models)
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection test timeout')), 30000)
            );
            await Promise.race([this.model.invoke("Hello"), timeoutPromise]);
            const modelName = process.env.DEEPSEEK_MODEL || "deepseek-reasoner";
            return {
                status: 'connected',
                provider: this.provider,
                model: this.provider === 'deepseek' ? modelName : 'llama3:8b',
                thinkingMode: modelName.includes('reasoner')
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

        // --- USER REQUESTED LOGGING ---
        console.log("\n🔍 [LLM REQUEST START] ----------------------------------------");
        try {
            const messageLog = messages.map(m => ({
                role: m.constructor.name,
                content: m.content,
                // Show FULL content as requested by user to verify no truncation
                contentPreview: m.content // Removed truncation limit
            }));
            console.log("INPUT MESSAGES:", JSON.stringify(messageLog, null, 2));

            // Check for specific files requested by user
            const fullContent = JSON.stringify(messages);
            const interestingFiles = [
                'ReinforcementLearningScreen.kt',
                'utils/index.js',
                'MCPService.js'
            ];
            const foundFiles = interestingFiles.filter(f => fullContent.includes(f));
            if (foundFiles.length > 0) {
                console.log(`\n!!! 🎯 TARGET FILES DETECTED IN PROMPT: ${foundFiles.join(', ')} !!!\n`);
            }
        } catch (e) {
            console.log("Error logging inputs:", e);
        }
        console.log("------------------------------------------------------------\n");
        // ------------------------------

        try {
            // Sanitize messages to avoid DeepSeek API errors
            const sanitizedMessages = this.sanitizeMessages(messages);

            // If no tools, just invoke directly
            if (!tools || tools.length === 0) {
                const response = await this.model.invoke(sanitizedMessages);

                // --- USER REQUESTED LOGGING ---
                console.log("\n📤 [LLM RESPONSE] -------------------------------------------");
                console.log("OUTPUT CONTENT:", response.content);
                console.log("------------------------------------------------------------\n");
                // ------------------------------

                return response;
            }

            // Format tools for OpenAI/DeepSeek API
            const formattedTools = tools.map(t => ({
                type: "function",
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters || { type: "object", properties: {}, required: [] }
                }
            }));

            const modelWithTools = this.model.bind({
                tools: formattedTools,
                tool_choice: "auto" // Force the model to consider using tools
            });

            const response = await modelWithTools.invoke(sanitizedMessages);

            // --- USER REQUESTED LOGGING ---
            console.log("\n📤 [LLM RESPONSE (WITH TOOLS)] ------------------------------");
            console.log("OUTPUT CONTENT:", response.content);
            if (response.tool_calls && response.tool_calls.length > 0) {
                console.log("TOOL CALLS:", JSON.stringify(response.tool_calls, null, 2));
            } else {
                console.log("⚠️ NO TOOL CALLS - LLM chose not to use tools");
            }
            console.log("------------------------------------------------------------\n");
            // ------------------------------

            return response;
        } catch (error) {
            console.error("Error generating LLM response:", error);

            // If the error is about tool_calls, try without tools
            if (error.message && error.message.includes('tool_calls')) {
                console.warn("Tool call error detected, retrying without tools...");
                try {
                    const sanitizedMessages = this.sanitizeMessages(messages);
                    const response = await this.model.invoke(sanitizedMessages);

                    // --- USER REQUESTED LOGGING ---
                    console.log("\n📤 [LLM RESPONSE (RETRY)] -----------------------------------");
                    console.log("OUTPUT CONTENT:", response.content);
                    console.log("------------------------------------------------------------\n");
                    // ------------------------------

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