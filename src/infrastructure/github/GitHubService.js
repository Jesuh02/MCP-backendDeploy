/**
 * GitHubService - Service for interacting with GitHub API
 * Extracts repository content for LLM analysis and grading
 */

import { logger } from '../logging/Logger.js';

export class GitHubService {
    constructor() {
        this.baseUrl = 'https://api.github.com';
        this.token = process.env.GITHUB_TOKEN || null;

        // Extensiones de archivo a analizar por defecto
        this.defaultFileExtensions = [
            '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.kt', '.swift',
            '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php',
            '.html', '.css', '.scss', '.vue', '.svelte',
            '.json', '.yaml', '.yml', '.xml', '.gradle', '.toml'
        ];

        // Archivos importantes que siempre intentamos leer
        this.importantFiles = [
            'README.md', 'readme.md', 'README.MD',
            'package.json', 'requirements.txt', 'setup.py', 'pyproject.toml',
            'build.gradle', 'build.gradle.kts', 'pom.xml',
            'Cargo.toml', 'go.mod', 'Gemfile',
            '.gitignore', 'Dockerfile', 'docker-compose.yml',
            'Makefile', 'CMakeLists.txt'
        ];

        // Límite de tokens/caracteres para evitar sobrecargar el LLM
        this.maxTotalChars = 50000; // ~12.5k tokens aproximadamente
        this.maxFileChars = 10000; // Máximo por archivo
    }

    /**
     * Parse GitHub URL to extract owner and repo
     * Supports: https://github.com/owner/repo, github.com/owner/repo, owner/repo
     */
    parseGitHubUrl(url) {
        if (!url) return null;

        // Clean the URL
        let cleanUrl = url.trim();

        // Remove trailing .git
        cleanUrl = cleanUrl.replace(/\.git$/, '');

        // Remove trailing slashes
        cleanUrl = cleanUrl.replace(/\/+$/, '');

        // Pattern for full URLs
        const fullUrlPattern = /(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/]+)\/([^\/]+)/i;
        const match = cleanUrl.match(fullUrlPattern);

        if (match) {
            return {
                owner: match[1],
                repo: match[2],
                fullName: `${match[1]}/${match[2]}`
            };
        }

        // Pattern for owner/repo format
        const shortPattern = /^([^\/]+)\/([^\/]+)$/;
        const shortMatch = cleanUrl.match(shortPattern);

        if (shortMatch) {
            return {
                owner: shortMatch[1],
                repo: shortMatch[2],
                fullName: `${shortMatch[1]}/${shortMatch[2]}`
            };
        }

