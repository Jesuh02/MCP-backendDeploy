/**
 * githubUtils.js
 * Utilidades para detección y procesamiento de URLs de GitHub
 * 
 * @description Funciones helper para trabajar con repositorios de GitHub,
 * detectar URLs, extraer información y validar referencias
 */

/**
 * GitHub URL patterns
 */
const GITHUB_URL_PATTERNS = {
    // Standard repo URL: https://github.com/owner/repo
    standard: /https?:\/\/github\.com\/([^\/]+)\/([^\/\s\?#]+)/,
    // With branch: https://github.com/owner/repo/tree/branch
    withBranch: /https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/tree\/([^\/\s\?#]+)/,
    // With file path: https://github.com/owner/repo/blob/branch/path
    withFile: /https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/(.+)/,
    // Raw file: https://raw.githubusercontent.com/owner/repo/branch/path
    raw: /https?:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)/,
    // Git URL: git@github.com:owner/repo.git
    gitSsh: /git@github\.com:([^\/]+)\/([^\.]+)\.git/,
    // HTTPS clone: https://github.com/owner/repo.git
    gitHttps: /https?:\/\/github\.com\/([^\/]+)\/([^\.]+)\.git/
};

/**
 * Check if a string contains a GitHub reference
 * @param {string} input - Input string to check
 * @returns {boolean}
 */
export function isGitHubReference(input) {
    if (!input) return false;
    const lowerInput = input.toLowerCase();
    return lowerInput.includes('github.com') ||
        lowerInput.startsWith('github_') ||
        lowerInput.includes('github_') ||
        lowerInput.startsWith('git@github.com');
}

/**
 * Check if filename indicates a GitHub repository
 * Format: github_OWNER_REPO or github_OWNER_REPO_BRANCH
 * @param {string} fileName - File name to check
 * @returns {boolean}
 */
export function isGitHubFileName(fileName) {
    if (!fileName) return false;
    const lowerName = fileName.toLowerCase();
    return lowerName.startsWith('github_') ||
        lowerName.includes('github.com');
}

/**
 * Extract GitHub URL from a filename
 * Converts: github_Jesuh02_ProjectCourseV1 -> https://github.com/Jesuh02/ProjectCourseV1
 * @param {string} fileName - File name to extract URL from
 * @returns {string|null} GitHub URL or null
 */
export function extractGitHubUrlFromFileName(fileName) {
    if (!fileName) return null;

    // If it's already a full URL
    if (fileName.includes('github.com')) {
        const match = fileName.match(GITHUB_URL_PATTERNS.standard);
        return match ? `https://github.com/${match[1]}/${match[2]}` : null;
    }

    // Format: github_OWNER_REPO or github_OWNER_REPO_BRANCH
    const match = fileName.match(/github[_-](\w+)[_-](\w+)(?:[_-](\w+))?/i);
    if (match) {
        const owner = match[1];
        const repo = match[2];
        return `https://github.com/${owner}/${repo}`;
    }

    return null;
}

/**
 * Parse GitHub URL and extract components
 * @param {string} url - GitHub URL to parse
 * @returns {Object|null} Parsed components or null
 */
export function parseGitHubUrl(url) {
    if (!url) return null;

    // Try standard repo URL
    let match = url.match(GITHUB_URL_PATTERNS.standard);
    if (match) {
        return {
            owner: match[1],
            repo: match[2].replace(/\.git$/, ''),
            branch: null,
            path: null,
            type: 'repo',
            url: `https://github.com/${match[1]}/${match[2].replace(/\.git$/, '')}`
        };
    }

    // Try URL with branch
    match = url.match(GITHUB_URL_PATTERNS.withBranch);
    if (match) {
        return {
            owner: match[1],
            repo: match[2],
            branch: match[3],
            path: null,
            type: 'branch',
            url: `https://github.com/${match[1]}/${match[2]}`
        };
    }

    // Try URL with file path
    match = url.match(GITHUB_URL_PATTERNS.withFile);
    if (match) {
        return {
            owner: match[1],
            repo: match[2],
            branch: match[3],
            path: match[4],
            type: 'file',
            url: `https://github.com/${match[1]}/${match[2]}`
        };
    }

    // Try raw file URL
    match = url.match(GITHUB_URL_PATTERNS.raw);
    if (match) {
        return {
            owner: match[1],
            repo: match[2],
            branch: match[3],
            path: match[4],
            type: 'raw',
            url: `https://github.com/${match[1]}/${match[2]}`
        };
    }

    // Try Git SSH URL
    match = url.match(GITHUB_URL_PATTERNS.gitSsh);
    if (match) {
        return {
            owner: match[1],
            repo: match[2],
            branch: null,
            path: null,
            type: 'ssh',
            url: `https://github.com/${match[1]}/${match[2]}`
        };
    }

    return null;
}

/**
 * Construct GitHub API URL for repository info
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {string} API URL
 */
export function getGitHubApiUrl(owner, repo) {
    return `https://api.github.com/repos/${owner}/${repo}`;
}

/**
 * Construct GitHub API URL for repository contents
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} path - Path within repository (optional)
 * @param {string} ref - Branch or commit ref (optional)
 * @returns {string} API URL
 */
export function getGitHubContentsUrl(owner, repo, path = '', ref = '') {
    let url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    if (ref) {
        url += `?ref=${ref}`;
    }
    return url;
}

/**
 * Construct raw GitHub content URL
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branch - Branch name
 * @param {string} path - File path
 * @returns {string} Raw content URL
 */
export function getRawGitHubUrl(owner, repo, branch, path) {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

/**
 * Construct GitHub clone URL
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {boolean} useSsh - Use SSH URL instead of HTTPS
 * @returns {string} Clone URL
 */
export function getGitHubCloneUrl(owner, repo, useSsh = false) {
    if (useSsh) {
        return `git@github.com:${owner}/${repo}.git`;
    }
    return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Extract owner and repo from various GitHub reference formats
 * @param {string} input - Input string (URL, filename, or reference)
 * @returns {{owner: string, repo: string}|null} Owner and repo or null
 */
export function extractOwnerAndRepo(input) {
    if (!input) return null;

    // Try parsing as URL first
    const parsed = parseGitHubUrl(input);
    if (parsed) {
        return { owner: parsed.owner, repo: parsed.repo };
    }

    // Try extracting from filename
    const url = extractGitHubUrlFromFileName(input);
    if (url) {
        const parsedFromFileName = parseGitHubUrl(url);
        if (parsedFromFileName) {
            return { owner: parsedFromFileName.owner, repo: parsedFromFileName.repo };
        }
    }

    return null;
}

/**
 * Validate GitHub repository format
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {boolean} True if valid format
 */
export function isValidRepoFormat(owner, repo) {
    if (!owner || !repo) return false;

    // GitHub username rules: 1-39 chars, alphanumeric and hyphens, can't start with hyphen
    const ownerRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

    // Repo name rules: 1-100 chars, alphanumeric, hyphens, underscores, dots
    const repoRegex = /^[a-zA-Z0-9._-]{1,100}$/;

    return ownerRegex.test(owner) && repoRegex.test(repo);
}

/**
 * Generate GitHub file URL from components
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branch - Branch name
 * @param {string} filePath - File path within repo
 * @returns {string} File URL
 */
export function generateGitHubFileUrl(owner, repo, branch, filePath) {
    return `https://github.com/${owner}/${repo}/blob/${branch}/${filePath}`;
}

/**
 * Convert GitHub blob URL to raw URL
 * @param {string} blobUrl - GitHub blob URL
 * @returns {string|null} Raw URL or null
 */
export function blobToRawUrl(blobUrl) {
    if (!blobUrl) return null;

    const match = blobUrl.match(GITHUB_URL_PATTERNS.withFile);
    if (match) {
        return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
    }

    return null;
}

/**
 * Get default branch API URL
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {string} API URL for default branch info
 */
export function getDefaultBranchUrl(owner, repo) {
    return `https://api.github.com/repos/${owner}/${repo}`;
}

/**
 * Format repository reference for display
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branch - Branch name (optional)
 * @returns {string} Formatted reference
 */
export function formatRepoReference(owner, repo, branch = null) {
    let ref = `${owner}/${repo}`;
    if (branch) {
        ref += `@${branch}`;
    }
    return ref;
}

// Default export all functions
export default {
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
};
