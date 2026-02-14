/**
 * ILLMPort — Puerto de salida para modelos de lenguaje (LLM).
 * Abstrae DeepSeek, OpenRouter, Ollama, etc.
 * @interface
 */
export class ILLMPort {
    /**
     * Genera una respuesta de chat usando el modelo LLM.
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {{ model?: string, maxTokens?: number, temperature?: number }} options
     * @returns {Promise<{ content: string, model: string, usage?: Object }>}
     */
    async chat(systemPrompt, userPrompt, options = {}) { throw new Error('Not implemented'); }

    /**
     * Genera embeddings para un texto.
     * @param {string} text
     * @param {{ model?: string }} options
     * @returns {Promise<number[]>}
     */
    async embed(text, options = {}) { throw new Error('Not implemented'); }

    /**
     * Verifica disponibilidad del servicio LLM.
     * @returns {Promise<boolean>}
     */
    async isAvailable() { throw new Error('Not implemented'); }

    /**
     * Obtiene modelo actual.
     * @returns {string}
     */
    getCurrentModel() { throw new Error('Not implemented'); }
}
export default ILLMPort;

