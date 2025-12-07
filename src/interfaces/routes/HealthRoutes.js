/**
 * Health Check Routes
 * System health and status endpoints
 */

import express from 'express';
import { SupabaseService } from '../../infrastructure/database/SupabaseService.js';
import { CacheService } from '../../infrastructure/cache/CacheService.js';
import { logger } from '../../infrastructure/logging/Logger.js';

const router = express.Router();

/**
 * GET /health
 * Basic health check
 */
router.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'TareaMov MCP Server',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

/**
 * GET /health/status
 * Detailed health status
 */
router.get('/status', async (req, res, next) => {
  try {
    const supabase = SupabaseService.getInstance();
    const cache = CacheService.getInstance();
    
    // Check Supabase health
    const supabaseHealth = await supabase.healthCheck();
    
    // Check cache stats
    const cacheStats = cache.getStats();
    
    // Memory usage
    const memoryUsage = process.memoryUsage();
    
    const status = {
      status: 'healthy',
      service: 'TareaMov MCP Server',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      components: {
        supabase: supabaseHealth,
        cache: {
          status: 'healthy',
          stats: cacheStats
        },
        memory: {
          rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
          heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`
        }
      },
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch
      }
    };
    
    // Determine overall status
    if (supabaseHealth.status === 'unhealthy') {
      status.status = 'degraded';
    }
    
    res.json(status);
    
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /health/ready
 * Readiness probe (Kubernetes compatible)
 */
router.get('/ready', async (req, res) => {
  try {
    const supabase = SupabaseService.getInstance();
    await supabase.testConnection();
    
    res.status(200).json({
      ready: true,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      ready: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /health/live
 * Liveness probe (Kubernetes compatible)
 */
router.get('/live', (req, res) => {
  res.status(200).json({
    alive: true,
    timestamp: new Date().toISOString()
  });
});

export default router;
