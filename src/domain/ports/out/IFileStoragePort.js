/**
 * IFileStoragePort — Puerto de salida para almacenamiento de archivos.
 *
 * Define el contrato que todo adaptador de storage debe cumplir.
 * El dominio depende de esta abstracción, no de R2, S3, etc.
 *
 * @interface
 */
export class IFileStoragePort {
    // ── Core CRUD ────────────────────────────────────────────
    async generateUploadUrl(key, contentType, expiresIn) { throw new Error('Not implemented'); }
    async generateDownloadUrl(key, expiresIn) { throw new Error('Not implemented'); }
    async uploadFile(buffer, key, contentType) { throw new Error('Not implemented'); }
    async deleteFile(key) { throw new Error('Not implemented'); }
    async listFiles(prefix, maxKeys) { throw new Error('Not implemented'); }
    async fetchFile(key) { throw new Error('Not implemented'); }
    getPublicUrl(key) { throw new Error('Not implemented'); }
    isAvailable() { throw new Error('Not implemented'); }

    // ── Utilities ────────────────────────────────────────────
    sanitizeFileName(name) { throw new Error('Not implemented'); }
    extractObjectKey(url) { throw new Error('Not implemented'); }
    isTextFile(fileName) { throw new Error('Not implemented'); }
    getFileTypeFromName(fileName) { throw new Error('Not implemented'); }

    // ── Upload Helpers ───────────────────────────────────────
    async uploadBufferWithAutoKey(buffer, originalFilename, contentType, prefix) { throw new Error('Not implemented'); }

    // ── Content Retrieval ────────────────────────────────────
    async downloadFromPublicUrl(url, fileName) { throw new Error('Not implemented'); }
    async getSubmissionFileContent(fileUri, fileName, submissionId) { throw new Error('Not implemented'); }

    // ── HLS Video Streaming ──────────────────────────────────
    async uploadHLSDirectory(localDir, baseKey) { throw new Error('Not implemented'); }
    getHLSMasterPlaylistUrl(username, videoId) { throw new Error('Not implemented'); }
    async hasHLSVersion(username, videoId) { throw new Error('Not implemented'); }
    async getVideoStreamingInfo(username, videoId, directUrl) { throw new Error('Not implemented'); }
    async deleteHLSFiles(username, videoId) { throw new Error('Not implemented'); }
}
export default IFileStoragePort;

