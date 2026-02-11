/**
 * GitHubAdapter — Adaptador de infraestructura que implementa IGitHubPort.
 *
 * Envuelve GitHubService existente detrás de un puerto abstracto.
 */

import { Octokit } from '@octokit/rest';

export class GitHubAdapter {
    constructor() {
        this._octokit = null;
        const token = process.env.GITHUB_TOKEN;
        if (token) {
            this._octokit = new Octokit({ auth: token });
            console.log('✅ GitHubAdapter: inicializado');
        }
    }

    /** @returns {boolean} */
    isAvailable() {
        return this._octokit !== null;
    }

    /**
     * Analiza un repositorio de GitHub.
     * @param {string} repoUrl
     * @param {{ taskDescription?: string, prompt?: string }} options
     * @returns {Promise<{ summary: string, files: Array, languages: Object }>}
     */
    async analyzeRepository(repoUrl, options = {}) {
        if (!this.isAvailable()) throw new Error('GitHub no configurado');

        const { owner, repo } = this._parseRepoUrl(repoUrl);

        const [repoData, contents, languages] = await Promise.all([
            this._octokit.repos.get({ owner, repo }),
            this._octokit.repos.getContent({ owner, repo, path: '' }).catch(() => ({ data: [] })),
            this._octokit.repos.listLanguages({ owner, repo }).catch(() => ({ data: {} })),
        ]);

        const files = Array.isArray(contents.data) ?
            contents.data.map(f => ({ name: f.name, type: f.type, path: f.path, size: f.size })) : [];

        return {
            summary: `Repositorio: ${repoData.data.full_name} — ${repoData.data.description || 'Sin descripción'}`,
            files,
            languages: languages.data || {},
        };
    }

    /**
     * Obtiene contenido de un archivo del repositorio.
     * @param {string} repoUrl
     * @param {string} filePath
     * @returns {Promise<string>}
     */
    async getFileContent(repoUrl, filePath) {
        if (!this.isAvailable()) throw new Error('GitHub no configurado');

        const { owner, repo } = this._parseRepoUrl(repoUrl);
        const response = await this._octokit.repos.getContent({ owner, repo, path: filePath });

        if (response.data.content) {
            return Buffer.from(response.data.content, 'base64').toString('utf-8');
        }
        return '';
    }

    /** @private */
    _parseRepoUrl(url) {
        const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
        if (!match) throw new Error(`URL de GitHub inválida: ${url}`);
        return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
    }
}
export default GitHubAdapter;