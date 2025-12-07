/**
 * MCP Routes
 * API endpoints for Model Context Protocol operations
 */

import express from 'express';
import { MCPService } from '../../domain/services/MCPService.js';
import { logger } from '../../infrastructure/logging/Logger.js';
import Joi from 'joi';

const router = express.Router();
const mcpService = new MCPService();

// Validation schemas
const querySchema = Joi.object({
  query: Joi.string().required().min(1).max(10000),
  includeRAG: Joi.boolean().optional().default(true),
  includeSchema: Joi.boolean().optional().default(false),
  maxTokens: Joi.number().optional().min(100).max(10000).default(4000)
});

const tableSchema = Joi.object({
  tableName: Joi.string().required(),
  page: Joi.number().optional().min(1).default(1),
  pageSize: Joi.number().optional().min(1).max(100).default(50)
});

const githubAnalysisSchema = Joi.object({
  repoUrl: Joi.string().required().uri().pattern(/^https?:\/\/github\.com\/[\w-]+\/[\w-]+/),
  taskDescription: Joi.string().optional().default(''),
  criteria: Joi.string().optional().default(''),
  fileTypes: Joi.array().items(Joi.string()).optional(),
  maxFiles: Joi.number().optional().min(1).max(50).default(20)
});

/**
 * POST /api/v1/mcp/query
 * Process a query and return enriched context
 */
router.post('/query', async (req, res, next) => {
  try {
    // Validate request
    const { error, value } = querySchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation Error',
        message: error.details[0].message
      });
    }
    
    const { query, includeRAG, includeSchema, maxTokens } = value;
    
    // Process query
    const result = await mcpService.processQuery(query, {
      includeRAG,
      includeSchema,
      maxTokens
    });
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/mcp/stats
 * Get database statistics
 */
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await mcpService.getDatabaseStats();
    
    res.json({
      success: true,
      data: stats
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/mcp/table/:tableName
 * Get table data with pagination
 */
router.get('/table/:tableName', async (req, res, next) => {
  try {
    const { tableName } = req.params;
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 50;
    
    const result = await mcpService.getTableData(tableName, page, pageSize);
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/mcp/knowledge
 * Add knowledge to base
 */
router.post('/knowledge', async (req, res, next) => {
  try {
    const { content, metadata } = req.body;
    
    if (!content) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'content is required'
      });
    }
    
    const result = await mcpService.addKnowledge(content, metadata);
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/mcp/analyze-github
 * Analyze a GitHub repository and generate automated grading
 */
router.post('/analyze-github', async (req, res, next) => {
  try {
    logger.info(`🔍 Received GitHub analysis request: ${req.body.repoUrl}`);
    
    // Validate request
    const { error, value } = githubAnalysisSchema.validate(req.body);
    if (error) {
      logger.warn(`Validation error: ${error.details[0].message}`);
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: error.details[0].message
      });
    }
    
    const { repoUrl, taskDescription, criteria, fileTypes, maxFiles } = value;
    
    logger.info(`📦 Analyzing repository: ${repoUrl}`);
    logger.info(`📝 Task description: ${taskDescription.substring(0, 100)}...`);
    
    // Analyze repository with MCP service
    const analysisResult = await mcpService.analyzeGitHubRepo(repoUrl, {
      criteria,
      fileTypes,
      taskDescription,
      maxFiles
    });
    
    logger.info(`✅ Analysis completed successfully for ${repoUrl}`);
    logger.info(`📊 Grade: ${analysisResult.grade || 'N/A'}/100`);
    
    // Return analysis result
    res.json({
      success: true,
      repository: analysisResult.repository || {
        fullName: repoUrl.replace(/^https?:\/\/github\.com\//, ''),
        url: repoUrl
      },
      grade: analysisResult.grade || 0,
      feedback: analysisResult.feedback || 'No feedback available',
      strengths: analysisResult.strengths || [],
      improvements: analysisResult.improvements || [],
      detailedAnalysis: analysisResult.detailedAnalysis || '',
      filesAnalyzed: analysisResult.filesAnalyzed || [],
      statistics: analysisResult.statistics || {}
    });
    
  } catch (error) {
    logger.error(`❌ Error analyzing GitHub repository: ${error.message}`);
    logger.error(error.stack);
    
    // Send user-friendly error response
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to analyze repository',
      hint: getGitHubErrorHint(error.message)
    });
  }
});

/**
 * Helper function to provide helpful error hints
 */
function getGitHubErrorHint(errorMessage) {
  if (!errorMessage) {
    return 'Asegúrate de que el servidor MCP esté ejecutándose y que la URL sea válida.';
  }
  
  if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
    return 'El repositorio no existe o es privado. Verifica la URL y que el repositorio sea público.';
  }
  
  if (errorMessage.includes('403') || errorMessage.includes('rate limit')) {
    return 'Límite de peticiones a GitHub alcanzado. Configura un GITHUB_TOKEN en las variables de entorno.';
  }
  
  if (errorMessage.includes('Invalid GitHub URL')) {
    return 'URL de GitHub inválida. Usa el formato: https://github.com/usuario/repositorio';
  }
  
  if (errorMessage.includes('LLM') || errorMessage.includes('API')) {
    return 'El servicio de IA no está disponible. Verifica la configuración de la API Key.';
  }
  
  return 'Error al acceder al repositorio. Verifica que la URL sea correcta y el repositorio sea público.';
}

export default router;
