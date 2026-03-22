/**
 * ISP — Segregación del IStoragePort en interfaces más pequeñas.
 *
 * El IStoragePort original tiene ~8 métodos. Los servicios que solo leen
 * archivos no necesitan conocer uploadFile/deleteFile y viceversa.
 *
 * Segregamos en:
 *   - IFileUploader  → uploadFile, generateUploadUrl, deleteFile
 *   - IFileReader    → getFileStream, generateDownloadUrl, getPublicUrl, listFiles, extractObjectKey
 *
 * IStoragePort sigue existiendo como la unión de ambos (backward-compatible).
 * Los nuevos servicios deberían depender de la interfaz más pequeña posible.
 */

/**
 * IFileUploader — Solo operaciones de escritura/eliminación.
 */
export class IFileUploader {
    async uploadFile(content, key, contentType) {
        throw new Error('IFileUploader.uploadFile() not implemented');
    }

    async generateUploadUrl(key, contentType, expiresIn) {
        throw new Error('IFileUploader.generateUploadUrl() not implemented');
    }

    async deleteFile(key) {
        throw new Error('IFileUploader.deleteFile() not implemented');
    }

    isAvailable() {
        throw new Error('IFileUploader.isAvailable() not implemented');
    }
}

/**
 * IFileReader — Solo operaciones de lectura/descarga.
 */
export class IFileReader {
    async getFileStream(key) {
        throw new Error('IFileReader.getFileStream() not implemented');
    }

    async generateDownloadUrl(key, expiresIn) {
        throw new Error('IFileReader.generateDownloadUrl() not implemented');
    }

    getPublicUrl(key) {
        throw new Error('IFileReader.getPublicUrl() not implemented');
    }

    async listFiles(prefix, maxKeys) {
        throw new Error('IFileReader.listFiles() not implemented');
    }

    extractObjectKey(url) {
        throw new Error('IFileReader.extractObjectKey() not implemented');
    }
}