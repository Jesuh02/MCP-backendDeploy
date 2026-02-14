/**
 * IGitHubPort — Puerto de salida para análisis de repositorios GitHub.
 * @interface
 */
export class IGitHubPort {
    /**
     * Analiza un repositorio de GitHub.
     * @param {string} repoUrl
     * @param {{ taskDescription?: string, prompt?: string }} options
     * @returns {Promise<{ summary: string, files: Array, languages: Object }>}
     */
    async analyzeRepository(repoUrl, options = {}) { throw new Error('Not implemented'); }

    /**
     * Obtiene el contenido de un archivo del repositorio.
     * @param {string} repoUrl
     * @param {string} filePath
     * @returns {Promise<string>}
     */
    async getFileContent(repoUrl, filePath) { throw new Error('Not implemented'); }

    /** @returns {boolean} */
    isAvailable() { throw new Error('Not implemented'); }
}
export default IGitHubPort;

