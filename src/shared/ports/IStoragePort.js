/**
 * IStoragePort — Interfaz (contrato) para adaptadores de almacenamiento de archivos.
 *
 * Define los métodos que CUALQUIER implementación de storage debe proveer.
 * El dominio solo conoce esta interfaz — nunca depende de R2, S3, GCS directamente.
 *
 * Principio: DIP (Dependency Inversion) + OCP (Open/Closed)
 *   - Para cambiar de R2 a S3, solo implementas esta interfaz.
 *   - No necesitas tocar dominio ni container (solo el wiring).
 */
export class IStoragePort {
    /**
     * Indica si el adaptador está disponible y configurado.
     * @returns {boolean}
     */
    isAvailable() {
        throw new Error('IStoragePort.isAvailable() not implemented');
    }

    /**
     * Sube un archivo.
     * @param {Buffer} content — Contenido del archivo.
     * @param {string} key — Key/ruta en el bucket.
     * @param {string} contentType — MIME type.
     * @returns {Promise<string>} URL pública del archivo.
     */
    async uploadFile(content, key, contentType) {
        throw new Error('IStoragePort.uploadFile() not implemented');
    }

    /**
     * Genera una URL firmada para subir un archivo (presigned PUT).
     * @param {string} key
     * @param {string} contentType
     * @param {number} [expiresIn=3600]
     * @returns {Promise<string>}
     */
    async generateUploadUrl(key, contentType, expiresIn) {
        throw new Error('IStoragePort.generateUploadUrl() not implemented');
    }

    /**
     * Genera una URL firmada para descargar un archivo (presigned GET).
     * @param {string} key
     * @param {number} [expiresIn=300]
     * @returns {Promise<string>}
     */
    async generateDownloadUrl(key, expiresIn) {
        throw new Error('IStoragePort.generateDownloadUrl() not implemented');
    }

    /**
     * Elimina un archivo del bucket.
     * @param {string} key
     * @returns {Promise<boolean>}
     */
    async deleteFile(key) {
            throw new Error('IStoragePort.deleteFile() not implemented');
        }
        /**
         * Lista archivos bajo un prefijo.
         * @param {string} prefix
         * @param {number} [maxKeys=100]
         * @returns {Promise<Array<{key: string, size: number, lastModified: Date, url: string}>>}
         */
    async listFiles(prefix, maxKeys) {
        throw new Error('IStoragePort.listFiles() not implemented');
    }

    /**
     * Obtiene un stream legible de un archivo (sin cargar en memoria).
     * @param {string} key
     * @returns {Promise<{body: ReadableStream, contentType: string, contentLength: number|undefined}>}
     */
    async getFileStream(key) {
        throw new Error('IStoragePort.getFileStream() not implemented');
    }

    /**
     * Obtiene la URL pública (sin firmar) de un archivo.
     * @param {string} key
     * @returns {string}
     */
    getPublicUrl(key) {
        throw new Error('IStoragePort.getPublicUrl() not implemented');
    }

    /**
     * Extrae el object key de una URL completa.
     * @param {string} url
     * @returns {string|null}
     */
    extractObjectKey(url) {
        throw new Error('IStoragePort.extractObjectKey() not implemented');
    }
}

export default IStoragePort;