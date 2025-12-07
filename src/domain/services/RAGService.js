/**
 * RAG Service - Retrieval-Augmented Generation
 * Implements vector search and semantic retrieval from Supabase
 */

import { SupabaseService } from '../../infrastructure/database/SupabaseService.js';
import { CacheService } from '../../infrastructure/cache/CacheService.js';
import { logger } from '../../infrastructure/logging/Logger.js';

export class RAGService {
  constructor() {
    this.supabase = SupabaseService.getInstance();
    this.cache = CacheService.getInstance();
    this.topK = parseInt(process.env.RAG_TOP_K) || 5;
    this.chunkSize = parseInt(process.env.RAG_CHUNK_SIZE) || 1000;
    this.enabled = process.env.RAG_ENABLED === 'true';
  }
  
  /**
   * Search knowledge base with semantic similarity
   */
  async search(query, options = {}) {
    try {
      const {
        topK = this.topK,
        threshold = 0.7,
        includeMetadata = true
      } = options;
      
      if (!this.enabled) {
        logger.warn('RAG is disabled');
        return [];
      }
      
      // Check cache first
      const cacheKey = `rag:${query}:${topK}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        logger.debug('RAG cache hit');
        return cached;
      }
      
      // Execute vector search
      const results = await this.supabase.executeRAGQuery(query, topK);
      
      // Filter by threshold
      const filtered = results.filter(r => r.similarity >= threshold);
      
      // Cache results
      this.cache.set(cacheKey, filtered, 1800); // 30 minutes
      
      logger.info(`RAG search returned ${filtered.length} results for query: ${query}`);
      
      return filtered;
    } catch (error) {
      logger.error('RAG search error:', error);
      throw error;
    }
  }
  
  /**
   * Build context from database for a specific query
   */
  async buildContext(query, options = {}) {
    try {
      const {
        includeSchema = true,
        includeRAG = true,
        includeStats = true
      } = options;
      
      let context = '';
      
      // Add database schema
      if (includeSchema) {
        const schema = await this.supabase.getDatabaseSchema();
        context += '# Database Schema\n\n';
        
        for (const [table, info] of Object.entries(schema)) {
          if (info.exists) {
            context += `- **${table}**: ${info.count} records\n`;
          }
        }
        context += '\n';
      }
      
      // Add RAG results
      if (includeRAG && query) {
        const ragResults = await this.search(query, { topK: 3 });
        
        if (ragResults.length > 0) {
          context += '# Relevant Information\n\n';
          ragResults.forEach((result, idx) => {
            context += `## Result ${idx + 1} (${(result.similarity * 100).toFixed(1)}% match)\n`;
            context += `${result.content}\n\n`;
          });
        }
      }
      
      // Add system rules
      context += '# System Rules\n\n';
      context += '- **Valid Roles**: usuario, admin (ONLY)\n';
      context += '- **Total Tables**: 14\n';
      context += '- **Platform**: Educational system with courses, videos, tasks\n\n';
      
      return context;
    } catch (error) {
      logger.error('Error building RAG context:', error);
      throw error;
    }
  }
  
  /**
   * Add content to knowledge base
   */
  async addKnowledge(content, metadata = {}) {
    try {
      const result = await this.supabase.insertKnowledgeBase(content, metadata);
      
      logger.info('Knowledge added to base:', { id: result.id });
      
      // Invalidate relevant caches
      this.cache.flush();
      
      return result;
    } catch (error) {
      logger.error('Error adding knowledge:', error);
      throw error;
    }
  }
  
  /**
   * Get table-specific context
   */
  async getTableContext(tableName, filters = {}) {
    try {
      const cacheKey = `table:${tableName}:${JSON.stringify(filters)}`;
      
      return await this.cache.getOrSet(cacheKey, async () => {
        const data = await this.supabase.getTableContext(tableName, filters, 50);
        return data;
      }, 600); // 10 minutes
      
    } catch (error) {
      logger.error(`Error getting context for ${tableName}:`, error);
      throw error;
    }
  }
  
  /**
   * Smart query analysis - determine what data to fetch
   */
  analyzeQuery(query) {
    const lowerQuery = query.toLowerCase();
    
    const analysis = {
      tables: [],
      intent: 'general',
      requiresRAG: true,
      requiresSchema: false
    };
    
    // Table detection
    const tableKeywords = {
      'usuarios': ['usuario', 'user', 'cuenta'],
      'personas': ['persona', 'personal', 'perfil'],
      'courses': ['curso', 'course', 'clase'],
      'videos': ['video', 'multimedia'],
      'tasks': ['tarea', 'task', 'actividad'],
      'topics': ['tema', 'topic', 'módulo'],
      'subscriptions': ['suscripción', 'seguir', 'subscription'],
      'roles': ['rol', 'role', 'permiso']
    };
    
    for (const [table, keywords] of Object.entries(tableKeywords)) {
      if (keywords.some(kw => lowerQuery.includes(kw))) {
        analysis.tables.push(table);
      }
    }
    
    // Intent detection
    if (lowerQuery.includes('esquema') || lowerQuery.includes('estructura') || 
        lowerQuery.includes('tablas')) {
      analysis.intent = 'schema';
      analysis.requiresSchema = true;
      analysis.requiresRAG = false;
    } else if (lowerQuery.includes('cuántos') || lowerQuery.includes('total') || 
               lowerQuery.includes('count')) {
      analysis.intent = 'statistics';
    } else if (lowerQuery.includes('busca') || lowerQuery.includes('encuentra') || 
               lowerQuery.includes('search')) {
      analysis.intent = 'search';
    }
    
    return analysis;
  }
  
  /**
   * Comprehensive context builder with smart query analysis
   */
  async buildSmartContext(query) {
    try {
      const analysis = this.analyzeQuery(query);
      
      logger.info('Query analysis:', analysis);
      
      let context = '';
      
      // Build context based on analysis
      if (analysis.requiresSchema) {
        context += await this.buildContext(query, {
          includeSchema: true,
          includeRAG: false
        });
      } else if (analysis.tables.length > 0) {
        // Fetch specific table data
        context += '# Relevant Data\n\n';
        
        for (const table of analysis.tables) {
          const data = await this.getTableContext(table);
          context += `## ${table} (${data.length} records)\n`;
          context += '```json\n';
          context += JSON.stringify(data.slice(0, 10), null, 2);
          context += '\n```\n\n';
        }
      }
      
      // Always include RAG if enabled
      if (analysis.requiresRAG) {
        const ragContext = await this.buildContext(query, {
          includeSchema: false,
          includeRAG: true
        });
        context += ragContext;
      }
      
      return context;
    } catch (error) {
      logger.error('Error building smart context:', error);
      throw error;
    }
  }
}

export default RAGService;
