/**
 * motion-detector.js — Estimación ligera de movimiento entre frames.
 *
 * Estrategia: para cada frame se calcula un thumbnail 16x16 en escala de
 * grises (256 muestras). El "motion score" entre dos frames es el promedio
 * de la diferencia absoluta por píxel, normalizado a [0, 1]:
 *
 *     score = sum(|a_i - b_i|) / (N * 255)
 *
 * Es estable frente a ruido de cámara, no requiere modelos pesados, y se
 * computa en < 5 ms por frame en Node (decode + resize via RawImage).
 *
 * Cuando el frontend envía la cámara a ~3 fps, esto basta para distinguir:
 *   - mano quieta deletreando letra/número (score < 0.015)
 *   - gesto dinámico ejecutando palabra/frase (score > 0.030, picos > 0.08)
 *   - reposicionamiento entre letras (score ~ 0.02-0.05 pero corto)
 */

import { detectMime } from './letter-classifier.js';

const THUMB_SIZE = 16;
const THUMB_PIXELS = THUMB_SIZE * THUMB_SIZE;

/**
 * Decodifica el buffer, lo redimensiona a 16x16 y promedia canales para
 * obtener un thumbnail en gris (Uint8Array de longitud 256).
 *
 * @param {Buffer} buffer
 * @returns {Promise<Uint8Array>}
 */
export async function computeThumbnail(buffer) {
    const { RawImage } = await import('@huggingface/transformers');
    const mime = detectMime(buffer);
    const blob = new Blob([buffer], { type: mime });
    const image = await RawImage.fromBlob(blob);
    const small = await image.resize(THUMB_SIZE, THUMB_SIZE);

    const channels = small.channels || 3;
    const data = small.data;
    const out = new Uint8Array(THUMB_PIXELS);

    if (channels === 1) {
        for (let i = 0; i < THUMB_PIXELS; i++) out[i] = data[i] | 0;
    } else {
        // Promedia los tres primeros canales (R,G,B). Ignora alfa si existe.
        for (let i = 0; i < THUMB_PIXELS; i++) {
            const base = i * channels;
            out[i] = ((data[base] + data[base + 1] + data[base + 2]) / 3) | 0;
        }
    }
    return out;
}

/**
 * Devuelve un score de movimiento en [0, 1] entre dos thumbnails.
 * Si alguno es null o tienen tamaños distintos devuelve 1 (máximo).
 *
 * @param {Uint8Array|null} prev
 * @param {Uint8Array|null} current
 * @returns {number}
 */
export function motionScore(prev, current) {
    if (!prev || !current || prev.length !== current.length) return 1;
    let sum = 0;
    for (let i = 0; i < prev.length; i++) {
        const d = prev[i] - current[i];
        sum += d < 0 ? -d : d;
    }
    return sum / (prev.length * 255);
}

export default { computeThumbnail, motionScore };
