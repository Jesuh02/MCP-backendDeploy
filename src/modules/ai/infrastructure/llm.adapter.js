/**
 * LLMAdapter — Adaptador de infraestructura que implementa ILLMPort.
 *
 * Envuelve LLMService (DeepSeek/Ollama/OpenRouter) existente detrás de un
 * puerto abstracto. El dominio solo conoce ILLMPort.
 *
 * También implementa fallback remoto (OpenRouter / DeepSeek HTTP directo)
 * que antes estaba inline en index.js.
 */

import axios from 'axios';

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

function inferAuthProvider(error, fallback = 'unknown') {
    const message = String(error?.message || error?.response?.data?.error?.message || '').toLowerCase();
    const url = String(error?.response?.config?.url || error?.config?.url || '').toLowerCase();
    const baseUrl = String(error?.response?.config?.baseURL || error?.config?.baseURL || '').toLowerCase();
    if (url.includes('openrouter') || baseUrl.includes('openrouter') || message.includes('user not found')) return 'openrouter';
    if (url.includes('deepseek') || baseUrl.includes('deepseek')) return 'deepseek';
    return fallback;
}

export class LLMAdapter {
    constructor() {
        this._llmService = null;
        this._provider = 'none';
        this._authBlockedProviders = new Set();
        this._init();
    }

    /** @private */
    _init() {
            try {
                // Lazy-load LLMService (infraestructura existente)
                import ('./llm.service.js').then(({ LLMService }) => {
                    this._llmService = LLMService.getInstance();
                    this._provider = this._llmService.provider || 'unknown';
                    console.log(`✅ LLMAdapter: inicializado con provider ${this._provider}`);
                }).catch(err => {
                    console.warn('⚠️ LLMAdapter: LLMService no disponible:', err.message);
                });
            } catch (err) {
                console.warn('⚠️ LLMAdapter: init falló:', err.message);
            }
        }
        /**
         * Genera una respuesta de chat.
         * @param {string} systemPrompt
         * @param {string} userPrompt
         * @param {{ model?: string, maxTokens?: number, temperature?: number }} options
         * @returns {Promise<{ content: string, model: string, usage?: Object }>}
         */
    async chat(systemPrompt, userPrompt, options = {}) {
        let lastError = null;

        // Try LLMService first
        if (this._llmService) {
            try {
                // Ensure underlying LLMService finishes lazy initialization
                if (typeof this._llmService._ensureInitialized === 'function') {
                    try {
                        await this._llmService._ensureInitialized();
                    } catch (initErr) {
                        console.warn('[LLMAdapter] LLMService initialization warning:', initErr && initErr.message);
                    }
                }
                const { HumanMessage, SystemMessage } = await
                import ('@langchain/core/messages');
                const messages = [
                    new SystemMessage(systemPrompt),
                    new HumanMessage(userPrompt),
                ];
                // Forward tools from options to LLMService so the model can call them
                const tools = options.tools || [];
                const response = await this._llmService.generateResponse(messages, tools, {
                    toolChoice: options.toolChoice,
                    // Optional shorter primary-model timeout (e.g. 10s for chat UIs).
                    primaryTimeoutMs: options.primaryTimeoutMs,
                });
                // Return full response so callers can inspect tool_calls and metadata
                return {
                    content: response.content,
                    model: options.model || this._provider,
                    usage: response.usage_metadata || null,
                    tool_calls: response.tool_calls || response.toolCalls || null,
                    raw: response,
                };
            } catch (err) {
                lastError = err;
                if (isAuthenticationError(err)) {
                    const provider = inferAuthProvider(err, this._provider);
                    this._authBlockedProviders.add(provider);
                    this._llmService = null;
                    this._provider = 'none';
                    console.warn(`[LLMAdapter] LLMService authentication failed (${provider}); avoiding duplicated remote retry: ${err.message}`);
                } else {
                    console.warn(`[LLMAdapter] LLMService falló, intentando fallback remoto: ${err.message}`);
                }
            }
        }

        // Fallback: OpenRouter API
        if (process.env.OPENROUTER_API_KEY && !this._authBlockedProviders.has('openrouter')) {
            try {
                return await this._callOpenRouter(systemPrompt, userPrompt, options.model);
            } catch (err) {
                lastError = err;
                if (isAuthenticationError(err)) {
                    this._authBlockedProviders.add('openrouter');
                    console.warn(`[LLMAdapter] OpenRouter authentication failed; provider disabled until restart: ${err.message}`);
                } else {
                    console.warn(`[LLMAdapter] OpenRouter fallback failed: ${err.message}`);
                }
            }
        }

        // Fallback: DeepSeek HTTP directo
        if (process.env.DEEPSEEK_API_KEY && !this._authBlockedProviders.has('deepseek')) {
            try {
                return await this._callDeepSeekDirect(systemPrompt, userPrompt);
            } catch (err) {
                lastError = err;
                if (isAuthenticationError(err)) {
                    this._authBlockedProviders.add('deepseek');
                    console.warn(`[LLMAdapter] DeepSeek authentication failed; provider disabled until restart: ${err.message}`);
                }
                throw err;
            }
        }

        if (lastError) throw lastError;
        throw new Error('No hay proveedor LLM disponible. Configure DEEPSEEK_API_KEY u OPENROUTER_API_KEY.');
    }

