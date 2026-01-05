/**
 * RAG Routes - SOLID Compliant
 * API endpoints for Retrieval-Augmented Generation operations
 * 
 * SOLID Principles:
 * - S: Each route handler has a single responsibility
 * - O: Open for extension via middleware
 * - L: Uses interfaces that can be substituted
 * - I: Focused route definitions
 * - D: Depends on RAGService abstraction
 */

import express from 'express';
import { RAGService } from '../../domain/services/RAGService.js';
import { logger } from '../../infrastructure/logging/Logger.js';
import Joi from 'joi';

const router = express.Router();

// Lazy initialization - only create when needed
let ragServiceInstance = null;
const getRagService = () => {
  if (!ragServiceInstance) {
    ragServiceInstance = new RAGService();
  }
  return ragServiceInstance;
};

// Validation schemas (Interface Segregation - each schema for its purpose)
const searchSchema = Joi.object({
  query: Joi.string().required().min(1).max(2000),
  topK: Joi.number().optional().min(1).max(20).default(5),
  threshold: Joi.number().optional().min(0).max(1).default(0.7),
  courseId: Joi.number().optional(),
  topicId: Joi.number().optional(),
  taskId: Joi.number().optional()
});

const ingestSchema = Joi.object({
  content: Joi.string().required().min(10),
  fileName: Joi.string().required(),
  fileType: Joi.string().optional().default('txt'),
  courseId: Joi.number().optional(),
  topicId: Joi.number().optional(),
  taskId: Joi.number().optional()
});

const contextSchema = Joi.object({
  query: Joi.string().required().min(1).max(2000),
  courseId: Joi.number().optional(),
  topicId: Joi.number().optional(),
  taskId: Joi.number().optional(),
  taskTitle: Joi.string().optional(),
  taskDescription: Joi.string().optional(),
  topK: Joi.number().optional().min(1).max(20).default(7),
  maxTokens: Joi.number().optional().default(30000)
});

/**
 * GET /api/v1/rag/status
 * Check RAG service status
 */
router.get('/status', (req, res) => {
  const ragService = getRagService();
  res.json({
    success: true,
    data: {
      enabled: ragService.enabled,
      ready: ragService.isReady(),
      config: {
        topK: ragService.topK,
        threshold: ragService.threshold,
        maxContextTokens: ragService.maxContextTokens
      },
      timestamp: new Date().toISOString()
    }
  });
});

/**
 * POST /api/v1/rag/ingest
 * Ingest a document into the RAG system
 */
router.post('/ingest', async (req, res, next) => {
  try {
    const { error, value } = ingestSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation Error',
        message: error.details[0].message
      });
    }
    
    const { content, fileName, fileType, courseId, topicId, taskId } = value;
    const ragService = getRagService();
    
    const result = await ragService.ingestDocument(content, {
      fileName,
      fileType,
      courseId,
      topicId,
      taskId
    });
    
    res.json({
      success: result.success,
      data: {
        chunksStored: result.chunksStored,
        totalChunks: result.totalChunks,
        duration: result.duration,
        error: result.error
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/rag/search
 * Search knowledge base with semantic similarity
 */
router.post('/search', async (req, res, next) => {
  try {
    const { error, value } = searchSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation Error',
        message: error.details[0].message
      });
    }
    
    const { query, topK, threshold, courseId, topicId, taskId } = value;
    const ragService = getRagService();
    
    const results = await ragService.search(query, { 
      topK, 
      threshold,
      courseId,
      topicId,
      taskId
    });
    
    res.json({
      success: true,
      data: {
        query,
        results,
        count: results.length,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/rag/context
 * Build context for a query (for LLM consumption)
 */
router.post('/context', async (req, res, next) => {
  try {
    const { error, value } = contextSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation Error',
        message: error.details[0].message
      });
    }
    
    const { query, courseId, topicId, taskId, taskTitle, taskDescription, topK, maxTokens } = value;
    const ragService = getRagService();
    
    const context = await ragService.buildContext(query, {
      courseId,
      topicId,
      taskId,
      taskTitle,
      taskDescription,
      topK,
      maxTokens
    });
    
    res.json({
      success: true,
      data: {
        query,
        context,
        contextLength: context.length,
        estimatedTokens: Math.ceil(context.length * 0.25),
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/rag/smart-context
 * Build smart context with query analysis
 */
router.post('/smart-context', async (req, res, next) => {
  try {
    const { query, courseId, topicId, taskId } = req.body;
    
    if (!query) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'query is required'
      });
    }
    
    const ragService = getRagService();
    const analysis = ragService.analyzeQuery(query);
    const context = await ragService.buildSmartContext(query, {
      courseId,
      topicId,
      taskId
    });
    
    res.json({
      success: true,
      data: {
        query,
        analysis,
        context,
        contextLength: context.length,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/rag/table/:tableName
 * Get table context (legacy compatibility)
 */
router.get('/table/:tableName', async (req, res, next) => {
  try {
    const { tableName } = req.params;
    const filters = req.query;
    const ragService = getRagService();
    
    const data = await ragService.getTableContext(tableName, filters);
    
    res.json({
      success: true,
      data: {
        table: tableName,
        records: data,
        count: data.length,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/rag/documents
 * Delete documents from RAG by filter
 */
router.delete('/documents', async (req, res, next) => {
  try {
    const { fileName, courseId, taskId } = req.body;
    const ragService = getRagService();
    
    const deleted = await ragService.vectorStore.delete({
      fileName,
      courseId,
      taskId
    });
    
    res.json({
      success: true,
      data: {
        deleted,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    next(error);
  }
});

export default router;
