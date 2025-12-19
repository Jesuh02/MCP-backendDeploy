/**
 * utils/index.js
 * Exportaciones centralizadas de todas las utilidades
 */

// File utilities
export {
    TEXT_EXTENSIONS,
    CODE_EXTENSIONS,
    isTextFile,
    isCodeFile,
    getFileTypeFromName,
    getMimeType,
    getFileExtension,
    getFileNameWithoutExtension,
    sanitizeFileName,
    generateUniqueFileName,
    isContentEmpty,
    hasMinimalContent,
    truncateContent,
    countWords,
    countLines,
    formatFileSize
} from './fileUtils.js';

// GitHub utilities
export {
    GITHUB_URL_PATTERNS,
    isGitHubReference,
    isGitHubFileName,
    extractGitHubUrlFromFileName,
    parseGitHubUrl,
    getGitHubApiUrl,
    getGitHubContentsUrl,
    getRawGitHubUrl,
    /**
     * utils/index.js
     * Exportaciones centralizadas de todas las utilidades
     */

    // File utilities
    export {
        TEXT_EXTENSIONS,
        CODE_EXTENSIONS,
        isTextFile,
        isCodeFile,
        getFileTypeFromName,
        getMimeType,
        getFileExtension,
        getFileNameWithoutExtension,
        sanitizeFileName,
        generateUniqueFileName,
        isContentEmpty,
        hasMinimalContent,
        truncateContent,
        countWords,
        countLines,
        formatFileSize
    } from './fileUtils.js';

    // GitHub utilities
    export {
        GITHUB_URL_PATTERNS,
        isGitHubReference,
        isGitHubFileName,
        extractGitHubUrlFromFileName,
        parseGitHubUrl,
        getGitHubApiUrl,
        getGitHubContentsUrl,
        getRawGitHubUrl,
        getGitHubCloneUrl,
        extractOwnerAndRepo,
        isValidRepoFormat,
        generateGitHubFileUrl,
        blobToRawUrl,
        getDefaultBranchUrl,
        formatRepoReference
    } from './githubUtils.js';

    // Default grouped exports
    import fileUtils from './fileUtils.js';
    import githubUtils from './githubUtils.js';

    // Helper to create a human-readable avoidance note from history
    export function buildHistoryAvoidanceNote(historyArray = [], maxItems = 20) {
        if (!Array.isArray(historyArray) || historyArray.length === 0) return '';
        const list = historyArray.slice(0, maxItems).map((h, i) => {
            try {
                if (!h) return null;
                if (typeof h === 'string') return `${i+1}. ${h}`;
                if (h.question) return `${i+1}. ${h.question}`;
                if (h.pregunta) return `${i+1}. ${h.pregunta}`;
                return `${i+1}. ${JSON.stringify(h)}`;
            } catch (e) { return null; }
        }).filter(Boolean);

        if (list.length === 0) return '';
        return `\n\n--- AVISO: Evita generar preguntas iguales o muy similares a las siguientes (ya dadas a este usuario en este curso):\n${list.join('\n')}\n---\nPor favor, crea preguntas totalmente diferentes que no repitan ni parafraseen las anteriores.`;
    }

    export default {
        file: fileUtils,
        github: githubUtils,
        buildHistoryAvoidanceNote
    };
