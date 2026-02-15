/**
 * ILearningContextPort — Puerto de salida para obtener contexto de aprendizaje.
 *
 * Define el contrato que cualquier adaptador debe cumplir para proveer
 * datos de temas, tareas, contenido y documentos RAG necesarios para
 * la generación de preguntas de refuerzo.
 *
 * Principio SOLID aplicado:
 *   - Interface Segregation (I): interfaz enfocada exclusivamente en
 *     la obtención de contexto de aprendizaje.
 *   - Dependency Inversion (D): el dominio depende de esta abstracción,
 *     no de implementaciones concretas de repositorios.
 */
export class ILearningContextPort {
    /**
     * Obtiene los detalles de un tema por su ID.
     * @param {number} topicId
     * @returns {Promise<{id, name, description, courseId}|null>}
     */
    async getTopicById(topicId) {
        throw new Error('ILearningContextPort.getTopicById not implemented');
    }

    /**
     * Obtiene los detalles de una tarea por su ID.
     * @param {number} taskId
     * @returns {Promise<{id, title, description, topicId}|null>}
     */
    async getTaskById(taskId) {
        throw new Error('ILearningContextPort.getTaskById not implemented');
    }

    /**
     * Obtiene los content_items asociados a una tarea.
     * @param {number} taskId
     * @returns {Promise<Array<{id, title, body, contentType, taskId}>>}
     */
    async getContentItemsByTask(taskId) {
        throw new Error('ILearningContextPort.getContentItemsByTask not implemented');
    }

    /**
     * Obtiene los content_items asociados a un tema.
     * @param {number} topicId
     * @returns {Promise<Array<{id, title, body, contentType, topicId}>>}
     */
    async getContentItemsByTopic(topicId) {
        throw new Error('ILearningContextPort.getContentItemsByTopic not implemented');
    }

    /**
     * Obtiene el contenido RAG procesado (texto completo de rag_documents).
     * @param {{courseId, topicId?, taskId?}} filter
     * @returns {Promise<{content: string, chunks: number, files: string[]}>}
     */
    async getRagContent(filter) {
            throw new Error('ILearningContextPort.getRagContent not implemented');
        }
        /**
         * Verifica si el contenido RAG ya fue ingestado.
         * @param {{courseId, topicId?, taskId?}} filter
         * @returns {Promise<boolean>}
         */
    async isRagContentIngested(filter) {
        throw new Error('ILearningContextPort.isRagContentIngested not implemented');
    }

    /**
     * Ingesta contenido de un documento en el vector store.
     * @param {string} content
     * @param {object} metadata
     * @returns {Promise<{success, chunksStored, skipped?}>}
     */
    async ingestDocument(content, metadata) {
        throw new Error('ILearningContextPort.ingestDocument not implemented');
    }

    /**
     * Obtiene preguntas existentes para deduplicación.
     * @param {number} userId
     * @param {number} courseId
     * @param {number|null} topicId
     * @param {number|null} taskId
     * @returns {Promise<Array<{question, options, correctIndex, explanation}>>}
     */
    async getExistingQuestions(userId, courseId, topicId, taskId) {
        throw new Error('ILearningContextPort.getExistingQuestions not implemented');
    }
}

export default ILearningContextPort;
