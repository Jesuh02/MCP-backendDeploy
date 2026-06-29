import { ValidationError } from '../../shared/errors/index.js';

export class FilePreviewController {
    constructor({ filePreviewService }) {
        this.filePreviewService = filePreviewService;
    }

    getPreview = async(req, res, next) => {
        try {
            const payload = this._normalizePayload(req.body);
            const result = await this.filePreviewService.getPdfPreview(payload);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) {
            next(err);
        }
    };

    _normalizePayload(body) {
        const fileUri = typeof body?.fileUri === 'string' ? body.fileUri.trim() : '';
        const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
        const targetFormat = typeof body?.targetFormat === 'string' ? body.targetFormat.trim().toLowerCase() : 'pdf';

        if (!fileUri) throw new ValidationError('fileUri es requerido');
        if (!fileName) throw new ValidationError('fileName es requerido');
        if (targetFormat !== 'pdf') throw new ValidationError('Solo se soporta targetFormat=pdf');

        return { fileUri, fileName, targetFormat };
    }
}

export default FilePreviewController;
