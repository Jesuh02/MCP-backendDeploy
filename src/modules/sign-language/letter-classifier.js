/**
 * letter-classifier.js — Singleton del pipeline ONNX de alfabeto.
 *
 * Extraído de `sign-language.routes.js` para que el smart recognizer
 * (auto-frame) y los endpoints clásicos compartan exactamente la misma
 * instancia (un solo proceso de carga, una sola sesión de ONNX).
 *
 * Carga (orden de prioridad):
 *   1. Local: SIGN_LANGUAGE_MODEL_DIR (o <repo>/models/sign-language)
 *      con {config.json, preprocessor_config.json, onnx/model.onnx}.
 *   2. Remoto: SIGN_LANGUAGE_HF_REPO ("user/repo") con HF_API_TOKEN si
 *      es privado.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HF_MODEL_ID = 'prithivMLmods/Alphabet-Sign-Language-Detection';

const DEFAULT_MODEL_DIR = path.resolve(__dirname, '../../../models/sign-language');
const MODEL_DIR = process.env.SIGN_LANGUAGE_MODEL_DIR || DEFAULT_MODEL_DIR;
const HF_REPO = (process.env.SIGN_LANGUAGE_HF_REPO || '').trim();
const CACHE_DIR = process.env.SIGN_LANGUAGE_CACHE_DIR || '/tmp/transformers-cache';

let classifierPromise = null;
let loadError = null;

export async function getLetterClassifier() {
    if (loadError) throw loadError;
    if (classifierPromise) return classifierPromise;

    classifierPromise = (async () => {
        const hasLocal = ['config.json', 'preprocessor_config.json', 'onnx/model.onnx']
            .every((rel) => fs.existsSync(path.join(MODEL_DIR, rel)));

        if (!hasLocal && !HF_REPO) {
            throw new Error(
                `Falta config.json en ${MODEL_DIR} y SIGN_LANGUAGE_HF_REPO no está definido. ` +
                `Sube el ONNX a un repo HuggingFace tuyo y exporta ` +
                `SIGN_LANGUAGE_HF_REPO=tu_usuario/Alphabet-Sign-Language-ONNX, o bien ` +
                `bundlea los pesos en ${MODEL_DIR}.`,
            );
        }

        const { pipeline, env } = await import('@huggingface/transformers');

        if (hasLocal) {
            env.allowRemoteModels = false;
            env.allowLocalModels = true;
            env.localModelPath = path.dirname(MODEL_DIR);
            const modelName = path.basename(MODEL_DIR); // "sign-language"
            console.log(`[SignLanguage] Cargando pipeline LOCAL desde ${MODEL_DIR} ...`);
            const t0 = Date.now();
            const pipe = await pipeline('image-classification', modelName, { dtype: 'fp32' });
            console.log(`[SignLanguage] Pipeline listo en ${Date.now() - t0} ms`);
            return pipe;
        }

        try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }

        env.allowRemoteModels = true;
        env.allowLocalModels = false;
        env.cacheDir = CACHE_DIR;
        env.useFSCache = true;

        if (process.env.HF_API_TOKEN && !process.env.HF_TOKEN) {
            process.env.HF_TOKEN = process.env.HF_API_TOKEN;
        }

        console.log(`[SignLanguage] Cargando pipeline REMOTO desde ${HF_REPO} (cache: ${CACHE_DIR}) ...`);
        const t0 = Date.now();
        const pipe = await pipeline('image-classification', HF_REPO, { dtype: 'fp32' });
        console.log(`[SignLanguage] Pipeline listo en ${Date.now() - t0} ms`);
        return pipe;
    })().catch((err) => {
        loadError = err;
        classifierPromise = null;
        throw err;
    });

    return classifierPromise;
}

/**
 * Clasifica un buffer de imagen contra el modelo ONNX de alfabeto.
 * Devuelve `null` si el modelo no produjo predicciones; en caso contrario:
 *   { detection: {label, confidence}, alternatives: [{label, confidence}, ...] }
 */
export async function classifyLetter(imageBuffer) {
    const classifier = await getLetterClassifier();
    const { RawImage } = await import('@huggingface/transformers');

    const mime = detectMime(imageBuffer);
    const blob = new Blob([imageBuffer], { type: mime });
    const image = await RawImage.fromBlob(blob);

    const preds = await classifier(image, { top_k: 3 });
    if (!Array.isArray(preds) || preds.length === 0) return null;

    const top = preds[0];
    return {
        detection: {
            label: String(top.label ?? '').toUpperCase(),
            confidence: Number(top.score) || 0,
        },
        alternatives: preds.slice(1).map((p) => ({
            label: String(p.label ?? '').toUpperCase(),
            confidence: Number(p.score) || 0,
        })),
    };
}

/**
 * Detecta el mime-type a partir de los magic bytes (JPEG / PNG / WebP).
 */
export function detectMime(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return 'image/jpeg';
    }
    if (
        buf.length >= 8 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    ) {
        return 'image/png';
    }
    if (
        buf.length >= 12 &&
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) {
        return 'image/webp';
    }
    return 'image/jpeg';
}

export default { getLetterClassifier, classifyLetter, detectMime, HF_MODEL_ID };
