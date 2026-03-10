/**
 * StorageDomainService — Lógica de negocio para archivos.
 * Delega al IFileStoragePort.
 */
import { Result } from '../../shared/Result.js';
import { ValidationError, NotFoundError } from '../../shared/errors/index.js';

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
const ALLOWED_PREFIXES = ['videos', 'thumbnails', 'avatars', 'submissions', 'content', 'courses'];

export class StorageDomainService {
    constructor({ fileStoragePort }) {
        this.storage = fileStoragePort;
    }

    async getUploadUrl({ key, contentType, prefix = 'content' }) {
        if (!ALLOWED_PREFIXES.includes(prefix)) {
            return Result.fail(new ValidationError(`Prefijo no permitido. Usar: ${ALLOWED_PREFIXES.join(', ')}`));
        }
        const fullKey = key.startsWith(prefix) ? key : `${prefix}/${key}`;
        const url = await this.storage.generateUploadUrl(fullKey, contentType);
        return Result.ok({ uploadUrl: url, key: fullKey, publicUrl: this.storage.getPublicUrl(fullKey) });
    }

    async upload(buffer, key, contentType) {
        if (buffer.length > MAX_FILE_SIZE) {
            return Result.fail(new ValidationError(`Archivo excede el límite de ${MAX_FILE_SIZE / (1024 * 1024)} MB`));
        }
        const publicUrl = await this.storage.uploadFile(buffer, key, contentType);
        return Result.ok({ publicUrl, key });
    }

    async delete(key) {
        await this.storage.deleteFile(key);
        return Result.ok({ message: 'Archivo eliminado' });
    }

    async getDownloadUrl(key) {
        const url = await this.storage.generateDownloadUrl(key);
        return Result.ok({ downloadUrl: url });
    }

    async listFiles(prefix) {
        const files = await this.storage.listFiles(prefix);
        return Result.ok(files);
    }

    /**
     * Returns a readable stream for a file without loading it into memory.
     * Used by the public proxy endpoint to serve files without exposing R2 URLs.
     */
    async streamFile(key) {
        if (!key || key.includes('..') || key.startsWith('/')) {
            return Result.fail(new ValidationError('key inválido'));
        }
        try {
            const stream = await this.storage.getFileStream(key);
            return Result.ok(stream);
        } catch (err) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                return Result.fail(new NotFoundError('Archivo no encontrado'));
            }
            throw err;
        }
    }

    getPublicUrl(key) {
        return this.storage.getPublicUrl(key);
    }
}

export default StorageDomainService;

