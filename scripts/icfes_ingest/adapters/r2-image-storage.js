// Adaptador Cloudflare R2 para ImageStoragePort.
//
// Sube cada imagen a un bucket R2 (compatible S3) y devuelve su URL pública.
// El nombre del objeto se deriva de `key` + un hash sha1 corto del contenido,
// lo que garantiza:
//   - idempotencia (re-ejecutar la ingesta NO duplica objetos)
//   - inmutabilidad (cualquier cambio binario produce una nueva URL)
//
// SOLID:
//   - SRP: sólo conoce de subir bytes a R2.
//   - DIP: la aplicación depende de ImageStoragePort, no de este adaptador.
//   - OCP: intercambiable con createLocalImageStorage sin tocar el caso de uso.

import {
    S3Client,
    PutObjectCommand,
    HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'

const EXT_TO_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
}

/**
 * @param {{
 *   accountId?: string,
 *   accessKeyId?: string,
 *   secretAccessKey?: string,
 *   bucket?: string,
 *   publicUrl?: string,
 *   prefix?: string,
 *   logger?: Console,
 * }} [opts]
 * @returns {{ save:(bytes:Uint8Array, ext:string, key:string)=>Promise<string> }}
 */
export function createR2ImageStorage({
    accountId = process.env.R2_ACCOUNT_ID,
    accessKeyId = process.env.R2_ACCESS_KEY_ID,
    secretAccessKey = process.env.R2_SECRET_ACCESS_KEY,
    bucket = process.env.R2_BUCKET_NAME || 'coursev-files',
    publicUrl = process.env.R2_PUBLIC_URL,
    prefix = process.env.ICFES_R2_PREFIX || 'icfes',
    logger = console,
} = {}) {
    if (!accountId || !accessKeyId || !secretAccessKey) {
        throw new Error(
            'R2 no configurado: faltan R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY',
        )
    }
    if (!publicUrl) {
        throw new Error(
            'R2_PUBLIC_URL es obligatorio (ej. https://pub-xxxxxxxx.r2.dev) para emitir URLs accesibles',
        )
    }

    const client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
        // R2 rechaza checksums automáticos del SDK de AWS.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    })
    const base = publicUrl.replace(/\/+$/, '')
    const safePrefix = prefix.replace(/^\/+|\/+$/g, '')

    async function objectExists(objectKey) {
        try {
            await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }))
            return true
        } catch (err) {
            // 404 / NotFound / NoSuchKey → no existe; cualquier otro error se propaga.
            const code = err?.$metadata?.httpStatusCode
            if (code === 404 || code === 412) return false
            if (err?.name === 'NotFound' || err?.name === 'NoSuchKey') return false
            throw err
        }
    }

    return {
        async save(bytes, ext, key) {
            const normalizedExt = (ext || 'png').toLowerCase()
            const contentType = EXT_TO_MIME[normalizedExt] || 'application/octet-stream'
            const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 12)
            const safeKey = String(key || 'image')
                .replace(/[^\w\-./]+/g, '_')
                .replace(/_+/g, '_')
                .slice(0, 120)
            const objectKey = `${safePrefix}/${safeKey}_${hash}.${normalizedExt}`
            const url = `${base}/${objectKey}`

            if (await objectExists(objectKey)) {
                return url
            }

            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: objectKey,
                Body: Buffer.from(bytes),
                ContentType: contentType,
                ContentLength: bytes.length,
                CacheControl: 'public, max-age=31536000, immutable',
            }))
            logger?.debug?.(`[icfes] r2 upload ${objectKey} (${bytes.length}B)`)
            return url
        },
    }
}

export default createR2ImageStorage
