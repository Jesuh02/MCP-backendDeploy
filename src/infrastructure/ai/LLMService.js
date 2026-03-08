/**
 * LLM model classes are loaded lazily to avoid blocking server startup.
 * Static imports of @langchain packages are heavy (~500ms+) and can cause
 * Railway 502 errors if they delay health check responses.
 */
let ChatOllama = null;
let ChatOpenAI = null;
let _HumanMessage = null;
let _SystemMessage = null;
let _ToolMessage = null;
let _AIMessage = null;
let _langchainLoaded = false;

/**
 * Lazy-loads LangChain dependencies on first use.
 * Follows OCP: new providers can be added without modifying existing logic.
 */
async function ensureLangChainLoaded() {
    if (_langchainLoaded) return;
    try {
        const [openaiMod, coreMod] = await Promise.all([
            import ('@langchain/openai'),
            import ('@langchain/core/messages'),
        ]);
        ChatOpenAI = openaiMod.ChatOpenAI;
        _HumanMessage = coreMod.HumanMessage;
        _SystemMessage = coreMod.SystemMessage;
        _ToolMessage = coreMod.ToolMessage;
        _AIMessage = coreMod.AIMessage;
    } catch (e) {
        console.warn('⚠️ @langchain/openai not available:', e.message);
    }
    try {
        const ollamaMod = await
        import ('@langchain/community/chat_models/ollama');
        ChatOllama = ollamaMod.ChatOllama;
    } catch (e) {
        console.warn('⚠️ @langchain/community not available:', e.message);
    }
    _langchainLoaded = true;
}

export class LLMService {
    static instance = null;

    static getInstance() {
        if (!LLMService.instance) {
            LLMService.instance = new LLMService();
        }
        return LLMService.instance;
    }

    constructor() {
        if (LLMService.instance) {
            return LLMService.instance;
        }

        this.model = null;
        this.provider = 'none';
        this._initialized = false;
        LLMService.instance = this;
    }

    /**
     * Initializes the LLM provider lazily on first use.
     * Separates construction from initialization (SRP).
     */
    async _ensureInitialized() {
        if (this._initialized) return;
        this._initialized = true;

        await ensureLangChainLoaded();

        const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
        // enable DeepSeek automatically whenever an API key is configured, unless
        // the user explicitly disables via USE_LLM="false".  This reduces the
        // surprising case where DEEPSEEK_API_KEY is set but nothing happens.
        const useDeepSeek = Boolean(deepSeekApiKey) && process.env.USE_LLM !== 'false';
        if (deepSeekApiKey && process.env.USE_LLM !== 'true') {
            console.warn('[LLMService] DEEPSEEK_API_KEY present; enabling LLM even though USE_LLM!=true');
        }

        if (useDeepSeek && ChatOpenAI) {
            const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
            console.log(`🧠 Initializing DeepSeek ${modelName} ...`);
            this.provider = 'deepseek';
            this.model = new ChatOpenAI({
                openAIApiKey: deepSeekApiKey,
                configuration: {
                    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
                },
                modelName,
                temperature: 0.3,
                timeout: 300000,
                maxRetries: 2,
            });
        } else if (ChatOllama) {
            console.log('Initializing Ollama LLM...');
            this.provider = 'ollama';
            this.model = new ChatOllama({
                baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
                model: 'llama3:8b',
                temperature: 0,
                timeout: 30000,
            });
        } else {
            console.warn('⚠️ No LLM provider available (LangChain not loaded or disabled)');
        }
    }

    async testConnection() {
        await this._ensureInitialized();
        if (!this.model) return { status: 'disabled', error: 'Model not initialized' };
        try {
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
        await this._ensureInitialized();
        if (!this.model) throw new Error("LLM disabled");

        // --- USER REQUESTED LOGGING ---
        console.log("\n🔍 [LLM REQUEST START] ----------------------------------------");
        try {
            const messageLog = messages.map(m => ({
                role: m.constructor.name,
                content: m.content,
                contentPreview: m.content
            }));
            console.log("INPUT MESSAGES:", JSON.stringify(messageLog, null, 2));

            const fullContent = JSON.stringify(messages);

            const acumulativoMatch = fullContent.match(/PROHIBIDO REPETIR/g);
            if (acumulativoMatch) {
                const existingCount = (fullContent.match(/\d+\.\s/g) || []).length;
                console.log(`\n🔢 [LLMService] ACUMULATIVO: ${existingCount} preguntas existentes inyectadas al prompt para evitar repeticiones`);
            }

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
            if ((_AIMessage && msg instanceof _AIMessage) || (msg._getType && msg._getType() === 'ai')) {
                if (msg.tool_calls && msg.tool_calls.length === 0) {
                    // Create a new AIMessage without tool_calls
                    if (_AIMessage) return new _AIMessage({ content: msg.content || "" });
                    return {...msg, tool_calls: undefined };
                }
                // If there ARE tool_calls, ensure each has the required fields
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    const validToolCalls = msg.tool_calls.filter(tc => tc && tc.id && tc.name);
                    if (validToolCalls.length === 0) {
                        if (_AIMessage) return new _AIMessage({ content: msg.content || "" });
                        return {...msg, tool_calls: undefined };
                    }
                }
            }
            return msg;
        });
    }
}

