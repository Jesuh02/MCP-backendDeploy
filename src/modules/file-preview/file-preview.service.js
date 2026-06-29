import crypto from 'crypto';
import path from 'path';
import { Result } from '../../shared/Result.js';
import { AppError, ValidationError, NotFoundError } from '../../shared/errors/index.js';

const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.ppt', '.pptx']);
const MAX_PREVIEW_SOURCE_BYTES = Number(process.env.FILE_PREVIEW_MAX_BYTES || 80 * 1024 * 1024);

export class FilePreviewDomainService {
    constructor({ fileStoragePort, pdfConverter }) {
        this.storage = fileStoragePort;
        this.pdfConverter = pdfConverter;
    }

    async getPdfPreview({ fileUri, fileName }) {
        if (!this.storage) {
            return Result.fail(new AppError('Storage no disponible', 503, true, 'STORAGE_UNAVAILABLE'));
        }
        if (!this.pdfConverter) {
            return Result.fail(new AppError('Conversor PDF no disponible', 503, true, 'PDF_CONVERTER_UNAVAILABLE'));
        }

        const extension = path.extname(fileName || fileUri).toLowerCase();
        if (!OFFICE_EXTENSIONS.has(extension)) {
            return Result.fail(new ValidationError('Solo se soportan archivos Word o PowerPoint para conversion PDF'));
        }

        const sourceKey = this._resolveStorageKey(fileUri);
        if (!sourceKey) {
            return Result.fail(new ValidationError('No se pudo resolver la clave del archivo en storage'));
        }

        const previewKey = this._buildPreviewKey({ fileUri, fileName, extension });
        const cached = await this._getCachedPreview(previewKey);
        if (cached) return Result.ok(cached);

        let source;
        try {
            source = await this.storage.fetchFile(sourceKey);
        } catch (err) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                return Result.fail(new NotFoundError('Archivo'));
            }
            throw err;
        }

        if (!source?.buffer || source.buffer.length === 0) {
            return Result.fail(new NotFoundError('Archivo'));
        }
        if (source.buffer.length > MAX_PREVIEW_SOURCE_BYTES) {
            return Result.fail(new ValidationError('El archivo excede el tamano maximo para previsualizacion'));
        }

        let pdfBuffer;
        try {
            pdfBuffer = await this.pdfConverter.convertToPdf({
                buffer: source.buffer,
                fileName,
            });
        } catch (err) {
            return Result.fail(new AppError(
                `No se pudo convertir el archivo a PDF: ${err.message}`,
                422,
                true,
                'PDF_CONVERSION_FAILED',
            ));
        }

        await this.storage.uploadFile(pdfBuffer, previewKey, 'application/pdf', pdfBuffer.length);

        return Result.ok(this._buildPreviewResponse(previewKey, false));
    }

    async _getCachedPreview(previewKey) {
        try {
            await this.storage.fetchFile(previewKey);
            return this._buildPreviewResponse(previewKey, true);
        } catch (err) {
            if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
            return null;
        }
    }

    _buildPreviewResponse(previewKey, cached) {
        return {
            previewUrl: previewKey,
            previewKey,
            status: 'ready',
            cached,
        };
    }

    _buildPreviewKey({ fileUri, fileName, extension }) {
        const hash = crypto
            .createHash('sha256')
            .update(`${fileUri}|${fileName}|pdf`)
            .digest('hex')
            .slice(0, 32);
        const baseName = path.basename(fileName, extension)
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'archivo';
        return `previews/pdf/${hash}_${baseName}.pdf`;
    }

    _resolveStorageKey(fileUri) {
        const raw = String(fileUri || '').trim();
        if (!raw || raw.startsWith('file:///')) return null;

        const publicProxyKey = this._extractPublicProxyKey(raw);
        if (publicProxyKey) return publicProxyKey;

        if (/^https?:\/\//i.test(raw)) {
            const r2Key = this.storage.extractObjectKey?.(raw);
            return r2Key || null;
        }

        return raw.replace(/^\/+/, '');
    }

    _extractPublicProxyKey(value) {
        try {
            const parsed = /^https?:\/\//i.test(value)
                ? new URL(value)
                : new URL(value, 'http://coursev.local');
            const marker = '/public/files/';
            const idx = parsed.pathname.indexOf(marker);
            if (idx < 0) return null;
            return decodeURIComponent(parsed.pathname.slice(idx + marker.length));
        } catch {
            return null;
        }
    }
}

export default FilePreviewDomainService;
