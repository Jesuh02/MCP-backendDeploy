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
import axios from 'axios';
import { createRequire } from 'module';
const require = createRequire(
    import.meta.url);
const pdf = require('pdf-parse');
import { RAGService } from '../../domain/services/RAGService.js';
import { SupabaseService } from '../../infrastructure/database/SupabaseService.js';
import { R2StorageService } from '../../services/R2StorageService.js';
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
router.post('/ingest', async(req, res, next) => {
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
router.post('/search', async(req, res, next) => {
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
router.post('/context', async(req, res, next) => {
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
router.post('/smart-context', async(req, res, next) => {
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
router.get('/table/:tableName', async(req, res, next) => {
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
router.delete('/documents', async(req, res, next) => {
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

/**
 * POST /api/v1/rag/ingest-task-content
 * Ingest content_items for a specific task into RAG.
 * 
 * Flow:
 * 1. Check if rag_documents already exist for the task+topic combination → skip if yes
 * 2. Fetch content_items from DB by taskId
 * 3. For each content_item with a URL in body → download, parse (PDF/text), chunk, embed, store
 * 4. Return ingestion result
 * 
 * This endpoint MUST be called BEFORE question generation to ensure
 * RAG has the document content indexed for retrieval.
 */
router.post('/ingest-task-content', async(req, res) => {
    const parseId = (val) => {
        if (!val) return null;
        const parsed = parseInt(val);
        return isNaN(parsed) ? null : parsed;
    };

    const taskId = parseId(req.body.taskId);
    const topicId = parseId(req.body.topicId);
    const courseId = parseId(req.body.courseId);

    if (!taskId) {
        return res.status(400).json({
            success: false,
            error: 'taskId is required'
        });
    }

    try {
        const ragService = getRagService();
        const supabase = SupabaseService.getInstance();

        // ═══════════════════════════════════════════════════════════
        // Step 1: Check if rag_documents already exist for this task+topic
        // ═══════════════════════════════════════════════════════════
        const existsFilter = { taskId };
        if (topicId) existsFilter.topicId = topicId;
        if (courseId) existsFilter.courseId = courseId;

        const alreadyExists = await ragService.vectorStore.exists(existsFilter);

        if (alreadyExists) {
            logger.info(`ℹ️ RAG documents already exist for task=${taskId}, topic=${topicId}. Skipping ingestion.`);
            return res.json({
                success: true,
                data: {
                    skipped: true,
                    reason: 'RAG documents already exist for this task/topic combination',
                    taskId,
                    topicId,
                    courseId,
                    timestamp: new Date().toISOString()
                }
            });
        }

        // ═══════════════════════════════════════════════════════════
        // Step 2: Fetch content_items from DB for this taskId
        // ═══════════════════════════════════════════════════════════
        logger.info(`📥 Fetching content_items for task=${taskId}...`);

        const { data: contentItems, error: ciError } = await supabase.client
            .from('content_items')
            .select('id, topic_id, title, body, content_type, task_id')
            .eq('task_id', taskId);

        if (ciError) {
            logger.error(`❌ Error fetching content_items: ${ciError.message}`);
            return res.status(500).json({
                success: false,
                error: `Failed to fetch content_items: ${ciError.message}`
            });
        }

        if (!contentItems || contentItems.length === 0) {
            logger.info(`ℹ️ No content_items found for task=${taskId}`);
            return res.json({
                success: true,
                data: {
                    skipped: true,
                    reason: 'No content_items found for this task',
                    taskId,
                    timestamp: new Date().toISOString()
                }
            });
        }

        logger.info(`📄 Found ${contentItems.length} content_items for task=${taskId}`);

        // ═══════════════════════════════════════════════════════════
        // Step 3: Process each content_item
        // ═══════════════════════════════════════════════════════════
        const r2Service = R2StorageService.getInstance();
        let totalChunksStored = 0;
        let filesProcessed = 0;
        const errors = [];

        for (const item of contentItems) {
            const body = (item.body || '').trim();
            const fileName = item.title || `content_item_${item.id}`;
            const isUrl = body.startsWith('http://') || body.startsWith('https://');

            if (!body || body.length < 10) {
                logger.info(`ℹ️ Skipping content_item ${item.id}: body is empty or too short`);
                continue;
            }

            let extractedText = null;

            if (isUrl) {
                // ── Download and extract text from file URL ──
                logger.info(`📥 Downloading content from URL: ${body.substring(0, 80)}...`);
                try {
                    const fileData = await r2Service.getSubmissionFileContent(body, fileName);

                    if (!fileData || !fileData.content) {
                        logger.warn(`⚠️ No content returned for ${fileName}`);
                        errors.push({ file: fileName, error: 'No content returned from download' });
                        continue;
                    }

                    // Detect file type and parse accordingly
                    const nameLower = fileName.toLowerCase();
                    const isPdf = nameLower.endsWith('.pdf') ||
                        (fileData.contentType || '').toLowerCase().includes('pdf');

                    if (isPdf) {
                        try {
                            logger.info(`📄 Parsing PDF: ${fileName} (${fileData.size} bytes)`);
                            const pdfBuffer = Buffer.from(fileData.content, fileData.isBase64 ? 'base64' : 'utf-8');
                            const pdfData = await pdf(pdfBuffer);
                            extractedText = pdfData.text;

                            if (!extractedText || extractedText.trim().length < 50) {
                                logger.warn(`⚠️ PDF parsed but text is empty/too short: ${fileName}`);
                                extractedText = null;
                            } else {
                                logger.info(`✅ PDF extracted: ${extractedText.length} chars from ${fileName}`);
                            }
                        } catch (pdfErr) {
                            logger.error(`❌ PDF parsing failed for ${fileName}: ${pdfErr.message}`);
                            errors.push({ file: fileName, error: `PDF parse error: ${pdfErr.message}` });
                        }
                    } else if (!fileData.isBase64) {
                        // Plain text content
                        extractedText = fileData.content;
                        logger.info(`📝 Text content: ${extractedText.length} chars from ${fileName}`);
                    } else {
                        logger.warn(`⚠️ Binary content not supported for direct ingestion: ${fileName}`);
                        errors.push({ file: fileName, error: 'Binary content type not supported' });
                    }
                } catch (downloadErr) {
                    logger.error(`❌ Download failed for ${fileName}: ${downloadErr.message}`);
                    errors.push({ file: fileName, error: `Download error: ${downloadErr.message}` });
                }
            } else {
                // ── Inline text content (body is the text itself) ──
                extractedText = body;
                logger.info(`📝 Inline text content: ${extractedText.length} chars from ${fileName}`);
            }

            // ── Ingest extracted text into RAG ──
            if (extractedText && extractedText.length >= 50) {
                try {
                    const result = await ragService.ingestDocument(extractedText, {
                        courseId: courseId || null,
                        topicId: topicId || item.topic_id || null,
                        taskId: taskId,
                        contentItemId: item.id,
                        fileName: fileName,
                        fileType: 'txt'
                    });

                    if (result.success) {
                        totalChunksStored += result.chunksStored || 0;
                        filesProcessed++;
                        logger.info(`✅ RAG ingestion complete for ${fileName}: ${result.chunksStored} chunks stored`);
                    } else if (result.skipped) {
                        logger.info(`ℹ️ RAG ingestion skipped for ${fileName}: ${result.message}`);
                        filesProcessed++;
                    } else {
                        logger.warn(`⚠️ RAG ingestion failed for ${fileName}: ${result.error}`);
                        errors.push({ file: fileName, error: result.error });
                    }
                } catch (ingestErr) {
                    logger.error(`❌ RAG ingestion error for ${fileName}: ${ingestErr.message}`);
                    errors.push({ file: fileName, error: `Ingestion error: ${ingestErr.message}` });
                }
            } else {
                logger.info(`ℹ️ Skipping ${fileName}: extracted text too short or null`);
            }
        }

        // ═══════════════════════════════════════════════════════════
        // Step 4: Return result
        // ═══════════════════════════════════════════════════════════
        logger.info(`✅ Task content ingestion complete: ${filesProcessed} files, ${totalChunksStored} chunks`);

        return res.json({
            success: true,
            data: {
                skipped: false,
                ingested: true,
                filesProcessed,
                totalChunksStored,
                contentItemsFound: contentItems.length,
                errors: errors.length > 0 ? errors : undefined,
                taskId,
                topicId,
                courseId,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        logger.error(`❌ ingest-task-content error: ${error.message}`, error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

export default router;