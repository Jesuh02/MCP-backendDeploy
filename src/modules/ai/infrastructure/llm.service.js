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
        this.primaryModel = null;
        this.fallbackModel = null;
        this.provider = 'none';
        this.primaryProvider = 'none';
        this.fallbackProvider = 'none';
        this._initialized = false;
        LLMService.instance = this;
    }

    /**
     * Initializes the LLM providers lazily on first use.
     * Primary: Qwen3.6 Plus via OpenRouter.
     * Fallback: DeepSeek via DeepSeek API (used when primary fails or times out).
     */
    async _ensureInitialized() {
        if (this._initialized) return;
        this._initialized = true;

        await ensureLangChainLoaded();

        // ── PRIMARY MODEL: Qwen3.6 Plus via OpenRouter ─────────────────────────
        const openRouterApiKey = process.env.OPENROUTER_API_KEY;
        if (openRouterApiKey && ChatOpenAI) {
            const modelName = process.env.OPENROUTER_MODEL || 'qwen/qwen3.6-plus';
            console.log(`🧠 Initializing PRIMARY model: ${modelName} via OpenRouter ...`);
            this.primaryProvider = 'openrouter';
            this.primaryModel = new ChatOpenAI({
                openAIApiKey: openRouterApiKey,
                configuration: {
                    baseURL: 'https://openrouter.ai/api/v1',
                },
                modelName,
                temperature: 0.3,
                timeout: 180000,
                maxRetries: 1,
            });
        }

        // ── FALLBACK MODEL: DeepSeek ──────────────────────────────────────────
        const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
        const useDeepSeek = Boolean(deepSeekApiKey) && process.env.USE_LLM !== 'false';
        if (deepSeekApiKey && process.env.USE_LLM !== 'true') {
            console.warn('[LLMService] DEEPSEEK_API_KEY present; enabling LLM even though USE_LLM!=true');
        }

        if (useDeepSeek && ChatOpenAI) {
            const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
            console.log(`🧠 Initializing FALLBACK model: DeepSeek ${modelName} ...`);
            this.fallbackProvider = 'deepseek';
            this.fallbackModel = new ChatOpenAI({
                openAIApiKey: deepSeekApiKey,
                configuration: {
                    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
                },
                modelName,
                temperature: 0.3,
                timeout: 300000,
                maxRetries: 2,
            });
        }

        // ── Set active model: primary preferred, fallback otherwise ───────────
        if (this.primaryModel) {
            this.model = this.primaryModel;
            this.provider = this.primaryProvider;
        } else if (this.fallbackModel) {
            this.model = this.fallbackModel;
            this.provider = this.fallbackProvider;
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
            const primaryModelName = process.env.OPENROUTER_MODEL || 'qwen/qwen3.6-plus';
            const fallbackModelName = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
            return {
                status: 'connected',
                provider: this.provider,
                model: this.provider === 'openrouter' ? primaryModelName : (this.provider === 'deepseek' ? fallbackModelName : 'llama3:8b'),
                hasFallback: !!this.fallbackModel,
                fallbackProvider: this.fallbackProvider,
            };
        } catch (error) {
            console.error("LLM Connection failed:", error);
            return { status: 'error', error: error.message };
        }
    }

    /**
     * Invokes a model with automatic fallback from primary (Qwen3.6 Plus/OpenRouter)
     * to fallback (DeepSeek) on error or timeout.
     * @param {Function} invokeFn - (model) => Promise<response>
     * @returns {Promise<any>}
     * @private
     */
    async _invokeWithFallback(invokeFn) {
        const PRIMARY_TIMEOUT_MS = 60000; // 60s — fail fast to fallback
        const primaryModelName = process.env.OPENROUTER_MODEL || 'qwen/qwen3.6-plus';
        const fallbackModelName = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

        if (this.primaryModel && this.fallbackModel) {
            try {
                const startTime = Date.now();
                const result = await Promise.race([
                    invokeFn(this.primaryModel),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Primary model timeout (60s)')), PRIMARY_TIMEOUT_MS)
                    ),
                ]);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`✅ RESPONDIÓ: Qwen3.6 Plus (${primaryModelName}) vía OpenRouter en ${elapsed}s`);
                return result;
            } catch (err) {
                console.warn(`⚠️ Qwen3.6 Plus (${primaryModelName}) FALLÓ: ${err.message}. Cambiando a DeepSeek (${fallbackModelName})...`);
                const startTime = Date.now();
                const result = await invokeFn(this.fallbackModel);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`✅ RESPONDIÓ: DeepSeek (${fallbackModelName}) vía DeepSeek API en ${elapsed}s (fallback)`);
                return result;
            }
        }

        // Only one model available
        if (!this.model) throw new Error('LLM disabled');
        const singleModelName = this.provider === 'openrouter' ? primaryModelName : (this.provider === 'deepseek' ? fallbackModelName : 'ollama');
        const startTime = Date.now();
        const result = await invokeFn(this.model);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ RESPONDIÓ: ${singleModelName} (${this.provider}) en ${elapsed}s`);
        return result;
    }

    /**
     * Generate a response from the LLM, potentially calling tools.
     * @param {Array} messages - History of messages
     * @param {Array} tools - List of tool definitions (JSON Schema)
     * @param {Object} [opts] - Extra options
     * @param {string} [opts.toolChoice] - "auto" (default) | "required" | "none"
     */
    async generateResponse(messages, tools = [], opts = {}) {
        const toolChoice = opts.toolChoice || 'auto';
        await this._ensureInitialized();
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
                const response = await this._invokeWithFallback(model => model.invoke(sanitizedMessages));

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

            const response = await this._invokeWithFallback(model => {
                const modelWithTools = model.bind({
                    tools: formattedTools,
                    tool_choice: toolChoice,
                });
                return modelWithTools.invoke(sanitizedMessages);
            });

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
                    const response = await this._invokeWithFallback(model => model.invoke(sanitizedMessages));

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

