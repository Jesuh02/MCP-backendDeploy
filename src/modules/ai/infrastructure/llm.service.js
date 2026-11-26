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

/**
 * Returns true when an LLM message has no meaningful content — empty string,
 * whitespace, or just an empty Markdown code fence (e.g. ```json\n``` ). Used to
 * detect degenerate primary responses so we can fail over to the fallback model.
 * @param {unknown} content
 * @returns {boolean}
 */
function isBlankModelContent(content) {
    if (content == null) return true;
    const text = (typeof content === 'string' ? content : String(content))
        .replace(/```[a-zA-Z0-9]*\s*```/g, '') // strip empty fenced blocks
        .replace(/```/g, '')
        .trim();
    return text.length === 0;
}

function isAuthenticationError(error) {
    const status = Number(error?.status || error?.response?.status || error?.code);
    const message = String(error?.message || error?.error?.message || error?.response?.data?.error?.message || '').toLowerCase();
    const lcCode = String(error?.lc_error_code || error?.response?.data?.error?.code || '').toLowerCase();
    return status === 401 ||
        status === 403 ||
        lcCode.includes('model_authentication') ||
        message.includes('user not found') ||
        message.includes('authentication') ||
        message.includes('unauthorized') ||
        message.includes('invalid api key') ||
        message.includes('incorrect api key');
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
        this.tertiaryModel = null;
        this.provider = 'none';
        this.primaryProvider = 'none';
        this.fallbackProvider = 'none';
        this.tertiaryProvider = 'none';
        this._initialized = false;
        this._initPromise = null;
        LLMService.instance = this;
    }

    /**
     * Initializes the LLM providers lazily on first use.
     * Primary: Qwen3.6 Plus via OpenRouter.
     * Fallback: DeepSeek via DeepSeek API (used when primary fails or times out).
     */
    async _ensureInitialized() {
        if (this._initialized) return;
        // Use a shared promise so concurrent callers all await the same init
        // instead of racing past the guard before this.model is assigned.
        if (!this._initPromise) {
            this._initPromise = this._doInit();
        }
        return this._initPromise;
    }

    async _doInit() {
        await ensureLangChainLoaded();

        // ── PRIMARY MODEL: OpenAI (SMART) ──────────────────────────────────────
        // Modelo inteligente para consultas a BD, tool-calling, quiz y grading.
        // Un modelo pequeño (SMALL) se construye aparte para tareas simples y se
        // elige por request en generateResponse().
        const openAiApiKey = process.env.OPENAI_API_KEY;
        const openAiBaseURL = process.env.OPENAI_BASE_URL; // opcional; vacío => default del SDK
        if (openAiApiKey && ChatOpenAI) {
            const smartModelName = process.env.OPENAI_MODEL_SMART || 'gpt-4o';
            const smallModelName = process.env.OPENAI_MODEL_SMALL || 'gpt-4o-mini';
            console.log(`🧠 Initializing PRIMARY model: OpenAI ${smartModelName} (SMART) + ${smallModelName} (SMALL) ...`);
            this.primaryProvider = 'openai';
            this.primaryModel = new ChatOpenAI({
                openAIApiKey: openAiApiKey,
                ...(openAiBaseURL ? { configuration: { baseURL: openAiBaseURL } } : {}),
                modelName: smartModelName,
                temperature: 0.3,
                timeout: 300000,
                maxRetries: 2,
            });
            // Modelo pequeño para tareas simples (texto, formateo, Q&A sin tools).
            this.smallModel = new ChatOpenAI({
                openAIApiKey: openAiApiKey,
                ...(openAiBaseURL ? { configuration: { baseURL: openAiBaseURL } } : {}),
                modelName: smallModelName,
                temperature: 0.3,
                timeout: 120000,
                maxRetries: 2,
            });
        }

        // OpenRouter y DeepSeek fueron retirados del chat: OpenAI es el único
        // proveedor de chat/razonamiento. (OpenRouter solo se conserva para
        // embeddings en embedding.service.js.)

        // ── Set active model: OpenAI primary; Ollama como último recurso local ─
        if (this.primaryModel) {
            this.model = this.primaryModel;
            this.provider = this.primaryProvider;
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
        this._initialized = true;
    }

    async testConnection() {
        await this._ensureInitialized();
        if (!this.model) return { status: 'disabled', error: 'Model not initialized' };
        try {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection test timeout')), 30000)
            );
            await Promise.race([this.model.invoke("Hello"), timeoutPromise]);
            const openAiSmart = process.env.OPENAI_MODEL_SMART || 'gpt-4o';
            const openAiSmall = process.env.OPENAI_MODEL_SMALL || 'gpt-4o-mini';
            const primaryModelName = this.provider === 'openai' ? openAiSmart : 'llama3:8b';
            return {
                status: 'connected',
                provider: this.provider,
                model: primaryModelName,
                smallModel: this.smallModel ? openAiSmall : null,
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
    async _invokeWithFallback(invokeFn, opts = {}) {
        const DEFAULT_PRIMARY_TIMEOUT_MS = 300000; // 300s (5 min) — allow the primary model time to respond
        // Allow callers (e.g. ChatBot, DatabaseQuery, WhatsApp) to shorten the
        // primary-model timeout so the request fails over faster.
        const PRIMARY_TIMEOUT_MS = Number.isFinite(opts.primaryTimeoutMs) && opts.primaryTimeoutMs > 0
            ? opts.primaryTimeoutMs
            : DEFAULT_PRIMARY_TIMEOUT_MS;
        // Routing: a simple-task caller may request the SMALL OpenAI model.
        // Only honored when a dedicated small model exists (OpenAI configured).
        const preferSmall = opts.preferSmall === true && this.smallModel;
        const primaryModelName = process.env.OPENAI_MODEL_SMART || 'gpt-4o';
        const smallModelName = process.env.OPENAI_MODEL_SMALL || 'gpt-4o-mini';

        // SMALL path: for simple tasks, try the cheaper OpenAI model first.
        // On any error, fall through to the SMART primary below.
        if (preferSmall) {
            try {
                const startTime = Date.now();
                const result = await invokeFn(this.smallModel);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`✅ RESPONDIÓ: OpenAI ${smallModelName} (SMALL) en ${elapsed}s`);
                return result;
            } catch (smallErr) {
                console.warn(`⚠️ OpenAI ${smallModelName} (SMALL) FALLÓ: ${smallErr.message}. Reintentando con el modelo inteligente (SMART)...`);
            }
        }

        // SMART path: single OpenAI provider (con Ollama local como último recurso
        // si es el único modelo disponible). Sin DeepSeek ni OpenRouter.
        if (this.primaryModel) {
            try {
                const startTime = Date.now();
                const result = await Promise.race([
                    invokeFn(this.primaryModel),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Primary model timeout (${Math.round(PRIMARY_TIMEOUT_MS / 1000)}s)`)), PRIMARY_TIMEOUT_MS)
                    ),
                ]);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`✅ RESPONDIÓ: ${primaryModelName} (${this.primaryProvider}) en ${elapsed}s`);
                return result;
            } catch (primaryErr) {
                // Sin proveedor secundario: si existe Ollama local como this.model
                // distinto del primary, intentarlo; si no, propagar el error.
                if (this.model && this.model !== this.primaryModel) {
                    console.warn(`⚠️ ${primaryModelName} FALLÓ: ${primaryErr.message}. Intentando modelo local (Ollama)...`);
                    const startTime = Date.now();
                    const result = await invokeFn(this.model);
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    console.log(`✅ RESPONDIÓ: Ollama local en ${elapsed}s (fallback)`);
                    return result;
                }
                throw primaryErr;
            }
        }

        // Only one model available (e.g. solo Ollama)
        if (!this.model) throw new Error('LLM disabled');
        const singleModelName = this.provider === 'openai' ? primaryModelName : 'ollama';
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
        const fallbackOpts = Number.isFinite(opts.primaryTimeoutMs) && opts.primaryTimeoutMs > 0
            ? { primaryTimeoutMs: opts.primaryTimeoutMs }
            : {};
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

            // If no tools, just invoke directly.
            // Simple task (no tools) → prefer the SMALL OpenAI model unless the
            // caller explicitly forces the smart model via opts.forceSmart.
            if (!tools || tools.length === 0) {
                const simpleOpts = opts.forceSmart ? fallbackOpts : { ...fallbackOpts, preferSmall: true };
                const response = await this._invokeWithFallback(model => model.invoke(sanitizedMessages), simpleOpts);

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

            const response = await this._invokeWithFallback(async (model) => {
                // OpenAI soporta tool_choice de forma nativa.
                const bindOpts = { tools: formattedTools, tool_choice: toolChoice };
                try {
                    const modelWithTools = model.bind(bindOpts);
                    return await modelWithTools.invoke(sanitizedMessages);
                } catch (bindErr) {
                    // For non-OpenRouter providers that still reject tool_choice, retry without it.
                    if (
                        bindOpts.tool_choice &&
                        bindErr.message &&
                        (bindErr.message.includes('tool_choice') || bindErr.status === 404)
                    ) {
                        console.warn(
                            `[LLMService] tool_choice rejected by model, retrying without it: ${bindErr.message}`
                        );
                        const modelWithoutChoice = model.bind({ tools: formattedTools });
                        return await modelWithoutChoice.invoke(sanitizedMessages);
                    }
                    throw bindErr;
                }
            }, fallbackOpts);

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

            // Detect a degenerate response: no tool_calls AND blank/empty content.
            const primaryNoToolCalls = !response.tool_calls || response.tool_calls.length === 0;
            const primaryContentBlank = isBlankModelContent(response.content);

            // Retry with the SMART model (tool_choice forced) when either:
            //   • toolChoice was 'required' but the model returned no tool_calls, or
            //   • the model returned no tool_calls AND empty content.
            // (Útil cuando el primer intento fue el SMALL o no invocó la tool.)
            if (
                this.primaryModel &&
                primaryNoToolCalls &&
                (toolChoice === 'required' || primaryContentBlank)
            ) {
                const retryToolChoice = toolChoice === 'required' ? 'required' : 'auto';
                console.warn(`[LLMService] Sin tool_calls${primaryContentBlank ? ' y contenido vacío' : ''} — reintentando con el modelo SMART, tool_choice=${retryToolChoice}`);
                try {
                    const retryResponse = await this.primaryModel
                        .bind({ tools: formattedTools, tool_choice: retryToolChoice })
                        .invoke(sanitizedMessages);
                    console.log('\n📤 [LLM RESPONSE (TOOL RETRY WITH SMART)] -------------------');
                    console.log('OUTPUT CONTENT:', retryResponse.content);
                    const retryHasToolCalls = retryResponse.tool_calls && retryResponse.tool_calls.length > 0;
                    if (retryHasToolCalls) {
                        console.log('TOOL CALLS:', JSON.stringify(retryResponse.tool_calls, null, 2));
                    }
                    console.log('------------------------------------------------------------\n');
                    // Accept the retry when it produced tool calls or real (non-blank) content.
                    if (retryHasToolCalls || !isBlankModelContent(retryResponse.content)) {
                        return retryResponse;
                    }
                    console.log('⚠️ Reintento SMART también vacío — usando la respuesta original');
                } catch (retryErr) {
                    console.warn('[LLMService] Reintento con SMART falló:', retryErr.message, '— devolviendo respuesta original');
                }
            }

            return response;
        } catch (error) {
            console.error("Error generating LLM response:", error);

            // If the error is about tool_calls, try without tools
            if (error.message && error.message.includes('tool_calls')) {
                console.warn("Tool call error detected, retrying without tools...");
                try {
                    const sanitizedMessages = this.sanitizeMessages(messages);
                    const response = await this._invokeWithFallback(model => model.invoke(sanitizedMessages), fallbackOpts);

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

