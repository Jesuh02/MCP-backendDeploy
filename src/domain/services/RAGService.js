/**
 * RAGService - Retrieval-Augmented Generation
 * 
 * SOLID Principles Applied:
 * - S: This service orchestrates RAG operations (single responsibility: RAG flow)
 * - O: Open for extension via dependency injection of providers
 * - L: All providers implement interfaces, can be substituted
 * - I: Uses focused interfaces (IEmbeddingProvider, IVectorStore, IDocumentProcessor)
 * - D: Depends on abstractions (interfaces), not concrete implementations
 * 
 * RAG Flow:
 * 1. Document Ingestion: PDF → Extract Text → Split Chunks → Generate Embeddings → Store
 * 2. Query: Question → Embedding → Vector Search → Retrieve Relevant Chunks → LLM Context
 */

import { SupabaseService } from '../../infrastructure/database/SupabaseService.js';
import { SupabaseVectorStore } from '../../infrastructure/database/SupabaseVectorStore.js';
import { CacheService } from '../../infrastructure/cache/CacheService.js';
import { EmbeddingService } from '../../infrastructure/ai/EmbeddingService.js';
import { RerankService } from '../../infrastructure/ai/RerankService.js';
import { DocumentProcessor } from './DocumentProcessor.js';
import { logger } from '../../infrastructure/logging/Logger.js';

export class RAGService {
    constructor(options = {}) {
        // Dependency Injection - allows swapping implementations
        this.supabase = options.supabase || SupabaseService.getInstance();
        this.vectorStore = options.vectorStore || SupabaseVectorStore.getInstance();
        this.cache = options.cache || CacheService.getInstance();
        this.embeddingService = options.embeddingService || EmbeddingService.getInstance();
        this.documentProcessor = options.documentProcessor || new DocumentProcessor({
            chunkSize: parseInt(process.env.RAG_CHUNK_SIZE) || 800,
            chunkOverlap: parseInt(process.env.RAG_CHUNK_OVERLAP) || 150
        });

        this.topK = parseInt(process.env.RAG_TOP_K) || 5;
        this.threshold = parseFloat(process.env.RAG_THRESHOLD) || 0.7;
        this.enabled = process.env.RAG_ENABLED !== 'false';
        this.maxContextTokens = parseInt(process.env.RAG_MAX_CONTEXT_TOKENS) || 30000;
    }

    /**
     * Check if RAG service is ready
     */
    isReady() {
        return this.enabled && this.embeddingService.isReady();
    }

    /**
     * ═══════════════════════════════════════════════════════════════════
     * DOCUMENT INGESTION PIPELINE
     * PDF → Extract Text → Split Chunks → Generate Embeddings → Store
     * ═══════════════════════════════════════════════════════════════════
     */

