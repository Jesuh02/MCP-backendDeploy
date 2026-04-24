// Almacén de imágenes local (MVP). Implementa ImageStoragePort.
// Guarda cada imagen bajo data/icfes_images/<key>.<ext> y devuelve una URL
// configurable por ICFES_IMAGE_BASE_URL (ideal: CDN Cloudflare R2).

import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

export function createLocalImageStorage({
  root = 'data/icfes_images',
  baseUrl = process.env.ICFES_IMAGE_BASE_URL || `file://${process.cwd().replace(/\\/g,'/')}/data/icfes_images`,
} = {}) {
  return {
    /**
     * @param {Uint8Array} bytes
     * @param {'png'|'jpg'} ext
     * @param {string} key
     */
    async save(bytes, ext, key) {
      const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 12)
      const safeKey = key.replace(/[^\w-]+/g, '_').slice(0, 80)
      const rel = `${safeKey}_${hash}.${ext}`
      const abs = join(root, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, bytes)
      return `${baseUrl.replace(/\/+$/,'')}/${rel}`
    },
  }
}