    /**
     * Genera una respuesta de chat con imagen (visión).
     * DeepSeek no soporta imágenes directamente, así que usamos OCR (tesseract.js)
     * para extraer texto de la imagen y enviarlo como contexto textual a DeepSeek.
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {string} imageBase64 - Imagen en base64 (data:image/...;base64,... o raw base64)
     * @param {{ model?: string, maxTokens?: number }} options
     * @returns {Promise<{ content: string, model: string, usage?: Object }>}
     */
    async chatWithVision(systemPrompt, userPrompt, imageBase64, options = {}) {
        // Extract text from image using OCR
        let extractedText = '';
        try {
            const { ImageOCRService } = await import('./image-ocr.service.js');
            extractedText = await ImageOCRService.extractText(imageBase64);
            console.log(`[LLMAdapter] 🖼️ OCR extracted ${extractedText.length} chars from image`);
        } catch (ocrErr) {
            console.warn(`[LLMAdapter] OCR failed: ${ocrErr.message}`);
        }

        // Build enhanced prompt with image context
        let enhancedPrompt = userPrompt;
        if (extractedText && extractedText.trim().length > 0) {
            enhancedPrompt =
                `[CONTENIDO EXTRAÍDO DE LA IMAGEN ADJUNTA (vía OCR)]\n` +
                `${extractedText.trim()}\n` +
                `[FIN DEL CONTENIDO DE LA IMAGEN]\n\n` +
                `${userPrompt}`;
        } else {
            enhancedPrompt =
                `[IMAGEN ADJUNTA: El usuario adjuntó una imagen pero no se pudo extraer texto legible. ` +
                `La imagen puede contener diagramas, fotos o contenido no textual. ` +
                `Responde basándote en la pregunta del usuario y pídele que describa el contenido si necesitas más detalles.]\n\n` +
                `${userPrompt}`;
        }

        // Augment system prompt with vision instructions
        const visionSystemPrompt = systemPrompt +
            `\n\nNOTA: El usuario adjuntó una imagen. El texto extraído de la imagen (si lo hay) está incluido arriba como "[CONTENIDO EXTRAÍDO DE LA IMAGEN ADJUNTA]". ` +
            `Analiza ese contenido como si pudieras ver la imagen. Si el texto extraído parece ser una tarea o trabajo escrito, evalúalo según los criterios del contexto.`;

        return this.chat(visionSystemPrompt, enhancedPrompt, options);
    }

    /**
     * Genera embeddings (delegado a EmbeddingService).
     */
    async embed(text, options = {}) {
        try {
            const { EmbeddingService } = await
            import ('../ai/EmbeddingService.js');
            const embeddingService = new EmbeddingService();
            return await embeddingService.embed(text);
        } catch (err) {
            throw new Error(`Embedding falló: ${err.message}`);
        }
    }

    /** @returns {Promise<boolean>} */
    async isAvailable() {
        if (this._llmService) {
            const result = await this._llmService.testConnection();
            return result.status === 'connected';
        }
        return !!(process.env.DEEPSEEK_API_KEY || process.env.OPENROUTER_API_KEY);
    }

    /** @returns {string} */
    getCurrentModel() {
        return process.env.CHAT_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    }

    /** @private */
    async _callOpenRouter(systemPrompt, userPrompt, model) {
        const apiKey = process.env.OPENROUTER_API_KEY;
        const chatModel = model || process.env.OPENROUTER_CHAT_MODEL || 'qwen/qwen-2.5-72b-instruct';

        const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: chatModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 4096,
            temperature: 0.3,
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 120000,
        });

        const choice = response.data.choices?.[0];
        return {
            content: choice?.message?.content || '',
            model: chatModel,
            usage: response.data.usage || null,
        };
    }

    /** @private */
    async _callDeepSeekDirect(systemPrompt, userPrompt) {
        const apiKey = process.env.DEEPSEEK_API_KEY;
        const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
        const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

        const response = await axios.post(`${baseUrl}/v1/chat/completions`, {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 4096,
            temperature: 0.3,
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 120000,
        });

        const choice = response.data.choices?.[0];
        return {
            content: choice?.message?.content || '',
            model,
            usage: response.data.usage || null,
        };
    }
}
export default LLMAdapter;