    /**
     * Ingest a document into the RAG system
     * @param {Buffer|string} content - Document content
     * @param {object} metadata - Document metadata (courseId, topicId, taskId, fileName, fileType)
     * @returns {Promise<{success: boolean, chunksStored: number, error?: string}>}
     */
    async ingestDocument(content, metadata = {}) {
        if (!this.enabled) {
            return { success: false, chunksStored: 0, error: 'RAG is disabled' };
        }

        // Prevent duplicate processing if content already exists for this task/topic
        // This solves the issue of re-processing chunks when revisiting the screen
        if (metadata.courseId && (metadata.topicId || metadata.taskId)) {
            try {
                const exists = await this.vectorStore.exists({
                    courseId: metadata.courseId,
                    topicId: metadata.topicId,
                    taskId: metadata.taskId
                });

                if (exists) {
                    logger.info(`ℹ️ Skipping RAG ingestion: Content already exists for Course=${metadata.courseId} Topic=${metadata.topicId} Task=${metadata.taskId}`);
                    return {
                        success: true,
                        chunksStored: 0,
                        skipped: true,
                        message: `Content already exists for task_id=${metadata.taskId}`
                    };
                }
            } catch (checkError) {
                logger.warn('Failed to check existence, proceeding with ingestion:', checkError);
            }
        }

        const startTime = Date.now();
        logger.info(`📥 Starting document ingestion: ${metadata.fileName || 'unknown'}`);

        try {
            // Step 1: Extract text from document
            const extractedText = await this.documentProcessor.extractText(
                content,
                metadata.fileType || this._detectFileType(metadata.fileName)
            );

            if (!extractedText || extractedText.length < 50) {
                return {
                    success: false,
                    chunksStored: 0,
                    error: 'Document is empty or could not be parsed'
                };
            }

            logger.info(`📄 Extracted ${extractedText.length} characters from document`);

            // Step 2: Split into chunks
            const chunks = await this.documentProcessor.splitText(extractedText);
            logger.info(`✂️ Split into ${chunks.length} chunks`);

            if (chunks.length === 0) {
                return { success: false, chunksStored: 0, error: 'No valid chunks created' };
            }

            // Step 3: Delete existing chunks for this document (avoid duplicates)
            if (metadata.fileName) {
                await this.vectorStore.delete({
                    fileName: metadata.fileName,
                    courseId: metadata.courseId,
                    taskId: metadata.taskId
                });
            }

            // Step 4: Generate embeddings and store (in batches)
            const batchSize = 5;
            let storedCount = 0;

            for (let i = 0; i < chunks.length; i += batchSize) {
                const batch = chunks.slice(i, i + batchSize);

                try {
                    // Generate embeddings for batch
                    const embeddings = await this.embeddingService.embedDocuments(batch);

                    // Store each chunk with its embedding
                    for (let j = 0; j < batch.length; j++) {
                        const chunkMetadata = {
                            ...metadata,
                            // Explicitly ensure topic_id is sent (fixes topic_id missing issue)
                            topic_id: metadata.topic_id || metadata.topicId,
                            chunkIndex: i + j,
                            totalChunks: chunks.length
                        };

                        await this.vectorStore.store(batch[j], embeddings[j], chunkMetadata);
                        storedCount++;
                    }

                    // Progress log
                    if ((i + batchSize) % 20 === 0) {
                        logger.info(`   Progress: ${Math.min(i + batchSize, chunks.length)}/${chunks.length} chunks stored`);
                    }
                } catch (batchError) {
                    logger.error(`Error processing batch ${i}:`, batchError);
                    // Continue with next batch
                }
            }

            const duration = Date.now() - startTime;
            logger.info(`✅ Document ingestion complete: ${storedCount}/${chunks.length} chunks in ${duration}ms`);

            // Clear related cache
            this._invalidateCache(metadata);

            return {
                success: true,
                chunksStored: storedCount,
                totalChunks: chunks.length,
                duration
            };

        } catch (error) {
            logger.error('❌ Document ingestion failed:', error);
            return {
                success: false,
                chunksStored: 0,
                error: error.message
            };
        }
    }

    /**
     * Ingest multiple documents (e.g., all files in a course)
     */
    async ingestDocuments(documents) {
        const results = [];
        for (const doc of documents) {
            const result = await this.ingestDocument(doc.content, doc.metadata);
            results.push(result);
        }
        return results;
    }

    /**
     * ═══════════════════════════════════════════════════════════════════
     * QUERY / RETRIEVAL PIPELINE  
     * Question → Embedding → Vector Search → Relevant Chunks
     * ═══════════════════════════════════════════════════════════════════
     */

