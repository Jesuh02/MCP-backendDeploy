/**
 * RAG Routes
 * API endpoints for Retrieval-Augmented Generation operations
 */

import express from 'express';
import { RAGService } from '../../domain/services/RAGService.js';
import { logger } from '../../infrastructure/logging/Logger.js';
import Joi from 'joi';

const router = express.Router();
const ragService = new RAGService();

// Validation schemas
const searchSchema = Joi.object({
  query: Joi.string().required().min(1).max(1000),
  topK: Joi.number().optional().min(1).max(20).default(5),
  threshold: Joi.number().optional().min(0).max(1).default(0.7)
});

/**
 * POST /api/v1/rag/search
 * Search knowledge base with semantic similarity
 */
router.post('/search', async (req, res, next) => {
  try {
    // Validate request
    const { error, value } = searchSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation Error',
        message: error.details[0].message
      });
    }
    
    const { query, topK, threshold } = value;
    
    // Execute search
    const results = await ragService.search(query, { topK, threshold });
    
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
 * Build context for a query
 */
router.post('/context', async (req, res, next) => {
  try {
    const { query, includeSchema, includeRAG, includeStats } = req.body;
    
    if (!query) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'query is required'
      });
    }
    
    const context = await ragService.buildContext(query, {
      includeSchema,
      includeRAG,
      includeStats
    });
    
    res.json({
      success: true,
      data: {
        query,
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
 * POST /api/v1/rag/smart-context
 * Build smart context with query analysis
 */
router.post('/smart-context', async (req, res, next) => {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'query is required'
      });
    }
    
    const analysis = ragService.analyzeQuery(query);
    const context = await ragService.buildSmartContext(query);
    
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
 * Get table context
 */
router.get('/table/:tableName', async (req, res, next) => {
  try {
    const { tableName } = req.params;
    const filters = req.query;
    
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

export default router;
