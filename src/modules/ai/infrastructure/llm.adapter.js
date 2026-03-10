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

export class LLMAdapter {
    constructor() {
        this._llmService = null;
        this._provider = 'none';
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
                const response = await this._llmService.generateResponse(messages, tools);
                // Return full response so callers can inspect tool_calls and metadata
                return {
                    content: response.content,
                    model: options.model || this._provider,
                    usage: response.usage_metadata || null,
                    tool_calls: response.tool_calls || response.toolCalls || null,
                    raw: response,
                };
            } catch (err) {
                console.warn(`[LLMAdapter] LLMService falló, intentando fallback remoto: ${err.message}`);
            }
        }

        // Fallback: OpenRouter API
        if (process.env.OPENROUTER_API_KEY) {
            return this._callOpenRouter(systemPrompt, userPrompt, options.model);
        }

        // Fallback: DeepSeek HTTP directo
        if (process.env.DEEPSEEK_API_KEY) {
            return this._callDeepSeekDirect(systemPrompt, userPrompt);
        }

        throw new Error('No hay proveedor LLM disponible. Configure DEEPSEEK_API_KEY u OPENROUTER_API_KEY.');
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

