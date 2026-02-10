/**
 * IFileStoragePort — Puerto de salida para almacenamiento de archivos (R2).
 * @interface
 */
export class IFileStoragePort {
    async generateUploadUrl(key, contentType, expiresIn) { throw new Error('Not implemented'); }
    async generateDownloadUrl(key, expiresIn) { throw new Error('Not implemented'); }
    async uploadFile(buffer, key, contentType) { throw new Error('Not implemented'); }
    async deleteFile(key) { throw new Error('Not implemented'); }
    async listFiles(prefix, maxKeys) { throw new Error('Not implemented'); }
    async fetchFile(key) { throw new Error('Not implemented'); }
    getPublicUrl(key) { throw new Error('Not implemented'); }
    isAvailable() { throw new Error('Not implemented'); }
}
export default IFileStoragePort;