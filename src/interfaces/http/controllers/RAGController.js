/**
 * RAGController — Controlador HTTP para Retrieval-Augmented Generation.
 */

import { createRequire } from 'module';
const require = createRequire(
    import.meta.url);
const pdf = require('pdf-parse');
import { ingestSchema, searchSchema, buildContextSchema } from '../../../domain/validators/RAGSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';
import { SupabaseService } from '../../../infrastructure/database/SupabaseService.js';
import { R2StorageAdapter } from '../../../infrastructure/storage/R2StorageAdapter.js';
import { RAGService } from '../../../domain/services/RAGService.js';
import { logger } from '../../../infrastructure/logging/Logger.js';

export class RAGController {
    constructor({ ragService }) {
        this.ragService = ragService;
    }

    getStatus = async(req, res, next) => {
        try {
            const result = await this.ragService.getStatus();
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    ingest = async(req, res, next) => {
        try {
            const { error, value } = ingestSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const result = await this.ragService.ingest(value);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    search = async(req, res, next) => {
        try {
            const { error, value } = searchSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const result = await this.ragService.search(value);
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    buildContext = async(req, res, next) => {
        try {
            const { error, value } = buildContextSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const result = await this.ragService.buildContext(value);
            if (result.isFail()) return next(result.getError());

            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    /**
     * POST /api/v1/rag/ingest-task-content
     * Fetches content_items for a task from DB, downloads files, and ingests into RAG.
     * Skips if rag_documents already exist for the task+topic pair.
     */
    ingestTaskContent = async(req, res, next) => {
        const parseId = (val) => {
            if (val === undefined || val === null || val === '') return null;
            const parsed = parseInt(val);
            return isNaN(parsed) ? null : parsed;
        };

        const taskId = parseId(req.body.taskId ?? req.body.task_id);
        const topicId = parseId(req.body.topicId ?? req.body.topic_id);
        const courseId = parseId(req.body.courseId ?? req.body.course_id);

        if (!taskId) {
            return res.status(400).json({ success: false, error: 'taskId is required' });
        }

        try {
            const ragService = new RAGService();
            const supabase = SupabaseService.getInstance();

            // Step 1: Check if rag_documents already exist
            const existsFilter = { taskId };
            if (topicId) existsFilter.topicId = topicId;
            if (courseId) existsFilter.courseId = courseId;

            const alreadyExists = await ragService.vectorStore.exists(existsFilter);
            if (alreadyExists) {
                logger.info(`ℹ️ RAG docs exist for task=${taskId}, topic=${topicId}. Skipping.`);
                return res.json({
                    success: true,
                    data: { skipped: true, reason: 'RAG documents already exist', taskId, topicId, courseId }
                });
            }

            // Step 2: Fetch content_items
            const { data: contentItems, error: ciError } = await supabase.client
                .from('content_items')
                .select('id, topic_id, title, body, content_type, task_id')
                .eq('task_id', taskId);

            if (ciError) {
                return res.status(500).json({ success: false, error: ciError.message });
            }
            if (!contentItems || contentItems.length === 0) {
                return res.json({
                    success: true,
                    data: { skipped: true, reason: 'No content_items found', taskId }
                });
            }

            // Step 3: Process each content_item
            const r2Service = new R2StorageAdapter();
            let totalChunksStored = 0;
            let filesProcessed = 0;
            const errors = [];

            for (const item of contentItems) {
                const body = (item.body || '').trim();
                const fileName = item.title || `content_item_${item.id}`;
                const isUrl = body.startsWith('http://') || body.startsWith('https://');

                if (!body || body.length < 10) continue;

                let extractedText = null;

                if (isUrl) {
                    try {
                        const fileData = await r2Service.getSubmissionFileContent(body, fileName);
                        if (!fileData || !fileData.content) {
                            errors.push({ file: fileName, error: 'No content from download' });
                            continue;
                        }

                        const nameLower = fileName.toLowerCase();
                        const isPdf = nameLower.endsWith('.pdf') || (fileData.contentType || '').includes('pdf');

                        if (isPdf) {
                            try {
                                const pdfBuffer = Buffer.from(fileData.content, fileData.isBase64 ? 'base64' : 'utf-8');
                                const pdfData = await pdf(pdfBuffer);
                                extractedText = pdfData.text;
                                if (!extractedText || extractedText.trim().length < 50) extractedText = null;
                            } catch (pdfErr) {
                                errors.push({ file: fileName, error: `PDF parse: ${pdfErr.message}` });
                            }
                        } else if (!fileData.isBase64) {
                            extractedText = fileData.content;
                        }
                    } catch (dlErr) {
                        errors.push({ file: fileName, error: `Download: ${dlErr.message}` });
                    }
                } else {
                    extractedText = body;
                }

                if (extractedText && extractedText.length >= 50) {
                    try {
                        const result = await ragService.ingestDocument(extractedText, {
                            courseId: courseId || null,
                            topicId: topicId || item.topic_id || null,
                            taskId,
                            contentItemId: item.id,
                            fileName,
                            fileType: 'txt'
                        });

                        if (result.success) {
                            totalChunksStored += result.chunksStored || 0;
                            filesProcessed++;
                        } else if (result.skipped) {
                            filesProcessed++;
                        } else {
                            errors.push({ file: fileName, error: result.error });
                        }
                    } catch (ingestErr) {
                        errors.push({ file: fileName, error: ingestErr.message });
                    }
                }
            }

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

        } catch (err) {
            logger.error(`❌ ingestTaskContent error: ${err.message}`, err);
            next(err);
        }
    };
}
export default RAGController;