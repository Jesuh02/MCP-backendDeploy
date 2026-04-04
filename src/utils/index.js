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

export default {
    file: fileUtils,
    github: githubUtils
};


