/**
 * RAG Service - Retrieval-Augmented Generation
 * Implements vector search and semantic retrieval from Supabase
 */

import { SupabaseService } from '../../infrastructure/database/SupabaseService.js';
import { CacheService } from '../../infrastructure/cache/CacheService.js';
import { logger } from '../../infrastructure/logging/Logger.js';
import { EmbeddingService } from '../../infrastructure/ai/EmbeddingService.js';
import { DocumentProcessor } from './DocumentProcessor.js';

export class RAGService {
  constructor() {
    this.supabase = SupabaseService.getInstance();
    this.cache = CacheService.getInstance();
    this.embeddingService = EmbeddingService.getInstance();
    this.documentProcessor = new DocumentProcessor();
    this.topK = parseInt(process.env.RAG_TOP_K) || 5;
    this.chunkSize = parseInt(process.env.RAG_CHUNK_SIZE) || 1000;
    this.enabled = process.env.RAG_ENABLED !== 'false';
  }
  
  /**
   * Ingest a file into the knowledge base
   * Splits text, generates embeddings, and stores in DB
   */
  async ingestFile(content, metadata = {}) {
    if (!content || !this.enabled) return 0;

    try {
        logger.info(`Ingesting file: ${metadata.fileName || 'unknown'}`);
        
        // 1. Split text into chunks
        const chunks = await this.documentProcessor.splitText(content);
        logger.info(`Split document into ${chunks.length} chunks`);

        // 2. Generate embeddings and store
        // Process in batches to avoid rate limits
        const batchSize = 10;
        let storedCount = 0;

        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            
            try {
                const embeddings = await this.embeddingService.embedDocuments(batch);
                
                for (let j = 0; j < batch.length; j++) {
                    await this.supabase.insertKnowledgeBase(batch[j], metadata, embeddings[j]);
                    storedCount++;
                }
            } catch (e) {
                logger.error(`Error processing batch ${i}:`, e);
            }
        }
        
        logger.info(`Successfully stored ${storedCount} chunks`);
        return storedCount;
    } catch (error) {
        logger.error('Error ingesting file:', error);
        throw error;
    }
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
      
      // 1. Generate embedding for query
      const embedding = await this.embeddingService.embedQuery(query);
      
      // 2. Execute vector search
      const results = await this.supabase.matchDocuments(embedding, threshold, topK);
      
      // Cache results
      this.cache.set(cacheKey, results, 1800); // 30 minutes
      
      logger.info(`RAG search returned ${results.length} results for query: ${query}`);
      
      return results;
    } catch (error) {
      logger.error('RAG search error:', error);
      // Fallback to keyword search if embedding fails
      try {
          return await this.supabase.executeRAGQuery(query, topK);
      } catch (e) {
          return [];
      }
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
    return this.ingestFile(content, metadata);
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
