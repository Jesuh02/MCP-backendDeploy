/**
 * RAGDomainService — Caso de uso para Retrieval-Augmented Generation.
 *
 * Depende de IRAGPort y ILLMPort (puertos de salida).
 * NO importa nada de infraestructura.
 *
 * Principios:
 *   - SRP: orquesta ingesta, búsqueda y construcción de contexto RAG
 *   - DIP: depende de puertos abstractos
 */

import { Result } from '../../shared/Result.js';
import { ValidationError, NotFoundError } from '../../shared/errors/index.js';

export class RAGDomainService {
    constructor({ ragPort, llmPort }) {
        this.rag = ragPort;
        this.llm = llmPort;
    }

    /**
     * Obtiene estado del servicio RAG.
     * @returns {Promise<Result>}
     */
    async getStatus() {
        try {
            const status = await this.rag.getStatus();
            return Result.ok(status);
        } catch (err) {
            return Result.fail(new ValidationError(`Estado RAG no disponible: ${err.message}`));
        }
    }

    /**
     * Ingesta un documento en el knowledge base.
     * @param {{ content: string, metadata?: Object, courseId?: number }} params
     * @returns {Promise<Result>}
     */
    async ingest({ content, metadata, courseId }) {
        if (!content || content.trim().length === 0) {
            return Result.fail(new ValidationError('El contenido del documento es requerido'));
        }

        try {
            const result = await this.rag.ingest({ content, metadata, courseId });
            return Result.ok(result);
        } catch (err) {
            return Result.fail(new ValidationError(`Ingesta RAG falló: ${err.message}`));
        }
    }

    /**
     * Busca documentos relevantes.
     * @param {{ query: string, limit?: number, courseId?: number, threshold?: number }} params
     * @returns {Promise<Result>}
     */
    async search({ query, limit, courseId, threshold }) {
        if (!query || query.trim().length === 0) {
            return Result.fail(new ValidationError('La query de búsqueda es requerida'));
        }

        try {
            const results = await this.rag.search(query, { limit, courseId, threshold });
            return Result.ok(results);
        } catch (err) {
            return Result.fail(new ValidationError(`Búsqueda RAG falló: ${err.message}`));
        }
    }

    /**
     * Construye contexto para LLM.
     * @param {{ query: string, courseId?: number, maxTokens?: number }} params
     * @returns {Promise<Result>}
     */
    async buildContext({ query, courseId, maxTokens }) {
        if (!query || query.trim().length === 0) {
            return Result.fail(new ValidationError('La query es requerida'));
        }

        try {
            const context = await this.rag.buildContext(query, { courseId, maxTokens });
            return Result.ok({ context });
        } catch (err) {
            return Result.fail(new ValidationError(`Construcción de contexto falló: ${err.message}`));
        }
    }
}
export default RAGDomainService;

