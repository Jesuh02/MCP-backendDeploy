/**
 * Cache Service
 * In-memory caching with optional Redis support
 * Implements singleton pattern
 */

import NodeCache from 'node-cache';
import { logger } from '../logging/Logger.js';

export class CacheService {
  static instance = null;
  
  constructor() {
    if (CacheService.instance) {
      return CacheService.instance;
    }
    
    const ttl = parseInt(process.env.CACHE_TTL) || 3600; // 1 hour default
    const checkPeriod = ttl * 0.2; // Check for expired keys every 20% of TTL
    
    this.cache = new NodeCache({
      stdTTL: ttl,
      checkperiod: checkPeriod,
      useClones: false // Better performance, be careful with object mutations
    });
    
    this.enabled = process.env.CACHE_ENABLED !== 'false';
    
    // Setup event listeners
    this.cache.on('set', (key, value) => {
      logger.debug(`Cache SET: ${key}`);
    });
    
    this.cache.on('del', (key, value) => {
      logger.debug(`Cache DEL: ${key}`);
    });
    
    this.cache.on('expired', (key, value) => {
      logger.debug(`Cache EXPIRED: ${key}`);
    });
    
    CacheService.instance = this;
  }
  
  static getInstance() {
    if (!CacheService.instance) {
      CacheService.instance = new CacheService();
    }
    return CacheService.instance;
  }
  
  /**
   * Connect to cache (for Redis in future)
   */
  async connect() {
    logger.info('Cache service initialized (in-memory)');
    return true;
  }
  
  /**
   * Disconnect from cache
   */
  async disconnect() {
    this.cache.flushAll();
    this.cache.close();
    logger.info('Cache service disconnected');
  }
  
  /**
   * Get value from cache
   */
  get(key) {
    if (!this.enabled) return undefined;
    
    const value = this.cache.get(key);
    if (value !== undefined) {
      logger.debug(`Cache HIT: ${key}`);
    } else {
      logger.debug(`Cache MISS: ${key}`);
    }
    return value;
  }
  
  /**
   * Set value in cache
   */
  set(key, value, ttl) {
    if (!this.enabled) return false;
    
    return this.cache.set(key, value, ttl);
  }
  
  /**
   * Delete value from cache
   */
  delete(key) {
    if (!this.enabled) return false;
    
    return this.cache.del(key);
  }
  
  /**
   * Clear all cache
   */
  flush() {
    this.cache.flushAll();
    logger.info('Cache flushed');
  }
  
  /**
   * Get cache statistics
   */
  getStats() {
    return this.cache.getStats();
  }
  
  /**
   * Check if key exists
   */
  has(key) {
    if (!this.enabled) return false;
    
    return this.cache.has(key);
  }
  
  /**
   * Get or set pattern (cache-aside)
   */
  async getOrSet(key, fetchFunction, ttl) {
    if (!this.enabled) {
      return await fetchFunction();
    }
    
    let value = this.get(key);
    
    if (value === undefined) {
      value = await fetchFunction();
      this.set(key, value, ttl);
    }
    
    return value;
  }
}

export default CacheService;
