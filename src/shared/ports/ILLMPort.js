/**
 * ILLMPort — Interfaz para adaptadores de Large Language Models.
 *
 * Define el contrato que deben implementar OpenAI, Anthropic, local models, etc.
 */
export class ILLMPort {
    /**
     * Indica si el adaptador está disponible.
     * @returns {boolean}
     */
    isAvailable() {
        throw new Error('ILLMPort.isAvailable() not implemented');
    }

    /**
     * Genera una respuesta de texto dado un prompt.
     * @param {object} options
     * @param {string} options.prompt — Prompt del usuario.
     * @param {string} [options.systemPrompt] — System prompt.
     * @param {Array<{role: string, content: string}>} [options.messages] — Historial de mensajes.
     * @param {number} [options.maxTokens] — Tokens máximos.
     * @param {number} [options.temperature] — Temperatura (0-2).
     * @returns {Promise<{content: string, usage: {promptTokens: number, completionTokens: number}}>}
     */
    async complete({ prompt, systemPrompt, messages, maxTokens, temperature }) {
            throw new Error('ILLMPort.complete() not implemented');
        }
        /**
         * Genera embeddings para un texto.
         * @param {string} text
         * @returns {Promise<number[]>}
         */
    async embed(text) {
        throw new Error('ILLMPort.embed() not implemented');
    }
}

export default ILLMPort;