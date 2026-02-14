/**
 * fileUtils.js
 * Utilidades para manejo de archivos y tipos de contenido
 * 
 * @description Funciones helper para determinar tipos de archivo,
 * validar contenido y procesar nombres de archivo
 */

/**
 * Text file extensions
 */
export const TEXT_EXTENSIONS = [
    '.txt', '.sql', '.py', '.js', '.ts', '.java', '.kt', '.swift',
    '.html', '.css', '.json', '.xml', '.md', '.csv', '.yaml', '.yml',
    '.sh', '.bat', '.ps1', '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
    '.rb', '.go', '.rs', '.scala', '.r', '.m', '.lua', '.pl', '.jsx',
    '.tsx', '.vue', '.svelte', '.astro', '.gradle', '.kts', '.toml',
    '.ini', '.cfg', '.conf', '.env', '.gitignore', '.dockerfile'
];

/**
 * Code file extensions (subset of text that are programming languages)
 */
export const CODE_EXTENSIONS = [
    '.py', '.js', '.ts', '.java', '.kt', '.swift', '.c', '.cpp',
    '.h', '.hpp', '.cs', '.php', '.rb', '.go', '.rs', '.scala',
    '.r', '.m', '.lua', '.pl', '.jsx', '.tsx', '.vue', '.svelte'
];

/**
 * Determines if a file is a text file based on its name
 * @param {string} fileName - File name
 * @returns {boolean}
 */
export function isTextFile(fileName) {
    const lowerName = (fileName || '').toLowerCase();
    return TEXT_EXTENSIONS.some(ext => lowerName.endsWith(ext));
}

/**
 * Determines if a file is a code file based on its name
 * @param {string} fileName - File name
 * @returns {boolean}
 */
export function isCodeFile(fileName) {
    const lowerName = (fileName || '').toLowerCase();
    return CODE_EXTENSIONS.some(ext => lowerName.endsWith(ext));
}

/**
 * Determines file type based on its name
 * @param {string} fileName - File name
 * @returns {string} File type identifier
 */
export function getFileTypeFromName(fileName) {
    const lowerName = (fileName || '').toLowerCase();

    // Documents
    if (lowerName.endsWith('.pdf')) return 'pdf';
    if (lowerName.endsWith('.docx') || lowerName.endsWith('.doc')) return 'docx';
    if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) return 'excel';
    if (lowerName.endsWith('.pptx') || lowerName.endsWith('.ppt')) return 'powerpoint';

    // Text files
    if (lowerName.endsWith('.txt')) return 'text';
    if (lowerName.endsWith('.md')) return 'markdown';
    if (lowerName.endsWith('.csv')) return 'csv';

    // Database
    if (lowerName.endsWith('.sql')) return 'sql';

    // Programming languages
    if (lowerName.endsWith('.py')) return 'python';
    if (lowerName.endsWith('.js') || lowerName.endsWith('.jsx')) return 'javascript';
    if (lowerName.endsWith('.ts') || lowerName.endsWith('.tsx')) return 'typescript';
    if (lowerName.endsWith('.java')) return 'java';
    if (lowerName.endsWith('.kt') || lowerName.endsWith('.kts')) return 'kotlin';
    if (lowerName.endsWith('.swift')) return 'swift';
    if (lowerName.endsWith('.c') || lowerName.endsWith('.h')) return 'c';
    if (lowerName.endsWith('.cpp') || lowerName.endsWith('.hpp')) return 'cpp';
    if (lowerName.endsWith('.cs')) return 'csharp';
    if (lowerName.endsWith('.php')) return 'php';
    if (lowerName.endsWith('.rb')) return 'ruby';
    if (lowerName.endsWith('.go')) return 'go';
    if (lowerName.endsWith('.rs')) return 'rust';

    // Web
    if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) return 'html';
    if (lowerName.endsWith('.css') || lowerName.endsWith('.scss') || lowerName.endsWith('.sass')) return 'css';
    if (lowerName.endsWith('.vue')) return 'vue';
    if (lowerName.endsWith('.svelte')) return 'svelte';

    // Data formats
    if (lowerName.endsWith('.json')) return 'json';
    if (lowerName.endsWith('.xml')) return 'xml';
    if (lowerName.endsWith('.yaml') || lowerName.endsWith('.yml')) return 'yaml';
    if (lowerName.endsWith('.toml')) return 'toml';

    // Archives
    if (lowerName.endsWith('.zip') || lowerName.endsWith('.rar') ||
        lowerName.endsWith('.7z') || lowerName.endsWith('.tar') ||
        lowerName.endsWith('.gz')) return 'archive';

    // Images
    if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') ||
        lowerName.endsWith('.png') || lowerName.endsWith('.gif') ||
        lowerName.endsWith('.webp') || lowerName.endsWith('.svg') ||
        lowerName.endsWith('.ico')) return 'image';

    // Video
    if (lowerName.endsWith('.mp4') || lowerName.endsWith('.avi') ||
        lowerName.endsWith('.mov') || lowerName.endsWith('.mkv') ||
        lowerName.endsWith('.webm')) return 'video';

    // Audio
    if (lowerName.endsWith('.mp3') || lowerName.endsWith('.wav') ||
        lowerName.endsWith('.ogg') || lowerName.endsWith('.flac')) return 'audio';

    return 'unknown';
}