    /**
     * Search for relevant document chunks
     * @param {string} query - The search query / question
     * @param {object} options - Search options
     * @returns {Promise<object[]>} - Array of relevant chunks with similarity scores
     */
    async search(query, options = {}) {
        const {
            topK = this.topK,
                threshold = this.threshold,
                courseId = null,
                topicId = null,
                taskId = null
        } = options;

        if (!this.enabled) {
            logger.warn('RAG is disabled, returning empty results');
            return [];
        }

        // Check cache
        const cacheKey = `rag:search:${query}:${courseId}:${topicId}:${taskId}:${topK}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            logger.debug('🎯 RAG cache hit');
            return cached;
        }

        try {
            logger.info(`🔍 RAG Search: "${query.substring(0, 50)}..."`);

            // Generate embedding for query
            const queryEmbedding = await this.embeddingService.embedQuery(query);

            // Search vector store
            const results = await this.vectorStore.search(
                queryEmbedding,
                topK,
                threshold, { courseId, topicId, taskId }
            );

            // Cache results
            this.cache.set(cacheKey, results, 900); // 15 minutes

            logger.info(`🎯 Found ${results.length} relevant chunks (threshold: ${threshold})`);
            return results;

        } catch (error) {
            logger.error('RAG search error:', error);
            return [];
        }
    }

    /**
     * ═══════════════════════════════════════════════════════════════════
     * CONTEXT BUILDING FOR LLM
     * Combines retrieved chunks into optimized context for the LLM
     * ═══════════════════════════════════════════════════════════════════
     */

    /**
     * Build context from relevant chunks for LLM
     * @param {string} query - The user's question
     * @param {object} options - Context options
     * @returns {Promise<string>} - Formatted context string
     */
    async buildContext(query, options = {}) {
        const {
            courseId = null,
                topicId = null,
                taskId = null,
                taskTitle = null,
                taskDescription = null,
                topK = this.topK,
                maxTokens = this.maxContextTokens
        } = options;

        try {
            // Build search query combining user query with task context
            let enhancedQuery = query;
            if (taskTitle) enhancedQuery += ` ${taskTitle}`;
            if (taskDescription) enhancedQuery += ` ${taskDescription}`;

            // Search for relevant chunks
            const chunks = await this.search(enhancedQuery, {
                topK,
                courseId,
                topicId,
                taskId
            });

            if (chunks.length === 0) {
                logger.warn('No relevant chunks found for context');
                return '';
            }

            // Build context string with token limit
            let context = '';
            let estimatedTokens = 0;
            const tokensPerChar = 0.25; // Rough estimate: 4 chars per token

            context += '═══════════════════════════════════════════════════════════\n';
            context += '📚 CONTEXTO RELEVANTE DEL MATERIAL DEL CURSO (RAG)\n';
            context += '═══════════════════════════════════════════════════════════\n\n';

            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const chunkText = chunk.content || chunk.text || '';
                const similarity = chunk.similarity || 0;

                const chunkEntry = `📄 Fragmento ${i + 1} (${Math.round(similarity * 100)}% relevante):\n${chunkText}\n\n`;

                const chunkTokens = Math.ceil(chunkEntry.length * tokensPerChar);

                if (estimatedTokens + chunkTokens > maxTokens) {
                    logger.info(`Context truncated at ${i} chunks to fit token limit`);
                    break;
                }

                context += chunkEntry;
                estimatedTokens += chunkTokens;
            }

            context += '═══════════════════════════════════════════════════════════\n';
            context += `Total: ${chunks.length} fragmentos recuperados del material del curso.\n`;
            context += 'INSTRUCCIÓN: Usa ÚNICAMENTE la información de estos fragmentos para responder.\n';
            context += '═══════════════════════════════════════════════════════════\n';

            logger.info(`📝 Built context with ~${estimatedTokens} estimated tokens from ${chunks.length} chunks`);
            return context;

        } catch (error) {
            logger.error('Error building RAG context:', error);
            return '';
        }
    }

    /**
     * Get all raw text content from rag_documents for a given filter.
     * Returns deduplicated, ordered document content for strict grounding.
     * @param {{ courseId?: number, topicId?: number, taskId?: number }} filter
     * @returns {Promise<{ content: string, chunks: number, files: string[] }>}
     */
    async getRagContent(filter = {}) {
        try {
            const chunks = await this.vectorStore.getContentChunks(filter);

            if (!chunks || chunks.length === 0) {
                return { content: '', chunks: 0, files: [] };
            }

            // Group chunks by file and reassemble in order
            const fileMap = new Map();
            for (const chunk of chunks) {
                const key = chunk.fileName || 'unknown';
                if (!fileMap.has(key)) fileMap.set(key, []);
                fileMap.get(key).push(chunk);
            }

            let fullContent = '';
            const fileNames = [];

            for (const [fileName, fileChunks] of fileMap) {
                fileNames.push(fileName);
                fileChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
                const fileText = fileChunks.map(c => c.content).join('\n');
                fullContent += `\n--- DOCUMENTO: ${fileName} ---\n${fileText}\n`;
            }

            logger.info(`📄 getRagContent: ${chunks.length} chunks from ${fileNames.length} files`);

            return {
                content: fullContent.trim(),
                chunks: chunks.length,
                files: fileNames,
            };
        } catch (error) {
            logger.error('Error in getRagContent:', error);
            return { content: '', chunks: 0, files: [] };
        }
    }

    /**
     * Returns a progressive window of RAG content for quiz generation.
     *
     * Instead of always returning ALL chunks (which causes the LLM to see
     * the same content and generate duplicate questions), this method returns
     * a different "page" of chunks based on the sessionIndex.
     *
     * Chunk Windowing:
     *   Session 0 → chunks [0..7]
     *   Session 1 → chunks [6..13]   (2-chunk overlap for context continuity)
     *   Session 2 → chunks [12..19]
     *   ... wraps around when document is exhausted.
     *
     * @param {{ courseId?: number, topicId?: number, taskId?: number }} filter
     * @param {number} sessionIndex - Zero-based session counter (e.g. existingQuestions / 10)
     * @param {{ windowSize?: number, overlap?: number }} options
     * @returns {Promise<{ content: string, chunks: number, files: string[], page: number, totalPages: number, totalChunks: number }>}
     */
    async getProgressiveRagContent(filter = {}, sessionIndex = 0, options = {}) {
        const windowSize = options.windowSize || 8;
        const overlap = options.overlap || 2;

        try {
            const result = await this.vectorStore.getChunkPage(filter, sessionIndex, windowSize, overlap);

            if (!result.chunks || result.chunks.length === 0) {
                // Fallback: if paginated retrieval returns nothing, try all chunks
                logger.warn('Progressive chunk page empty, falling back to full content');
                const fallback = await this.getRagContent(filter);
                return { ...fallback, page: 0, totalPages: 1, totalChunks: fallback.chunks };
            }

            // Group chunks by file and reassemble in order
            const fileMap = new Map();
            for (const chunk of result.chunks) {
                const key = chunk.fileName || 'unknown';
                if (!fileMap.has(key)) fileMap.set(key, []);
                fileMap.get(key).push(chunk);
            }

            let fullContent = '';
            const fileNames = [];

            for (const [fileName, fileChunks] of fileMap) {
                fileNames.push(fileName);
                fileChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
                const fileText = fileChunks.map(c => c.content).join('\n');
                fullContent += `\n--- DOCUMENTO: ${fileName} (Sección ${result.page + 1}/${result.totalPages}) ---\n${fileText}\n`;
            }

            logger.info(
                `📄 getProgressiveRagContent: page=${result.page + 1}/${result.totalPages}, ` +
                `chunks=${result.chunks.length}/${result.totalChunks}, files=${fileNames.length}`
            );

            return {
                content: fullContent.trim(),
                chunks: result.chunks.length,
                files: fileNames,
                page: result.page,
                totalPages: result.totalPages,
                totalChunks: result.totalChunks,
            };
        } catch (error) {
            logger.error('Error in getProgressiveRagContent:', error);
            // Graceful degradation — return full content on error
            return { ...(await this.getRagContent(filter)), page: 0, totalPages: 1, totalChunks: 0 };
        }
    }

    /**
     * ═══════════════════════════════════════════════════════════════════
     * HYBRID RETRIEVAL ARCHITECTURE (v2 — Clean Context)
     * Primary: Semantic Search + Window Expansion
     * Fallback: Progressive Coverage (ONLY when semantic returns 0 results)
     *
     * Architecture:
     *   1. Semantic Search:  finds the most relevant chunks for the query
     *   2. Window Expansion: expands ±N around each semantic hit for full context
     *   3. Deduplication:    removes overlapping chunks
     *   4. Token Limit:      caps output at maxTokens
     *
     * Progressive coverage is ONLY used as a fallback when semantic search
     * returns zero results (e.g., no embeddings, bad query, or empty index).
     * Mixing progressive with semantic pollutes the LLM context with
     * irrelevant document sections, causing poor question generation.
     * ═══════════════════════════════════════════════════════════════════
     */

    /**
     * Hybrid Retrieval: Semantic Search + Window Expansion.
     * Progressive coverage is used ONLY as fallback when semantic returns 0 results.
     *
     * @param {string} query - The question or topic to search for
     * @param {{ courseId?: number, topicId?: number, taskId?: number }} filter
     * @param {object} options
     * @param {number} [options.semanticTopK=5]     - Number of semantic search results
     * @param {number} [options.windowSize=2]       - Chunks to expand before/after each hit (±N)
     * @param {number} [options.semanticThreshold=0.45] - Minimum similarity for semantic results
     * @param {number} [options.sessionIndex]       - Page index for progressive fallback (only used if semantic=0)
     * @param {number} [options.maxTokens]          - Maximum estimated tokens in output
     * @param {number} [options.maxChunks=12]       - Maximum number of chunks in final output
     * @returns {Promise<{ content: string, chunks: number, files: string[], semanticHits: number, expandedChunks: number, page?: number, totalPages?: number, totalChunks?: number }>}
     */
    async getHybridRagContent(query, filter = {}, options = {}) {
        const {
            semanticTopK = 5,
            windowSize = 2,
            semanticThreshold = 0.45,
            sessionIndex = null,
            maxTokens = this.maxContextTokens,
            maxChunks = 12,
            rerank = process.env.RERANK_ENABLED !== 'false',
            topicName = null,
            taskTitle = null,
        } = options;

        try {
            if (!this.enabled) {
                return { content: '', chunks: 0, files: [], semanticHits: 0, expandedChunks: 0 };
            }

            // ══════════════════════════════════════════════════════════════
            // Step 1: Semantic Search — find most relevant chunks
            // Filters by courseId + topicId + taskId metadata BEFORE search
            // ══════════════════════════════════════════════════════════════
            let semanticResults = [];
            if (query && query.trim().length > 0) {
                try {
                    semanticResults = await this.search(query, {
                        topK: semanticTopK,
                        threshold: semanticThreshold,
                        courseId: filter.courseId,
                        topicId: filter.topicId,
                        taskId: filter.taskId,
                    });
                    logger.info(`[HybridRAG] Semantic search: ${semanticResults.length} hits for query="${query.substring(0, 80)}..." (filter: courseId=${filter.courseId}, topicId=${filter.topicId}, taskId=${filter.taskId})`);
                } catch (searchErr) {
                    logger.warn('[HybridRAG] Semantic search failed:', searchErr.message);
                }

                // If filtered search returned 0 results and we had topicId/taskId filters,
                // retry WITHOUT topicId/taskId to catch chunks with null metadata (ingestion fallback)
                if (semanticResults.length === 0 && (filter.topicId || filter.taskId)) {
                    try {
                        logger.info('[HybridRAG] Retrying semantic search without topicId/taskId filters (null metadata fallback)');
                        semanticResults = await this.search(query, {
                            topK: semanticTopK,
                            threshold: semanticThreshold,
                            courseId: filter.courseId,
                            // Omit topicId and taskId to catch chunks with null FKs
                        });
                        logger.info(`[HybridRAG] Unfiltered semantic retry: ${semanticResults.length} hits`);
                    } catch (retryErr) {
                        logger.warn('[HybridRAG] Unfiltered semantic retry also failed:', retryErr.message);
                    }
                }
            }

            const semanticHits = semanticResults.length;

            // ══════════════════════════════════════════════════════════════
            // Step 2: Extract chunk indices from semantic results
            // ══════════════════════════════════════════════════════════════
            let seedIndices = [];
            if (semanticHits > 0) {
                try {
                    seedIndices = semanticResults
                        .map(r => {
                            const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
                            return meta.chunkIndex ?? meta.chunk_index ?? null;
                        })
                        .filter(idx => idx !== null && idx !== undefined);
                } catch (metaErr) {
                    logger.warn('[HybridRAG] Error extracting chunk indices:', metaErr.message);
                }
            }

            // ══════════════════════════════════════════════════════════════
            // Step 3: Window Expansion — expand ±N around each semantic hit
            // ══════════════════════════════════════════════════════════════
            let expandedChunks = [];
            if (seedIndices.length > 0) {
                try {
                    expandedChunks = await this.vectorStore.getChunksAround(filter, seedIndices, windowSize);
                } catch (expandErr) {
                    logger.warn('[HybridRAG] Window expansion failed:', expandErr.message);
                }
            }

            // If window expansion returned nothing, fall back to raw semantic content
            if (expandedChunks.length === 0 && semanticHits > 0) {
                expandedChunks = semanticResults.map((r, i) => ({
                    content: r.content || r.text || '',
                    fileName: (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {})).fileName || 'semantic_result',
                    chunkIndex: i,
                }));
            }

            // ══════════════════════════════════════════════════════════════
            // Step 4: Progressive — ONLY as FALLBACK when semantic = 0
            // This prevents polluting relevant context with unrelated chunks.
            // ══════════════════════════════════════════════════════════════
            let progressiveData = null;
            const usedProgressiveFallback = expandedChunks.length === 0;

            if (usedProgressiveFallback && sessionIndex !== null && sessionIndex !== undefined) {
                logger.info(`[HybridRAG] Semantic returned 0 results → using progressive fallback (sessionIndex=${sessionIndex})`);
                try {
                    progressiveData = await this.getProgressiveRagContent(filter, sessionIndex, {
                        windowSize: 4,
                        overlap: 1,
                    });

                    if (progressiveData && progressiveData.content) {
                        const progressiveChunks = this._parseProgressiveContent(progressiveData.content);
                        expandedChunks = progressiveChunks;
                    }
                } catch (progressErr) {
                    logger.warn('[HybridRAG] Progressive fallback failed:', progressErr.message);
                }
            } else if (expandedChunks.length > 0 && sessionIndex !== null) {
                // Semantic DID return results — DO NOT mix progressive.
                // Just fetch progressive metadata for page info (without merging content).
                try {
                    progressiveData = await this.getProgressiveRagContent(filter, sessionIndex, {
                        windowSize: 4,
                        overlap: 1,
                    });
                    // Only keep metadata (page, totalPages, totalChunks), NOT content
                    if (progressiveData) {
                        progressiveData = {
                            page: progressiveData.page,
                            totalPages: progressiveData.totalPages,
                            totalChunks: progressiveData.totalChunks,
                            content: null, // Explicitly null — we don't want this content
                        };
                    }
                } catch (_) {
                    // Non-critical — page metadata is nice-to-have
                }
            }

            // ══════════════════════════════════════════════════════════════
            // Step 5: If still no content, full fallback
            // ══════════════════════════════════════════════════════════════
            if (expandedChunks.length === 0) {
                logger.warn('[HybridRAG] No content from any retrieval strategy, falling back to full getRagContent');
                const fallback = await this.getRagContent(filter);
                return {
                    ...fallback,
                    semanticHits: 0,
                    expandedChunks: 0,
                    reranked: false,
                    rerankMethod: 'none',
                    page: 0,
                    totalPages: 1,
                    totalChunks: fallback.chunks,
                };
            }

            // ══════════════════════════════════════════════════════════════
            // Step 5.5: RERANKING — reorder chunks by TRUE relevance
            // Semantic search embeddings approximate relevance but can
            // return wrong ordering (e.g. "mitosis animales" above
            // "mitosis plantas" for query "mitosis en plantas").
            //
            // Provider cascade (auto mode):
            //   1. Cohere cross-encoder (rerank-v3.5) — BEST accuracy
            //   2. Jina cross-encoder (v2-multilingual) — great free tier
            //   3. Voyage AI cross-encoder (rerank-2)
            //   4. Embedding semantic (bi-encoder + BM25) — FREE, uses existing embeddings
            //   5. TF-IDF + BM25 keyword fallback — always available
            // ══════════════════════════════════════════════════════════════
            let reranked = false;
            let rerankMethod = 'none';

            if (rerank && expandedChunks.length >= 3 && query && query.trim().length > 0) {
                try {
                    const rerankService = RerankService.getInstance();
                    const rerankResult = await rerankService.rerank(query, expandedChunks, {
                        topK: maxChunks,
                        topicName: topicName || null,
                        taskTitle: taskTitle || null,
                    });

                    if (rerankResult.reranked) {
                        expandedChunks = rerankResult.chunks;
                        reranked = true;
                        rerankMethod = rerankResult.method;
                        logger.info(
                            `🔄 [HybridRAG] Reranked ${expandedChunks.length} chunks via ${rerankMethod}. ` +
                            `Top score: ${expandedChunks[0]?.rerankScore ?? 'N/A'}`
                        );
                    }
                } catch (rerankErr) {
                    logger.warn(`[HybridRAG] Reranking failed (non-blocking): ${rerankErr.message}`);
                }
            }

            // ══════════════════════════════════════════════════════════════
            // Step 6: Deduplicate + Limit chunks
            // If reranked, preserve rerank order; otherwise sort by chunkIndex.
            // ══════════════════════════════════════════════════════════════
            const deduped = [];
            const seenContents = new Set();
            for (const chunk of expandedChunks) {
                const sig = chunk.content.substring(0, 150).trim();
                if (!seenContents.has(sig)) {
                    deduped.push(chunk);
                    seenContents.add(sig);
                }
            }
            // If reranked, preserve rerank order (most relevant first).
            // Otherwise, sort by chunkIndex for coherent reading order.
            if (!reranked) {
                deduped.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
            }
            // else: deduped already in rerank order (highest rerankScore first)
            const finalChunks = deduped.slice(0, maxChunks);

            // ══════════════════════════════════════════════════════════════
            // Step 7: Build formatted content with token limit
            // ══════════════════════════════════════════════════════════════
            const fileMap = new Map();
            for (const chunk of finalChunks) {
                const key = chunk.fileName || 'unknown';
                if (!fileMap.has(key)) fileMap.set(key, []);
                fileMap.get(key).push(chunk);
            }

            let fullContent = '';
            const fileNames = [];
            const tokensPerChar = 0.25;
            let estimatedTokens = 0;

            for (const [fileName, fileChunks] of fileMap) {
                fileNames.push(fileName);
                fileChunks.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));

                const fileText = fileChunks.map(c => c.content).join('\n');
                const retrievalLabel = usedProgressiveFallback
                    ? ` (Cobertura progresiva — Sección ${(progressiveData?.page ?? 0) + 1}/${progressiveData?.totalPages ?? '?'})`
                    : ` (Búsqueda semántica: ${semanticHits} coincidencias + contexto expandido ±${windowSize}${reranked ? ` + reranking ${rerankMethod}` : ''})`;

                const entry = `\n--- DOCUMENTO: ${fileName}${retrievalLabel} ---\n${fileText}\n`;
                const entryTokens = Math.ceil(entry.length * tokensPerChar);

                if (maxTokens && estimatedTokens + entryTokens > maxTokens) {
                    logger.info('[HybridRAG] Token limit reached, truncating output');
                    break;
                }

                fullContent += entry;
                estimatedTokens += entryTokens;
            }

            const result = {
                content: fullContent.trim(),
                chunks: finalChunks.length,
                files: fileNames,
                semanticHits,
                expandedChunks: finalChunks.length,
                reranked,
                rerankMethod,
                page: progressiveData?.page ?? 0,
                totalPages: progressiveData?.totalPages ?? 1,
                totalChunks: progressiveData?.totalChunks ?? finalChunks.length,
                usedProgressiveFallback,
            };

            logger.info(
                `📄 [HybridRAG] Result: semanticHits=${semanticHits}, finalChunks=${finalChunks.length}/${deduped.length} deduped, ` +
                `reranked=${reranked} (${rerankMethod}), ` +
                `files=${fileNames.length}, tokens≈${estimatedTokens}, strategy=${usedProgressiveFallback ? 'PROGRESSIVE_FALLBACK' : 'SEMANTIC+WINDOW+RERANK'}`
            );

            return result;
        } catch (error) {
            logger.error('[HybridRAG] getHybridRagContent error:', error);
            try {
                const fallback = await this.getProgressiveRagContent(filter, sessionIndex || 0);
                return { ...fallback, semanticHits: 0, expandedChunks: 0, usedProgressiveFallback: true };
            } catch (_) {
                return { content: '', chunks: 0, files: [], semanticHits: 0, expandedChunks: 0, usedProgressiveFallback: false };
            }
        }
    }

    /**
     * Parses progressive RAG content string back into chunk objects.
     * @private
     */
    _parseProgressiveContent(contentString) {
        if (!contentString) return [];

        const chunks = [];
        const sections = contentString.split(/--- DOCUMENTO: /);

        for (const section of sections) {
            if (!section.trim()) continue;
            const headerEnd = section.indexOf('---\n');
            const fileName = headerEnd > 0 ? section.substring(0, headerEnd).replace(/\s*\(.*\)\s*$/, '').trim() : 'unknown';
            const body = headerEnd > 0 ? section.substring(headerEnd + 4) : section;

            if (body.trim()) {
                chunks.push({
                    content: body.trim(),
                    fileName,
                    chunkIndex: chunks.length,
                });
            }
        }

        return chunks;
    }

    /**
     * Build smart context that analyzes the query to determine data needs
     */
    async buildSmartContext(query, options = {}) {
        const analysis = this.analyzeQuery(query);

        // If query is about schema, don't use RAG
        if (analysis.requiresSchema && !analysis.requiresRAG) {
            return this._buildSchemaContext();
        }

        // Build RAG context with analysis hints
        return this.buildContext(query, {
            ...options,
            topK: analysis.tables.length > 0 ? this.topK + 2 : this.topK
        });
    }

    /**
     * Analyze query to determine what kind of data is needed
     */
    analyzeQuery(query) {
        const lowerQuery = (query || '').toLowerCase();

        const analysis = {
            tables: [],
            intent: 'general',
            requiresRAG: true,
            requiresSchema: false,
            keywords: []
        };

        // Detect table references
        const tableKeywords = {
            'courses': ['curso', 'course', 'clase', 'materia'],
            'tasks': ['tarea', 'task', 'actividad', 'ejercicio', 'práctica'],
            'topics': ['tema', 'topic', 'módulo', 'unidad', 'capítulo'],
            'videos': ['video', 'clase grabada', 'multimedia'],
            'usuarios': ['usuario', 'estudiante', 'alumno', 'profesor']
        };

        for (const [table, keywords] of Object.entries(tableKeywords)) {
            for (const kw of keywords) {
                if (lowerQuery.includes(kw)) {
                    analysis.tables.push(table);
                    analysis.keywords.push(kw);
                    break;
                }
            }
        }

        // Detect intent
        if (/esquema|estructura|tablas|base de datos/i.test(lowerQuery)) {
            analysis.intent = 'schema';
            analysis.requiresSchema = true;
            analysis.requiresRAG = false;
        } else if (/cuántos|total|count|estadísticas/i.test(lowerQuery)) {
            analysis.intent = 'statistics';
        } else if (/busca|encuentra|search|similar/i.test(lowerQuery)) {
            analysis.intent = 'search';
        } else if (/genera|crea|preguntas|quiz|examen/i.test(lowerQuery)) {
            analysis.intent = 'generation';
        }

        return analysis;
    }

    /**
     * ═══════════════════════════════════════════════════════════════════
     * UTILITY METHODS
     * ═══════════════════════════════════════════════════════════════════
     */

    /**
     * Check if a document has already been ingested
     */
    async isDocumentIngested(metadata) {
        return this.vectorStore.exists({
            fileName: metadata.fileName,
            courseId: metadata.courseId,
            taskId: metadata.taskId
        });
    }

    /**
     * Get document stats
     */
    async getDocumentStats(filter = {}) {
        // This would query the vector store for stats
        // Implementation depends on your needs
        return {
            totalDocuments: 0,
            totalChunks: 0
        };
    }

    /**
     * Clear cache for specific context
     */
    _invalidateCache(metadata) {
        // Invalidate all related cache keys
        if (this.cache.flush) {
            this.cache.flush();
        }
    }

    /**
     * Detect file type from filename
     */
    _detectFileType(fileName) {
        if (!fileName) return 'txt';
        const parts = fileName.split('.');
        const ext = parts.pop();
        return ext ? ext.toLowerCase() : 'txt';
    }

    /**
     * Build schema context (for schema queries)
     */
    async _buildSchemaContext() {
        try {
            const schema = await this.supabase.getDatabaseSchema();
            let context = '# Database Schema\n\n';

            for (const [table, info] of Object.entries(schema)) {
                if (info.exists) {
                    context += `- **${table}**: ${info.count} records\n`;
                }
            }

            return context;
        } catch (error) {
            return '';
        }
    }

    /**
     * Legacy method for backwards compatibility
     */
    async addKnowledge(content, metadata = {}) {
        return this.ingestDocument(content, metadata);
    }

    /**
     * Legacy method for backwards compatibility  
     */
    async ingestFile(content, metadata = {}) {
        return this.ingestDocument(content, metadata);
    }

    /**
     * Get table context (legacy compatibility)
     */
    async getTableContext(tableName, filters = {}) {
        try {
            const cacheKey = `table:${tableName}:${JSON.stringify(filters)}`;

            const cached = this.cache.get(cacheKey);
            if (cached) return cached;

            const data = await this.supabase.getTableContext(tableName, filters, 50);

            this.cache.set(cacheKey, data, 600);
            return data;
        } catch (error) {
            logger.error(`Error getting context for ${tableName}:`, error);
            return [];
        }
    }
}

export default RAGService;

