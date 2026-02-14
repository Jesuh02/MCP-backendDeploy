/**
 * MCPRoutes (Legacy) — Rutas de compatibilidad para endpoints MCP legacy.
 *
 * REFACTORIZADO: Ahora sigue la arquitectura hexagonal.
 * - Recibe dependencias por inyección (DI) a través del factory function
 * - No importa servicios de infraestructura directamente (DIP)
 * - La validación se mantiene en la capa de interfaz (SRP)
 * - La lógica de negocio vive en el servicio de dominio (SRP)
 *
 * Las rutas principales de MCP están en src/interfaces/http/routes/v1/mcpRoutes.js
 * Este archivo mantiene backward compatibility para endpoints legacy.
 *
 * @deprecated Usar /api/v1/mcp/* para nuevas integraciones.
 */

import { Router } from 'express';
import Joi from 'joi';

// ── Validation Schemas (Interface layer responsibility) ─────
const querySchema = Joi.object({
    query: Joi.string().required().min(1).max(10000),
    includeRAG: Joi.boolean().optional().default(true),
    includeSchema: Joi.boolean().optional().default(false),
    maxTokens: Joi.number().optional().min(100).max(10000).default(4000),
});

const githubAnalysisSchema = Joi.object({
    repoUrl: Joi.string().required().uri().pattern(/^https?:\/\/github\.com\/[\w-]+\/[\w-]+/),
    taskDescription: Joi.string().optional().default(''),
    criteria: Joi.string().optional().default(''),
    fileTypes: Joi.array().items(Joi.string()).optional(),
    maxFiles: Joi.number().optional().min(1).max(50).default(20),
});

/**
 * Factory function que recibe dependencias del container (Dependency Inversion).
 *
 * @param {Object} deps
 * @param {Object} deps.mcpServiceLegacy - MCPService legacy (para processQuery, analyzeGitHubRepo)
 * @returns {Router}
 */
export function createLegacyMCPRoutes({ mcpServiceLegacy }) {
    const router = Router();

    /**
     * POST /query — Procesar query con contexto enriquecido.
     */
    router.post('/query', async (req, res, next) => {
        try {
            const { error, value } = querySchema.validate(req.body);
            if (error) {
                return res.status(400).json({
                    error: 'Validation Error',
                    message: error.details[0].message,
                });
            }

            const { query, includeRAG, includeSchema, maxTokens } = value;
            const result = await mcpServiceLegacy.processQuery(query, {
                includeRAG,
                includeSchema,
                maxTokens,
            });

            res.json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    });

    /**
     * GET /stats — Estadísticas de la base de datos.
     */
    router.get('/stats', async (req, res, next) => {
        try {
            const stats = await mcpServiceLegacy.getDatabaseStats();
            res.json({ success: true, data: stats });
        } catch (err) {
            next(err);
        }
    });

    /**
     * GET /table/:tableName — Datos de tabla con paginación.
     */
    router.get('/table/:tableName', async (req, res, next) => {
        try {
            const { tableName } = req.params;
            const page = parseInt(req.query.page) || 1;
            const pageSize = parseInt(req.query.pageSize) || 50;

            const result = await mcpServiceLegacy.getTableData(tableName, page, pageSize);
            res.json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    });

    /**
     * POST /knowledge — Agregar conocimiento a la base.
     */
    router.post('/knowledge', async (req, res, next) => {
        try {
            const { content, metadata } = req.body;
            if (!content) {
                return res.status(400).json({
                    error: 'Validation Error',
                    message: 'content is required',
                });
            }

            const result = await mcpServiceLegacy.addKnowledge(content, metadata);
            res.json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    });

    /**
     * POST /analyze-github — Analizar repositorio GitHub.
     */
    router.post('/analyze-github', async (req, res, next) => {
        try {
            const { error, value } = githubAnalysisSchema.validate(req.body);
            if (error) {
                return res.status(400).json({
                    success: false,
                    error: 'Validation Error',
                    message: error.details[0].message,
                });
            }

            const { repoUrl, taskDescription, criteria, fileTypes, maxFiles } = value;

            const analysisResult = await mcpServiceLegacy.analyzeGitHubRepo(repoUrl, {
                criteria,
                fileTypes,
                taskDescription,
                maxFiles,
            });

            res.json({
                success: true,
                repository: analysisResult.repository || {
                    fullName: repoUrl.replace(/^https?:\/\/github\.com\//, ''),
                    url: repoUrl,
                },
                grade: analysisResult.grade || 0,
                feedback: analysisResult.feedback || 'No feedback available',
                strengths: analysisResult.strengths || [],
                improvements: analysisResult.improvements || [],
                detailedAnalysis: analysisResult.detailedAnalysis || '',
                filesAnalyzed: analysisResult.filesAnalyzed || [],
                statistics: analysisResult.statistics || {},
            });
        } catch (err) {
            console.error(`❌ Error analyzing GitHub repository: ${err.message}`);
            res.status(500).json({
                success: false,
                error: err.message || 'Failed to analyze repository',
                hint: _getGitHubErrorHint(err.message),
            });
        }
    });

    return router;
}

/**
 * Genera hints útiles para errores de GitHub.
 * @param {string} errorMessage
 * @returns {string}
 * @private
 */
function _getGitHubErrorHint(errorMessage) {
    if (!errorMessage) {
        return 'Asegúrate de que el servidor MCP esté ejecutándose y que la URL sea válida.';
    }

    const hintMap = [
        { pattern: /404|Not Found/i, hint: 'El repositorio no existe o es privado. Verifica la URL y que el repositorio sea público.' },
        { pattern: /403|rate limit/i, hint: 'Límite de peticiones a GitHub alcanzado. Configura un GITHUB_TOKEN en las variables de entorno.' },
        { pattern: /Invalid GitHub URL/i, hint: 'URL de GitHub inválida. Usa el formato: https://github.com/usuario/repositorio' },
        { pattern: /LLM|API/i, hint: 'El servicio de IA no está disponible. Verifica la configuración de la API Key.' },
    ];

    const match = hintMap.find(({ pattern }) => pattern.test(errorMessage));
    return match?.hint || 'Error al acceder al repositorio. Verifica que la URL sea correcta y el repositorio sea público.';
}

export default createLegacyMCPRoutes;


