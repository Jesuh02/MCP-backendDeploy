/**
 * ImageOCRService — Extrae texto de imágenes usando tesseract.js.
 *
 * DeepSeek no soporta visión nativa, así que usamos OCR para convertir
 * imágenes a texto y luego enviamos el texto al LLM.
 */

import Tesseract from 'tesseract.js';

export class ImageOCRService {
    /**
     * Extrae texto legible de una imagen en base64.
     * @param {string} base64 - Imagen en base64 (con o sin prefijo data:image/...)
     * @returns {Promise<string>} Texto extraído (puede estar vacío)
     */
    static async extractText(base64) {
        if (!base64 || typeof base64 !== 'string') {
            return '';
        }

        // Strip data URI prefix if present
        const raw = base64.replace(/^data:image\/[a-z+]+;base64,/i, '');

        // Validate base64 content
        if (raw.length < 100) {
            console.warn('[ImageOCRService] Base64 too short, likely invalid');
            return '';
        }

        const buffer = Buffer.from(raw, 'base64');

        try {
            const { data: { text } } = await Tesseract.recognize(buffer, 'spa+eng', {
                logger: () => {}, // suppress progress logs
            });
            return (text || '').trim();
        } catch (err) {
            console.error('[ImageOCRService] OCR failed:', err.message);
            return '';
        }
    }
}