/**
 * Get MIME type for a file extension
 * @param {string} fileName - File name
 * @returns {string} MIME type
 */
export function getMimeType(fileName) {
    const lowerName = (fileName || '').toLowerCase();

    const mimeTypes = {
        // Documents
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

        // Text
        '.txt': 'text/plain',
        '.csv': 'text/csv',
        '.md': 'text/markdown',
        '.html': 'text/html',
        '.css': 'text/css',
        '.xml': 'text/xml',

        // Code
        '.js': 'application/javascript',
        '.ts': 'application/typescript',
        '.json': 'application/json',
        '.py': 'text/x-python',
        '.java': 'text/x-java',
        '.kt': 'text/x-kotlin',

        // Images
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',

        // Video
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.avi': 'video/x-msvideo',

        // Audio
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',

        // Archives
        '.zip': 'application/zip',
        '.rar': 'application/vnd.rar',
        '.7z': 'application/x-7z-compressed',
        '.tar': 'application/x-tar',
        '.gz': 'application/gzip'
    };

    for (const [ext, mime] of Object.entries(mimeTypes)) {
        if (lowerName.endsWith(ext)) {
            return mime;
        }
    }

    return 'application/octet-stream';
}

/**
 * Get file extension from filename
 * @param {string} fileName - File name
 * @returns {string} Extension including dot, or empty string
 */
export function getFileExtension(fileName) {
    if (!fileName) return '';
    const lastDot = fileName.lastIndexOf('.');
    return lastDot >= 0 ? fileName.substring(lastDot).toLowerCase() : '';
}

/**
 * Get file name without extension
 * @param {string} fileName - File name
 * @returns {string} File name without extension
 */
export function getFileNameWithoutExtension(fileName) {
    if (!fileName) return '';
    const lastDot = fileName.lastIndexOf('.');
    return lastDot >= 0 ? fileName.substring(0, lastDot) : fileName;
}

/**
 * Sanitize filename for safe storage
 * @param {string} fileName - File name to sanitize
 * @returns {string} Sanitized file name
 */
export function sanitizeFileName(fileName) {
    if (!fileName) return 'unnamed';
    return fileName
        .replace(/[^\w\s.-]/g, '_')  // Replace special chars with underscore
        .replace(/\s+/g, '_')        // Replace spaces with underscore
        .replace(/_+/g, '_')          // Collapse multiple underscores
        .trim();
}

/**
 * Generate unique filename with timestamp
 * @param {string} originalName - Original file name
 * @returns {string} Unique file name
 */
export function generateUniqueFileName(originalName) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const ext = getFileExtension(originalName);
    const baseName = sanitizeFileName(getFileNameWithoutExtension(originalName));
    return `${baseName}_${timestamp}_${random}${ext}`;
}

/**
 * Check if content appears to be empty or invalid
 * @param {string} content - Content to check
 * @returns {boolean} True if content is empty or invalid
 */
export function isContentEmpty(content) {
    if (!content) return true;

    // Clean spaces, line breaks and special characters
    const cleanContent = content
        .replace(/\s+/g, '')           // Remove spaces and line breaks
        .replace(/[\r\n\t]/g, '')       // Remove control characters
        .replace(/[^\w\u00C0-\u024F]/g, '')  // Only letters and numbers (includes accents)
        .trim();

    return cleanContent.length === 0;
}

/**
 * Check if content has minimal meaningful text
 * @param {string} content - Content to check
 * @param {number} minLength - Minimum length (default 10)
 * @returns {boolean} True if content has enough text
 */
export function hasMinimalContent(content, minLength = 10) {
    if (!content) return false;
    const cleanContent = content.replace(/\s+/g, ' ').trim();
    return cleanContent.length >= minLength;
}

/**
 * Truncate content to maximum length with ellipsis
 * @param {string} content - Content to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated content
 */
export function truncateContent(content, maxLength = 1000) {
    if (!content || content.length <= maxLength) return content;
    return content.substring(0, maxLength - 3) + '...';
}

/**
 * Count words in content
 * @param {string} content - Content to count words in
 * @returns {number} Word count
 */
export function countWords(content) {
    if (!content) return 0;
    return content.trim().split(/\s+/).filter(word => word.length > 0).length;
}

/**
 * Count lines in content
 * @param {string} content - Content to count lines in
 * @returns {number} Line count
 */
export function countLines(content) {
    if (!content) return 0;
    return content.split(/\r\n|\r|\n/).length;
}

/**
 * Format file size to human readable string
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted size string
 */
export function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Default export all functions
export default {
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
};