        return null;
    }

    /**
     * Make authenticated request to GitHub API
     */
    async makeRequest(endpoint, options = {}) {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'TareaMov-MCP-Server'
        };

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;

        try {
            const response = await fetch(url, {
                ...options,
                headers: {...headers, ...options.headers }
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`GitHub API error ${response.status}: ${errorBody}`);
            }

            return await response.json();
        } catch (error) {
            logger.error(`GitHub API request failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get repository info
     */
    async getRepoInfo(owner, repo) {
        logger.info(`📦 Fetching repo info for ${owner}/${repo}`);
        return await this.makeRequest(`/repos/${owner}/${repo}`);
    }

    /**
     * Get repository tree (file structure)
     */
    async getRepoTree(owner, repo, branch = 'main') {
        logger.info(`🌳 Fetching repo tree for ${owner}/${repo}`);

        try {
            // Try main branch first
            return await this.makeRequest(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
        } catch (error) {
            // Try master branch as fallback
            if (branch === 'main') {
                logger.info('⚠️ main branch not found, trying master...');
                return await this.makeRequest(`/repos/${owner}/${repo}/git/trees/master?recursive=1`);
            }
            throw error;
        }
    }

    /**
     * Get file content from repository
     */
    async getFileContent(owner, repo, path) {
        logger.info(`📄 Fetching file: ${path}`);

        const response = await this.makeRequest(`/repos/${owner}/${repo}/contents/${path}`);

        if (response.content && response.encoding === 'base64') {
            return Buffer.from(response.content, 'base64').toString('utf-8');
        }

        return null;
    }

    /**
     * Get raw file content (for larger files)
     */
    async getRawFileContent(owner, repo, path, branch = 'main') {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                // Try master branch
                const masterUrl = `https://raw.githubusercontent.com/${owner}/${repo}/master/${path}`;
                const masterResponse = await fetch(masterUrl);
                if (!masterResponse.ok) {
                    throw new Error(`File not found: ${path}`);
                }
                return await masterResponse.text();
            }
            return await response.text();
        } catch (error) {
            logger.error(`Failed to get raw content for ${path}: ${error.message}`);
            return null;
        }
    }

    /**
     * Analyze repository and extract relevant content for grading
     */
    async analyzeRepository(repoUrl, options = {}) {
        const {
            criteria = '',
                fileTypes = null,
                maxFiles = 20,
                branch = 'main'
        } = options;

        // Use default extensions if fileTypes is null or undefined
        const effectiveFileTypes = fileTypes || this.defaultFileExtensions;

        logger.info(`🔍 Analyzing repository: ${repoUrl}`);

        // Parse URL
        const parsed = this.parseGitHubUrl(repoUrl);
        if (!parsed) {
            throw new Error(`Invalid GitHub URL: ${repoUrl}`);
        }

        const { owner, repo, fullName } = parsed;

        // Get repo info
        let repoInfo;
        try {
            repoInfo = await this.getRepoInfo(owner, repo);
        } catch (error) {
            throw new Error(`No se pudo acceder al repositorio ${fullName}. Verifica que existe y es público. Error: ${error.message}`);
        }

        // Get file tree
        let tree;
        try {
            tree = await this.getRepoTree(owner, repo, repoInfo.default_branch || branch);
        } catch (error) {
            throw new Error(`No se pudo obtener la estructura del repositorio: ${error.message}`);
        }

        // Filter relevant files
        const relevantFiles = this.filterRelevantFiles(tree.tree, effectiveFileTypes, maxFiles);

        // Extract file contents
        const fileContents = await this.extractFileContents(owner, repo, relevantFiles, repoInfo.default_branch || branch);

        // Build analysis result
        const analysis = {
            repository: {
                fullName,
                url: repoUrl,
                description: repoInfo.description || 'Sin descripción',
                language: repoInfo.language || 'No detectado',
                stars: repoInfo.stargazers_count || 0,
                forks: repoInfo.forks_count || 0,
                lastUpdate: repoInfo.updated_at,
                defaultBranch: repoInfo.default_branch,
                size: repoInfo.size,
                hasReadme: relevantFiles.some(f => f.path.toLowerCase().includes('readme')),
                hasTests: relevantFiles.some(f => f.path.toLowerCase().includes('test')),
                hasCI: relevantFiles.some(f =>
                    f.path.includes('.github/workflows') ||
                    f.path.includes('.travis') ||
                    f.path.includes('Jenkinsfile')
                )
            },
            structure: this.buildDirectoryStructure(tree.tree),
            files: fileContents,
            statistics: {
                totalFiles: tree.tree.filter(t => t.type === 'blob').length,
                analyzedFiles: fileContents.length,
                totalChars: fileContents.reduce((sum, f) => sum + (f.content?.length || 0), 0)
            },
            criteria: criteria || 'Evaluar calidad del código, estructura del proyecto, documentación y buenas prácticas'
        };

        logger.info(`✅ Repository analysis complete: ${fileContents.length} files extracted`);

        return analysis;
    }

    /**
     * Filter relevant files based on extensions and importance
     */
    filterRelevantFiles(files, fileTypes, maxFiles) {
        const relevantFiles = [];
        const seenPaths = new Set();

        // Ensure fileTypes is an array
        const validFileTypes = Array.isArray(fileTypes) ? fileTypes : this.defaultFileExtensions;

        // First, add important files (README, package.json, etc.)
        for (const file of files) {
            if (file.type !== 'blob') continue;
            if (seenPaths.has(file.path)) continue;

            const fileName = file.path.split('/').pop();

            if (this.importantFiles.includes(fileName)) {
                relevantFiles.push(file);
                seenPaths.add(file.path);
            }
        }

        // Then add files with matching extensions
        for (const file of files) {
            if (relevantFiles.length >= maxFiles) break;
            if (file.type !== 'blob') continue;
            if (seenPaths.has(file.path)) continue;

            // Skip common non-code directories
            if (this.shouldSkipPath(file.path)) continue;

            const extension = this.getFileExtension(file.path);
            if (validFileTypes.includes(extension)) {
                relevantFiles.push(file);
                seenPaths.add(file.path);
            }
        }

        // Prioritize source files over config files
        return relevantFiles.sort((a, b) => {
            const aIsSource = this.isSourceFile(a.path);
            const bIsSource = this.isSourceFile(b.path);
            if (aIsSource && !bIsSource) return -1;
            if (!aIsSource && bIsSource) return 1;
            return 0;
        });
    }

    /**
     * Check if path should be skipped
     */
    shouldSkipPath(path) {
        const skipPatterns = [
            'node_modules/', 'vendor/', 'venv/', '.venv/', '__pycache__/',
            'dist/', 'build/', 'out/', 'target/', '.gradle/',
            '.git/', '.idea/', '.vscode/', '.next/', '.nuxt/',
            'coverage/', '.nyc_output/', 'htmlcov/',
            'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
            '.min.js', '.min.css', '.bundle.js'
        ];

        return skipPatterns.some(pattern => path.includes(pattern));
    }

    /**
     * Get file extension
     */
    getFileExtension(path) {
        const parts = path.split('.');
        if (parts.length < 2) return '';
        return '.' + parts.pop().toLowerCase();
    }

    /**
     * Check if file is a source code file
     */
    isSourceFile(path) {
        const sourceExtensions = ['.py', '.js', '.ts', '.java', '.kt', '.swift', '.c', '.cpp', '.go', '.rs'];
        return sourceExtensions.includes(this.getFileExtension(path));
    }

    /**
     * Extract content from files
     */
    async extractFileContents(owner, repo, files, branch) {
        const contents = [];
        let totalChars = 0;

        for (const file of files) {
            if (totalChars >= this.maxTotalChars) {
                logger.warn(`⚠️ Reached character limit (${this.maxTotalChars}), stopping file extraction`);
                break;
            }

            try {
                let content = await this.getRawFileContent(owner, repo, file.path, branch);

                if (content) {
                    // Truncate if too long
                    if (content.length > this.maxFileChars) {
                        content = content.substring(0, this.maxFileChars) + '\n\n... [ARCHIVO TRUNCADO - muy largo] ...';
                    }

                    // Check total limit
                    if (totalChars + content.length > this.maxTotalChars) {
                        const remaining = this.maxTotalChars - totalChars;
                        content = content.substring(0, remaining) + '\n\n... [CONTENIDO TRUNCADO - límite alcanzado] ...';
                    }

                    contents.push({
                        path: file.path,
                        content: content,
                        size: content.length,
                        extension: this.getFileExtension(file.path)
                    });

                    totalChars += content.length;
                }
            } catch (error) {
                logger.warn(`⚠️ Could not read file ${file.path}: ${error.message}`);
            }
        }

        return contents;
    }

    /**
     * Build directory structure tree
     */
    buildDirectoryStructure(files) {
        const structure = [];
        const dirs = new Set();

        // Collect unique directories
        for (const file of files) {
            if (file.type === 'tree') {
                dirs.add(file.path);
            }
        }

        // Build simple tree representation
        const rootItems = files
            .filter(f => !f.path.includes('/'))
            .map(f => ({
                name: f.path,
                type: f.type === 'tree' ? 'directory' : 'file'
            }));

        return {
            rootItems: rootItems.slice(0, 30),
            totalDirectories: dirs.size,
            totalFiles: files.filter(f => f.type === 'blob').length
        };
    }

    /**
     * Format repository analysis for LLM prompt
     */
    formatForLLM(analysis) {
        let prompt = `# 📦 Análisis del Repositorio: ${analysis.repository.fullName}\n\n`;

        // Repository info
        prompt += `## 📋 Información General\n`;
        prompt += `- **URL:** ${analysis.repository.url}\n`;
        prompt += `- **Descripción:** ${analysis.repository.description}\n`;
        prompt += `- **Lenguaje principal:** ${analysis.repository.language}\n`;
        prompt += `- **Última actualización:** ${analysis.repository.lastUpdate}\n`;
        prompt += `- **Tiene README:** ${analysis.repository.hasReadme ? 'Sí ✅' : 'No ❌'}\n`;
        prompt += `- **Tiene Tests:** ${analysis.repository.hasTests ? 'Sí ✅' : 'No ❌'}\n`;
        prompt += `- **Tiene CI/CD:** ${analysis.repository.hasCI ? 'Sí ✅' : 'No ❌'}\n\n`;

        // Structure
        prompt += `## 📁 Estructura del Proyecto\n`;
        prompt += `- Archivos totales: ${analysis.statistics.totalFiles}\n`;
        prompt += `- Archivos analizados: ${analysis.statistics.analyzedFiles}\n\n`;

        if (analysis.structure.rootItems) {
            prompt += `### Estructura raíz:\n`;
            for (const item of analysis.structure.rootItems) {
                const icon = item.type === 'directory' ? '📂' : '📄';
                prompt += `${icon} ${item.name}\n`;
            }
            prompt += '\n';
        }

        // Files content
        prompt += `## 💻 Código Fuente\n\n`;

        for (const file of analysis.files) {
            prompt += `### 📄 ${file.path}\n`;
            prompt += '```' + (file.extension.replace('.', '') || 'text') + '\n';
            prompt += file.content + '\n';
            prompt += '```\n\n';
        }

        // Criteria
        prompt += `## 🎯 Criterios de Evaluación\n`;
        prompt += analysis.criteria + '\n';

        return prompt;
    }
}

// Singleton instance
let instance = null;

export function getGitHubService() {
    if (!instance) {
        instance = new GitHubService();
    }
    return instance;
}