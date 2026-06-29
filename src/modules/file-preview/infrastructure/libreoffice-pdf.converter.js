import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = Number(process.env.FILE_PREVIEW_CONVERSION_TIMEOUT_MS || 90_000);

export class LibreOfficePdfConverter {
    constructor({ bin, timeoutMs } = {}) {
        this.bin = bin || process.env.LIBREOFFICE_BIN || null;
        this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    }

    async convertToPdf({ buffer, fileName }) {
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coursev-preview-'));
        const safeName = this._safeFileName(fileName);
        const inputPath = path.join(workDir, safeName);
        const expectedPdfPath = path.join(workDir, `${path.basename(safeName, path.extname(safeName))}.pdf`);

        try {
            await fs.writeFile(inputPath, buffer);
            await this._runLibreOffice(inputPath, workDir);
            const outputPath = await this._findPdfOutput(workDir, expectedPdfPath);
            return await fs.readFile(outputPath);
        } finally {
            await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    async _runLibreOffice(inputPath, outDir) {
        const candidates = this.bin ? [this.bin] : ['libreoffice', 'soffice'];
        let lastError = null;

        for (const bin of candidates) {
            try {
                await execFileAsync(bin, [
                    '--headless',
                    '--nologo',
                    '--nofirststartwizard',
                    '--convert-to',
                    'pdf',
                    '--outdir',
                    outDir,
                    inputPath,
                ], {
                    timeout: this.timeoutMs,
                    maxBuffer: 1024 * 1024 * 8,
                    env: {
                        ...process.env,
                        HOME: outDir,
                    },
                });
                return;
            } catch (err) {
                lastError = err;
                if (err.code !== 'ENOENT') break;
            }
        }

        if (lastError?.code === 'ENOENT') {
            throw new Error('LibreOffice no esta instalado o no esta en PATH');
        }
        if (lastError?.killed || lastError?.signal === 'SIGTERM') {
            throw new Error('La conversion excedio el tiempo limite');
        }
        throw new Error(lastError?.stderr?.trim() || lastError?.message || 'Error ejecutando LibreOffice');
    }

    async _findPdfOutput(workDir, expectedPdfPath) {
        try {
            await fs.access(expectedPdfPath);
            return expectedPdfPath;
        } catch {
            const entries = await fs.readdir(workDir);
            const pdf = entries.find((entry) => entry.toLowerCase().endsWith('.pdf'));
            if (!pdf) throw new Error('LibreOffice no genero un PDF');
            return path.join(workDir, pdf);
        }
    }

    _safeFileName(fileName) {
        const ext = path.extname(fileName || '').toLowerCase();
        const base = path.basename(fileName || 'archivo', ext)
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'archivo';
        return `${base}${ext || '.docx'}`;
    }
}

export default LibreOfficePdfConverter;
