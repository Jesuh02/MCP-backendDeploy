import { Router } from 'express';
import axios from 'axios';
import { R2StorageService } from '../../services/R2StorageService.js';
import { SupabaseService } from '../../infrastructure/database/SupabaseService.js';
import { MCPService } from '../../domain/services/MCPService.js';
import { RAGService } from '../../domain/services/RAGService.js';
import { EmbeddingService } from '../../infrastructure/ai/EmbeddingService.js';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(
    import.meta.url);
const pdf = require('pdf-parse');
const xlsx = require('xlsx');

// Note: In Node 18+, fetch is global. If older, might need node-fetch. Assuming environment supports it.

const router = Router();

router.post('/procesar-prompt', async(req, res) => {
            try {
                let { prompt, ollamaUrl, model, jsonContent, taskDescription, fileContent } = req.body;
                const fileUri = req.body.fileUri || req.body.file_uri || null; // 🔥 Extract fileUri from client
                const studentId = req.body.studentId || req.body.student_id || null; // 🔥 Extract studentId from client

                // 🛑 CHECK: Determine if we should process this as a Chat/Generation request or purely Ingestion
                // If prompt contains keywords like "pregunta", "quiz", "examen", we assume generation intent
                // regardless of the model name provided (often clients default to embedding model by mistake)
                const promptLower = (prompt || '').toLowerCase();
                const intentIsGeneration = promptLower.length > 5; // Assumed generation if there is any prompt text basically

                // 🛑 CRITICAL: If model is an embedding model, it MUST NOT go to chat... unless we fix it.
                // The prompt will be processed for Ingestion (embeddings), then we return early ONLY if intent is NOT generation.
                let isEmbeddingModel = model && (
                    model.toLowerCase().includes('embedding') ||
                    model.toLowerCase().includes('text-embed') ||
                    model === "Qwen3-VL-Embedding-8B"
                );

                if (isEmbeddingModel) {
                    // FORCE override for this endpoint which is specifically for processing prompts/generation
                    // There is rarely a reason to hit /procesar-prompt JUST for embedding without generation.
                    console.warn(`⚠️ Model '${model}' is an embedding model but hit /procesar-prompt. Forcing Generation Mode with DeepSeek.`);
                    isEmbeddingModel = false;
                    // We intentionally set this to false to proceed to LLM generation logic below.
                }

                // Extract Context IDs (ensure they are parsed as integers/bigints if present)
                const parseId = (val) => {
                    if (!val) return null;
                    const parsed = parseInt(val);
                    return isNaN(parsed) ? null : parsed;
                };

                const taskId = parseId(req.body.taskId || req.body.task_id);
                const topicId = parseId(req.body.topicId || req.body.topic_id);
                const courseId = parseId(req.body.courseId || req.body.course_id || req.body.idCurso);
                const contentItemId = parseId(req.body.contentItemId || req.body.content_item_id);
                const userId = parseId(req.body.userId || req.body.user_id || req.body.usuarioId); // 🔥 Parse as integer for Supabase FK
                const submissionId = parseId(req.body.submissionId || req.body.submission_id); // 🔥 Extract submissionId

                // 🔥 LOGIC: Determine if fileContent needs to be fetched from the database or URL
                const seemsLikeUrl = fileContent && fileContent.trim().startsWith('http') && fileContent.length < 500;
                const hasMetadataHeader = fileContent && fileContent.includes('=== INFORMACIÓN DEL ARCHIVO ENVIADO ===');
                const seemsEmpty = !fileContent || fileContent.length < 50 || (hasMetadataHeader && fileContent.length < 400);

                console.log(`🔍 Submission Check: ID=${submissionId}, fileUri=${fileUri ? fileUri.substring(0, 60) + '...' : 'null'}, SeemsURL=${seemsLikeUrl}, IsEmpty=${seemsEmpty}, Len=${(fileContent || '').length}, studentId=${studentId}`);

                // 🔥 STRATEGY 1: Use submissionId to look up and download from DB
                if (submissionId && (seemsEmpty || seemsLikeUrl)) {
                    try {
                        console.log(`🔍 Buscando entrega en DB para SubmissionId: ${submissionId}...`);
                        const { data: submission } = await SupabaseService.getInstance().client
                            .from('task_submissions')
                            .select('file_uri, file_name, feedback, grade')
                            .eq('id', submissionId)
                            .maybeSingle();

                        if (submission && submission.file_uri) {
                            console.log(`✅ Entrega encontrada en DB: ${submission.file_name} (${submission.file_uri})`);

                            // Attempt to download file content
                            const r2Service = R2StorageService.getInstance();
                            let fetchedContent = "";
                            // Default to .txt if name is missing to force text processing
                            const rawName = submission.file_name || "archivo_recuperado.txt";

                            try {
                                // Try R2/DB Service first
                                const fileData = await r2Service.getSubmissionFileContent(submission.file_uri, rawName, submissionId);

                                if (fileData && fileData.content) {
                                    const nameLower = rawName.toLowerCase();
                                    const isPdf = nameLower.endsWith('.pdf') || (fileData.contentType || '').includes('pdf');

                                    if (isPdf) {
                                        try {
                                            const pdfBuffer = Buffer.from(fileData.content, fileData.isBase64 ? 'base64' : 'utf-8');
                                            const pdfData = await pdf(pdfBuffer);
                                            if (pdfData.text) fetchedContent = pdfData.text;
                                        } catch (pdfErr) { console.warn(`Error parsing PDF from DB: ${pdfErr.message}`); }
                                    } else if (nameLower.match(/\.xlsx?$/)) {
                                        try {
                                            const workbook = xlsx.read(fileData.content, { type: fileData.isBase64 ? 'base64' : 'string' });
                                            for (const sheetName of workbook.SheetNames) {
                                                fetchedContent += `\n[Sheet: ${sheetName}]\n${xlsx.utils.sheet_to_csv(workbook.Sheets[sheetName])}\n`;
                                            }
                                        } catch (xlsErr) { console.warn(`Error parsing Excel from DB: ${xlsErr.message}`); }
                                    } else {
                                        // Text / Code files
                                        if (fileData.isBase64) {
                                            // Always try decoding base64 to utf-8 for code files if r2 returned base64
                                            fetchedContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
                                        } else {
                                            fetchedContent = fileData.content;
                                        }
                                    }
                                }
                            } catch (r2Err) {
                                console.warn(`⚠️ Error en R2Service durante recuperación primaria: ${r2Err.message}`);
                            }

                            // AGGRESSIVE FALLBACK: If R2 failed OR returned empty, and we have a URL, try direct download
                            if ((!fetchedContent || fetchedContent.length < 20) && submission.file_uri && submission.file_uri.startsWith('http')) {
                                console.log(`🌐 Intentando descarga directa (AXIOS Fallback) para: ${submission.file_uri}`);
                                try {
                                    const resp = await axios.get(submission.file_uri, { responseType: 'text', timeout: 15000 });
                                    if (resp.data) {
                                        const rawData = typeof resp.data === 'object' ? JSON.stringify(resp.data) : resp.data;
                                        if (rawData && rawData.length > 5) {
                                            fetchedContent = rawData;
                                            console.log(`✅ Contenido recuperado vía Axios fallback (${fetchedContent.length} chars)`);
                                        }
                                    }
                                } catch (axiosErr) {
                                    console.error(`❌ Fallback Axios failed: ${axiosErr.message}`);
                                }
                            }

                            if (fetchedContent && fetchedContent.length > 5) { // Reduced threshold to 5 chars
                                // IMPORTANT: Validar que no estemos concatenando lo mismo
                                if (!fileContent || fileContent.includes(submission.file_uri)) {
                                    // If fileContent was just the URL or empty, replace it or init it
                                    fileContent = `[CONTENIDO RECUPERADO DE BASE DE DATOS (${rawName})]:\n${fetchedContent.substring(0, 50000)}`;
                                } else {
                                    // Append if there was something else meaningful
                                    fileContent += `\n\n[CONTENIDO RECUPERADO DE BASE DE DATOS (${rawName})]:\n${fetchedContent.substring(0, 50000)}`;
                                }
                                console.log(`📄 Contenido inyectado desde DB (${fetchedContent.length} chars).`);
                            }
                        }
                    } catch (dbErr) {
                        console.warn('⚠️ Error buscando entrega en DB por submissionId:', dbErr.message);
                    }
                }
                // 🔥 STRATEGY 2 (WATERFALL): Recalcular seemsEmpty y buscar por taskId + studentId si aún falta contenido
                const seemsEmpty2 = !fileContent || fileContent.length < 50;
                if (taskId && (userId || studentId) && seemsEmpty2) {
                    const lookupStudentId = studentId || userId;
                    try {
                        console.log(`🔍 Buscando entrega en DB por TaskId: ${taskId} + StudentId: ${lookupStudentId}...`);
                        const { data: submission } = await SupabaseService.getInstance().client
                            .from('task_submissions')
                            .select('id, file_uri, file_name')
                            .eq('task_id', taskId)
                            .eq('student_id', lookupStudentId)
                            .order('created_at', { ascending: false })
                            .limit(1)
                            .maybeSingle();

                        if (submission && submission.file_uri) {
                            console.log(`✅ Entrega encontrada (Task+User): ${submission.file_name} -> ${submission.file_uri}`);
                            let fetchedContent = "";
                            const rawName = submission.file_name || "archivo_recuperado.txt";

                            // Try R2 first
                            try {
                                const r2Service = R2StorageService.getInstance();
                                const fileData = await r2Service.getSubmissionFileContent(submission.file_uri, rawName, submission.id);
                                if (fileData && fileData.content) {
                                    fetchedContent = fileData.isBase64 ? Buffer.from(fileData.content, 'base64').toString('utf-8') : fileData.content;
                                }
                            } catch (r2Err) {
                                console.warn(`⚠️ R2 failed for Task+User lookup: ${r2Err.message}`);
                            }

                            // Axios fallback
                            if ((!fetchedContent || fetchedContent.length < 20) && submission.file_uri.startsWith('http')) {
                                try {
                                    const resp = await axios.get(submission.file_uri, { responseType: 'text', timeout: 15000 });
                                    if (resp.data) {
                                        fetchedContent = typeof resp.data === 'object' ? JSON.stringify(resp.data) : resp.data;
                                    }
                                } catch (axErr) { console.error(`❌ Axios fallback (Task+User) failed: ${axErr.message}`); }
                            }

                            if (fetchedContent && fetchedContent.length > 5) {
                                if (!fileContent) fileContent = "";
                                fileContent += `\n\n[CONTENIDO RECUPERADO DB (${rawName})]:\n${fetchedContent.substring(0, 50000)}`;
                                console.log(`📄 Contenido inyectado vía Task+User lookup (${fetchedContent.length} chars).`);
                            }
                        }
                    } catch (e) { console.warn('Fallback DB search (Task+User) failed:', e.message); }
                }
                // 🔥 STRATEGY 3 (WATERFALL): Recalcular seemsEmpty y descargar vía fileUri directa si aún falta contenido
                const seemsEmpty3 = !fileContent || fileContent.length < 50;
                if (fileUri && fileUri.startsWith('http') && seemsEmpty3) {
                    console.log(`🌐 fileUri proporcionada por cliente, descargando directamente: ${fileUri.substring(0, 80)}...`);
                    try {
                        const resp = await axios.get(fileUri, { responseType: 'text', timeout: 15000 });
                        if (resp.data) {
                            const rawData = typeof resp.data === 'object' ? JSON.stringify(resp.data) : resp.data;
                            if (rawData && rawData.length > 5) {
                                if (!fileContent) fileContent = "";
                                fileContent += `\n\n[CONTENIDO DESCARGADO DESDE URL]:\n${rawData.substring(0, 50000)}`;
                                console.log(`✅ Contenido descargado vía fileUri directa (${rawData.length} chars).`);
                            }
                        }
                    } catch (urlErr) {
                        console.error(`❌ Descarga directa de fileUri fallida: ${urlErr.message}`);
                    }
                }

                // Check if RAG documents already exist for this context to avoid duplicate ingestion
                // We check rag_documents directly instead of question_sessions because
                // sessions can exist without any RAG content being stored
                let skipIngestion = false;
                if (taskId && topicId) {
                    try {
                        const ragService = new RAGService();
                        const ragExists = await ragService.vectorStore.exists({
                            taskId: taskId,
                            topicId: topicId,
                            ...(courseId ? { courseId } : {})
                        });
                        if (ragExists) {
                            skipIngestion = true;
                            console.log(`ℹ️ RAG documents already exist for task=${taskId}, topic=${topicId}. Skipping ingestion.`);
                        } else {
                            console.log(`📝 No RAG documents found for task=${taskId}, topic=${topicId}. Will ingest content.`);
                        }
                    } catch (e) {
                        console.warn('⚠️ Failed to check rag_documents existence:', e.message);
                    }
                }

                console.log(`🤖 Processing prompt with model ${model || 'default'} at ${ollamaUrl} (Task: ${taskId}, Topic: ${topicId}, ContentItem: ${contentItemId})`);

                let augmentedPrompt = prompt;

                // 📝 APPEND TASK CONTEXT IF PROVIDED (Critical for Grading)
                // If the app sent taskDescription and fileContent (e.g. from ChatBotFragment for grading), we must include it in the prompt.
                if (taskDescription || fileContent) {
                    console.log('📄 Appending task context & file content to prompt for analysis/grading...');
                    augmentedPrompt += "\n\n--- CONTEXTO DE LA TAREA ---\n";
                    if (taskDescription) augmentedPrompt += `DESCRIPCIÓN DE LA TAREA:\n${taskDescription}\n\n`;
                    if (fileContent) augmentedPrompt += `CONTENIDO DEL ARCHIVO DEL ESTUDIANTE:\n${fileContent}\n\n`;
                    augmentedPrompt += "--- FIN DEL CONTEXTO ---\n";
                }

                // 💾 RAG INGESTION: Ingest fileContent from strategies 1/2/3 into rag_documents
                // This is critical - content fetched from submissions was only added to the prompt
                // but never saved to rag_documents for future retrieval
                if (fileContent && fileContent.length > 100 && !skipIngestion && (taskId || topicId)) {
                    try {
                        const ragServiceForFile = new RAGService();
                        console.log(`💾 Ingesting fileContent (${fileContent.length} chars) into RAG for task=${taskId}, topic=${topicId}...`);
                        await ragServiceForFile.ingestDocument(fileContent, {
                            courseId: courseId,
                            taskId: taskId,
                            topicId: topicId,
                            contentItemId: contentItemId,
                            fileName: 'student_submission_content',
                            fileType: 'txt'
                        });
                        console.log('✅ fileContent RAG ingestion complete.');
                    } catch (ragFileErr) {
                        console.warn('⚠️ fileContent RAG ingestion failed (non-blocking):', ragFileErr.message);
                    }
                }

                let contextFromRAG = false;

                // RAG & FILE PROCESSING LOGIC
                // 1. Check if we already have this context processed in RAG
                // We assume if contentItemId is present, we check specifically for that. Otherwise fall back to task/topic.
                const ragFilter = {};
                if (contentItemId) ragFilter.contentItemId = contentItemId;
                if (taskId) ragFilter.taskId = taskId;
                if (topicId) ragFilter.topicId = topicId;
                if (courseId) ragFilter.courseId = courseId;

                const hasContextIds = Object.keys(ragFilter).length > 0;

                if (hasContextIds && process.env.RAG_ENABLED !== 'false') {
                    try {
                        const ragService = new RAGService();
                        const exists = await ragService.vectorStore.exists(ragFilter);

                        if (exists) {
                            console.log(`📚 Context found in RAG (Filter: ${JSON.stringify(ragFilter)}). Retrieving...`);
                            // Retrieve context chunks (Top 20 chunks to cover enough ground)
                            const searchResults = await ragService.vectorStore.search(
                                await ragService.embeddingService.embedQuery(prompt.substring(0, 1000) || "resumen contenido"),
                                15, // Get top 15 chunks
                                0.6, // Loose threshold
                                ragFilter
                            );

                            if (searchResults && searchResults.length > 0) {
                                let ragContext = "";
                                searchResults.forEach(chunk => {
                                    ragContext += `\n--- Contexto Recuperado (${chunk.metadata?.fileName || 'chunk'}) ---\n${chunk.content}\n`;
                                });
                                augmentedPrompt += `\n\nCONTEXTO PREVIO PROCESADO (RAG):\n${ragContext}`;
                                contextFromRAG = true;
                                console.log(`✅ Retrieved ${searchResults.length} chunks from RAG.`);
                            }
                        }
                    } catch (e) {
                        console.warn('⚠️ RAG Retrieval failed:', e.message);
                    }
                }

                // Process jsonContent to fetch files from R2
                // Always process files to ensure they are ingested into RAG even if RAG had some prior context
                // The RAGService.ingestDocument() handles deduplication internally

                if (jsonContent) {
                    try {
                        const files = JSON.parse(jsonContent);
                        if (Array.isArray(files) && files.length > 0) {
                            console.log(`📂 Procesando ${files.length} archivos adjuntos...`);
                            const r2Service = R2StorageService.getInstance();
                            const ragService = new RAGService(); // Warning: Multiple instances lightweight

                            for (const file of files) {
                                const isUrl = file.uri && (r2Service.isR2Url(file.uri) || file.uri.startsWith('http'));
                                // 🔥 FIX: Detect inline text content from content_items.body
                                // Android sends content_items.body as file.uri — when it's NOT a URL,
                                // it contains the actual document text that must be ingested into rag_documents.
                                const isInlineText = file.uri && !isUrl && file.uri.length > 50;

                                if (isUrl) {
                                    console.log(`📥 Descargando contenido de ${file.name}...`);
                                    try {
                                        // Use getSubmissionFileContent which handles various sources (R2, HTTP)
                                        const fileData = await r2Service.getSubmissionFileContent(file.uri, file.name);

                                        if (fileData && fileData.content) {
                                            let extractedText = null;
                                            let processMsg = "";

                                            // DEBUG LOGS FOR PDF DETECTION
                                            const rawName = file.name || "";
                                            const nameLower = rawName.trim().toLowerCase();
                                            const isPdfName = nameLower.endsWith('.pdf');
                                            const isPdfMime = (fileData.contentType || '').toLowerCase().includes('pdf');
                                            console.log(`🔍 DEBUG: Processing file '${rawName}' (Mime: ${fileData.contentType}) -> isPdfName=${isPdfName}, isPdfMime=${isPdfMime}`);

                                            // Handle PDF
                                            if (isPdfMime || isPdfName) {
                                                try {
                                                    console.log(`📄 Analizando PDF: ${rawName} (Size: ${fileData.size} bytes)`);
                                                    // content is likely base64 for PDFs from R2StorageService
                                                    const pdfBuffer = Buffer.from(fileData.content, fileData.isBase64 ? 'base64' : 'utf-8');

                                                    // Validate buffer
                                                    if (pdfBuffer.length === 0) {
                                                        console.warn('⚠️ PDF Buffer is empty!');
                                                    } else {
                                                        // Ensure pdf-parse is working
                                                        const pdfData = await pdf(pdfBuffer);
                                                        const rawText = pdfData.text;

                                                        if (rawText && rawText.trim().length > 0) {
                                                            extractedText = rawText;
                                                            processMsg = `PDF analizado (${extractedText.length} chars)`;
                                                            console.log(`✅ ${processMsg}`);
                                                            // USER REQUESTED CONTENT LOGGING
                                                            console.log(`📝 CONTENIDO PDF (${rawName} - primeros 2000 chars):\n${extractedText.substring(0, 2000)}...`);
                                                        } else {
                                                            console.warn(`⚠️ PDF parsed but returned empty text (scanned PDF?): ${rawName}`);
                                                            // Try to see if there is any info
                                                            console.log('PDF Info:', pdfData.info);
                                                        }
                                                    }
                                                } catch (e) {
                                                    console.warn(`⚠️ Error al analizar PDF ${rawName}: ${e.message}`);
                                                    console.error(e); // Full stack trace
                                                }
                                            }
                                            // Handle Excel
                                            else if ((fileData.contentType || '').includes('spreadsheet') || (fileData.contentType || '').includes('excel') || nameLower.match(/\.xlsx?$/)) {
                                                try {
                                                    console.log(`📊 Analizando Excel: ${rawName}`);
                                                    const workbook = xlsx.read(fileData.content, { type: fileData.isBase64 ? 'base64' : 'string' });
                                                    let excelText = "";
                                                    for (const sheetName of workbook.SheetNames) {
                                                        const sheet = workbook.Sheets[sheetName];
                                                        // Convert to CSV for better token efficiency than JSON or TXT
                                                        const text = xlsx.utils.sheet_to_csv(sheet);
                                                        if (text.trim()) {
                                                            excelText += `\n[Sheet: ${sheetName}]\n${text}\n`;
                                                        }
                                                    }
                                                    extractedText = excelText;
                                                    processMsg = `Excel analizado (${extractedText.length} chars)`;
                                                    console.log(`✅ ${processMsg}`);
                                                    console.log(`📝 CONTENIDO EXCEL (${rawName} - primeros 1000 chars):\n${extractedText.substring(0, 1000)}...`);
                                                } catch (e) {
                                                    console.warn(`⚠️ Error al analizar Excel ${rawName}: ${e.message}`);
                                                }
                                            }
                                            // Handle Text (already handled, but let's consolidate) & Prevent Binary Dump (PPTX/ZIP/Images)
                                            else if (!fileData.isBase64) {
                                                const isBinaryLike = nameLower.endsWith('.pptx') || nameLower.endsWith('.docx') || nameLower.endsWith('.zip') || nameLower.endsWith('.png') || nameLower.endsWith('.jpg');
                                                if (isBinaryLike) {
                                                    console.warn(`⚠️ Skipping binary-like file content dump: ${rawName}`);
                                                    augmentedPrompt += `\n\n--- Archivo binario omitido: ${rawName} (Contenido no textual soportado: PPTX/DOCX/IMG) ---`;
                                                } else {
                                                    extractedText = fileData.content;
                                                    processMsg = "Contenido de texto plano";
                                                    console.log(`📝 CONTENIDO TEXTO (${rawName} - primeros 1000 chars):\n${extractedText.substring(0, 1000)}...`);
                                                }
                                            }

                                            if (extractedText) {
                                                // SAFETY LIMIT: DeepSeek has 128k context, OpenRouter 160k.
                                                // We cap total prompt size to ~40k tokens (approx 160k chars) to leave room for history and reasoning.
                                                const MAX_TOTAL_CONTEXT_CHARS = 160000;
                                                const currentLength = augmentedPrompt.length;
                                                const remainingChars = MAX_TOTAL_CONTEXT_CHARS - currentLength;

                                                if (remainingChars <= 200) {
                                                    console.warn(`⚠️ Max context length reached. Skipping content of ${rawName}`);
                                                    augmentedPrompt += `\n\n--- Archivo omitido: ${rawName} (Límite de contexto alcanzado) ---`;
                                                } else {
                                                    let contentSnippet = extractedText;
                                                    if (contentSnippet.length > remainingChars) {
                                                        console.warn(`⚠️ Truncating ${rawName} to fit context limit (${remainingChars} chars left).`);
                                                        contentSnippet = contentSnippet.substring(0, remainingChars) + "\n\n[...Contenido truncado por límite de longitud...]";
                                                    }
                                                    augmentedPrompt += `\n\n--- Contenido del archivo: ${rawName} (${fileData.contentType}) ---\n${contentSnippet}`;
                                                }

                                                // Extract file-specific ID if available in JSON content
                                                const fileSpecificId = parseId(file.id);
                                                const activeContentItemId = fileSpecificId || contentItemId;

                                                // INGEST INTO RAG (If task/topic/contentItem present)
                                                if (((taskId && topicId) || activeContentItemId) && !skipIngestion) {
                                                    try {
                                                        console.log(`💾 Ingesting ${rawName} into RAG for future use (ContentItemID: ${activeContentItemId})...`);
                                                        await ragService.ingestDocument(extractedText, {
                                                            courseId: courseId,
                                                            taskId: taskId,
                                                            topicId: topicId,
                                                            contentItemId: activeContentItemId,
                                                            fileName: rawName,
                                                            fileType: 'txt', // Force text processing since we already extracted it
                                                            originalFileType: fileData.contentType // Keep original type in metadata
                                                        });
                                                        console.log('✅ RAG Ingestion Phase Complete. (Fase de Ingestión RAG Completada)');
                                                        console.log('⏳ Iniciando Fase de Generación de Preguntas...');
                                                    } catch (err) {
                                                        console.warn('⚠️ RAG Ingestion failed:', err.message);
                                                    }
                                                }
                                            } else {
                                                console.log(`ℹ️ Archivo ${rawName} es binario o no textual, solo referencia añadida. (isPdf=${isPdfName}, isExcel=${nameLower.match(/\.xlsx?$/)})`);
                                                augmentedPrompt += `\n\n--- Archivo adjunto: ${rawName} (${fileData.contentType}) [Contenido binario no incluido] ---`;
                                            }
                                        }
                                    } catch (e) {
                                        console.warn(`⚠️ Fallo al descargar archivo ${file.name}: ${e.message}`);
                                    }
                                }
                                // 🔥 NEW: Handle inline text content from content_items.body
                                // Android maps content_items.body → uriString → file.uri in jsonContent.
                                // When body contains actual document text (not a URL), process it directly.
                                else if (isInlineText) {
                                    const rawName = file.name || `content_item_${file.id || 'unknown'}`;
                                    const extractedText = file.uri; // file.uri IS the body text
                                    const fileSpecificId = parseId(file.id);
                                    const activeContentItemId = fileSpecificId || contentItemId;

                                    console.log(`📄 Contenido inline detectado para '${rawName}' (${extractedText.length} chars) desde content_items.body`);
                                    console.log(`📝 CONTENIDO INLINE (${rawName} - primeros 1000 chars):\n${extractedText.substring(0, 1000)}...`);

                                    // Add to prompt context
                                    const MAX_TOTAL_CONTEXT_CHARS = 160000;
                                    const currentLength = augmentedPrompt.length;
                                    const remainingChars = MAX_TOTAL_CONTEXT_CHARS - currentLength;

                                    if (remainingChars <= 200) {
                                        console.warn(`⚠️ Max context length reached. Skipping inline content of ${rawName}`);
                                    } else {
                                        let contentSnippet = extractedText;
                                        if (contentSnippet.length > remainingChars) {
                                            contentSnippet = contentSnippet.substring(0, remainingChars) + "\n\n[...Contenido truncado por límite de longitud...]";
                                        }
                                        augmentedPrompt += `\n\n--- Contenido del documento: ${rawName} (content_items.body) ---\n${contentSnippet}`;
                                    }

                                    // INGEST INTO RAG
                                    if (((taskId && topicId) || activeContentItemId) && !skipIngestion) {
                                        try {
                                            console.log(`💾 Ingesting inline content '${rawName}' into RAG (ContentItemID: ${activeContentItemId})...`);
                                            await ragService.ingestDocument(extractedText, {
                                                courseId: courseId,
                                                taskId: taskId,
                                                topicId: topicId,
                                                contentItemId: activeContentItemId,
                                                fileName: rawName,
                                                fileType: 'txt'
                                            });
                                            console.log('✅ RAG Ingestion (inline content) complete.');
                                        } catch (err) {
                                            console.warn('⚠️ RAG Ingestion (inline) failed:', err.message);
                                        }
                                    }
                                }
                                // 🔥 FALLBACK: No URL and no inline text — fetch body from content_items table by ID
                                else if (file.id) {
                                    const rawName = file.name || `content_item_${file.id}`;
                                    const fileSpecificId = parseId(file.id);
                                    const activeContentItemId = fileSpecificId || contentItemId;

                                    console.log(`🔍 No URL/inline content for '${rawName}'. Fetching from content_items table (ID: ${file.id})...`);
                                    try {
                                        const { data: contentItem } = await SupabaseService.getInstance().client
                                            .from('content_items')
                                            .select('body, title, content_type')
                                            .eq('id', file.id)
                                            .maybeSingle();

                                        if (contentItem && contentItem.body && contentItem.body.length > 20) {
                                            const bodyText = contentItem.body;
                                            const bodyIsUrl = bodyText.trim().startsWith('http');

                                            if (bodyIsUrl) {
                                                // Body is a URL — download it
                                                console.log(`🌐 content_items.body is a URL, downloading: ${bodyText.substring(0, 80)}...`);
                                                try {
                                                    const resp = await axios.get(bodyText.trim(), { responseType: 'text', timeout: 15000 });
                                                    if (resp.data && String(resp.data).length > 20) {
                                                        const downloaded = typeof resp.data === 'object' ? JSON.stringify(resp.data) : String(resp.data);
                                                        augmentedPrompt += `\n\n--- Contenido del documento: ${rawName} ---\n${downloaded.substring(0, 50000)}`;

                                                        if (((taskId && topicId) || activeContentItemId) && !skipIngestion) {
                                                            await ragService.ingestDocument(downloaded, {
                                                                courseId,
                                                                taskId,
                                                                topicId,
                                                                contentItemId: activeContentItemId,
                                                                fileName: rawName,
                                                                fileType: 'txt'
                                                            });
                                                            console.log('✅ RAG Ingestion (content_items URL download) complete.');
                                                        }
                                                    }
                                                } catch (dlErr) {
                                                    console.warn(`⚠️ Download from content_items.body URL failed: ${dlErr.message}`);
                                                }
                                            } else {
                                                // Body is inline text content
                                                console.log(`📄 content_items.body contains inline text (${bodyText.length} chars)`);
                                                augmentedPrompt += `\n\n--- Contenido del documento: ${rawName} ---\n${bodyText.substring(0, 50000)}`;

                                                if (((taskId && topicId) || activeContentItemId) && !skipIngestion) {
                                                    try {
                                                        await ragService.ingestDocument(bodyText, {
                                                            courseId,
                                                            taskId,
                                                            topicId,
                                                            contentItemId: activeContentItemId,
                                                            fileName: rawName,
                                                            fileType: 'txt'
                                                        });
                                                        console.log('✅ RAG Ingestion (content_items DB body) complete.');
                                                    } catch (err) {
                                                        console.warn('⚠️ RAG Ingestion (content_items DB) failed:', err.message);
                                                    }
                                                }
                                            }
                                        } else {
                                            console.log(`ℹ️ content_items ID=${file.id} has no body content or body too short.`);
                                        }
                                    } catch (dbErr) {
                                        console.warn(`⚠️ Failed to fetch content_items by ID ${file.id}: ${dbErr.message}`);
                                    }
                                } else {
                                    console.log(`ℹ️ Skipping file '${file.name}' — no URI, no inline content, no ID.`);
                                }
                            }
                        }
                    } catch (e) {
                        console.warn("⚠️ Error parsing jsonContent for files:", e.message);
                    }
                }

                // 📝 FALLBACK RAG INGESTION: If no files were processed but we have task/topic context
                // in the prompt, ingest the prompt context itself so rag_documents has at least
                // the topic/task description for future RAG retrieval
                if (!skipIngestion && (taskId || topicId) && courseId) {
                    try {
                        const ragServiceCtx = new RAGService();
                        // Check if any rag_documents were created by the jsonContent block above
                        const ragNowExists = await ragServiceCtx.vectorStore.exists({
                            ...(taskId ? { taskId } : {}),
                            ...(topicId ? { topicId } : {}),
                            ...(courseId ? { courseId } : {})
                        });

                        if (!ragNowExists) {
                            // Build minimal context text from the prompt for ingestion
                            // Extract meaningful context from the augmented prompt (task descriptions, topic info)
                            const contextText = [
                                taskDescription ? `Tarea: ${taskDescription}` : null,
                                prompt ? prompt.substring(0, 5000) : null
                            ].filter(Boolean).join('\n\n');

                            if (contextText.length > 100) {
                                console.log(`📝 No files were ingested. Ingesting prompt context (${contextText.length} chars) into RAG...`);
                                await ragServiceCtx.ingestDocument(contextText, {
                                    courseId: courseId,
                                    taskId: taskId,
                                    topicId: topicId,
                                    contentItemId: contentItemId,
                                    fileName: `context_task_${taskId || 'none'}_topic_${topicId || 'none'}`,
                                    fileType: 'txt'
                                });
                                console.log('✅ Prompt context RAG ingestion complete.');
                            }
                        }
                    } catch (ctxErr) {
                        console.warn('⚠️ Context RAG ingestion failed (non-blocking):', ctxErr.message);
                    }
                }

                // If this was just an embedding request, we are done after ingestion.
                if (isEmbeddingModel) {
                    console.log('✅ Ingestion request processed successfully (Embedding flow). Returning early.');
                    return res.json({
                        respuesta_texto: "Contenido procesado e indexado correctamente (Embedding-only flow).",
                        nota: null,
                        esCalificacion: false,
                        contenidoVacio: false,
                        error: null,
                        ingested: true
                    });
                }

                // Ensure ollamaUrl is valid
                if (!ollamaUrl) {
                    throw new Error('ollamaUrl is required');
                }

                // 🛑 DETECT GRADING INTENT: Only activate grading mode when there's ACTUAL
                // submission content to evaluate (fileContent > 50 chars or submissionId).
                // taskDescription alone is just informational context, NOT grading intent.
                // The LLM itself decides whether to grade via ___GRADING_SIGNAL___ in its output.
                const hasSubmissionContent = !!((fileContent && fileContent.length > 50) || submissionId);
                const isGradingRequest = hasSubmissionContent;

                console.log(`🔍 Intent Detection: hasSubmissionContent=${hasSubmissionContent}, isGradingRequest=${isGradingRequest}, hasTaskDescription=${!!taskDescription}`);

                // If userId/courseId provided AND this is NOT a grading request, fetch reinforcement history
                let historyQuestionsList = [];
                let existingHistory = [];
                if (userId && courseId && !isGradingRequest) {
                    try {
                        const mcpService = new MCPService();
                        existingHistory = await mcpService.getReinforcementHistory(userId, courseId);

                        // Extract plain question text for guidance
                        historyQuestionsList = existingHistory.map(h => {
                            if (!h) return null;
                            if (typeof h === 'string') return h;
                            if (h.question) return h.question;
                            if (h.pregunta) return h.pregunta;
                            try { return JSON.stringify(h); } catch (e) { return null; }
                        }).filter(Boolean);

                        if (historyQuestionsList.length > 0) {
                            // OPTIMIZATION: Instead of just the last 50, we want a better spread.
                            // If we have > 60 questions, we take the last 20 (recency) + 40 random from the rest.
                            let contextQuestions = [];
                            if (historyQuestionsList.length > 60) {
                                const recent = historyQuestionsList.slice(-20);
                                const older = historyQuestionsList.slice(0, -20);
                                // Fisher-Yates shuffle for older questions
                                for (let i = older.length - 1; i > 0; i--) {
                                    const j = Math.floor(Math.random() * (i + 1));
                                    [older[i], older[j]] = [older[j], older[i]];
                                }
                                contextQuestions = [...older.slice(0, 40), ...recent];
                            } else {
                                contextQuestions = historyQuestionsList;
                            }

                            // Pass selected questions to ensure better coverage against duplicates
                            augmentedPrompt += `\n\n--- AVISO CRÍTICO DE DUPLICADOS: Evita generar preguntas iguales o muy similares a las siguientes (ya dadas a este usuario en este curso):\n${contextQuestions.map((q,i)=>`${i+1}. ${q}`).join('\n')}\n---\nPor favor, crea preguntas totalmente diferentes que no repitan ni parafraseen las anteriores.`;
                        }
            } catch (e) {
                console.warn('⚠️ Could not read reinforcement history before generation:', e?.message || e);
            }
        }

        // 🛑 DETECT INTENT: Check if this is a Quiz Generation request vs. Standard Chat/Grading
        // CRITICAL: If grading context is present, NEVER treat as quiz generation
        const isQuizGeneration = !isGradingRequest && promptLower.includes('genera') && 
                               (promptLower.includes('preguntas') || promptLower.includes('quiz') || promptLower.includes('examen'));

        console.log(`🎯 Final Intent: isQuizGeneration=${isQuizGeneration}, isGradingRequest=${isGradingRequest}`);

        let llmRequestHeader = "";
        
        if (isQuizGeneration) {
             llmRequestHeader = `🎯 SISTEMA DE GENERACIÓN DE PREGUNTAS - MODO ESTRICTO (DEEPSEEK ONLY)

CONTEXTO: Se te proporciona contenido educativo real. DEBES crear preguntas basadas ÚNICAMENTE en la información específica de este contenido.

═══════════════════════════════════════════════════════════════
📋 INSTRUCCIONES OBLIGATORIAS
═══════════════════════════════════════════════════════════════

1. CADA PREGUNTA DEBE SER ÚNICA y aportar valor educativo real.
2. CADA OPCIÓN DEBE SER ESPECÍFICA Y TÉCNICA.
   - ❌ MAL: "Información irrelevante"
   - ❌ MAL: "Detalle técnico"
   - ✅ BIEN: "La latencia de red aumenta un 50% al usar VPN"
3. EVITA PATRONES REPETITIVOS en el fraseo de las preguntas (ej. no empieces todas con "Desde una perspectiva...").

═══════════════════════════════════════════════════════════════
⛔ LISTA NEGRA STRICTA - SI USAS ESTO SERÁS PENALIZADO
═══════════════════════════════════════════════════════════════

NO USES JAMÁS en preguntas u opciones:
- "Detalle superficial irrelevante"
- "Información no relacionada"
- "Definición técnica precisa"
- "Concepto erróneo común"
- "Ninguna de las anteriores" / "Todas las anteriores"
- "(Ref: ...)" o referencias a números de página/línea.
- Frases genéricas como "La respuesta correcta es..." en la explicación. Sé directo: "X es Y porque Z".

`; 
            // Prepend header only for quiz generation
            augmentedPrompt = llmRequestHeader + "\n\n" + augmentedPrompt;

             // APPEND Reminder for Recency Bias & Strict Constraints
            augmentedPrompt += `\n\n🔎 REVISIÓN FINAL OBLIGATORIA:
1. Verifica que NO hay textos genéricos ("Información irrelevante").
2. Elimina cualquier marca "(Ref: X)".
3. Asegura que las preguntas NO sean plantillas repetidas.
4. Genera JSON válido.`;
        }


                // ═══════════════════════════════════════════════════════════════
                // 🔥 DEEPSEEK PRIORITY: Siempre usar DeepSeek para generación
                // ═══════════════════════════════════════════════════════════════
                
                // DeepSeek API configuration (priority over OpenRouter for chat)
                const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
                const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
                
                let data;
                const MAX_RETRIES = 2; // Try twice to avoid long waits, but enough to fix duplicates

                for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                    if (attempt > 1) console.log(`🔄 Retrying LLM generation (Attempt ${attempt}/${MAX_RETRIES})...`);
                
                // ALWAYS prefer DeepSeek
                if (deepseekApiKey) {
                    try {
                        // ═══════════════════════════════════════════════════════════
                        // 🎯 GRADING SIGNAL STRATEGY: Instead of relying on fragile
                        // regex patterns in the LLM's free text, we instruct the LLM
                        // to append a machine-readable JSON signal block at the very
                        // end of its response ONLY when it is performing a grading
                        // evaluation. The backend parses this signal, strips it from
                        // the visible text, and returns esCalificacion + nota reliably.
                        // ═══════════════════════════════════════════════════════════
                        const GRADING_SIGNAL_INSTRUCTION = `

REGLA CRÍTICA DE SEÑALIZACIÓN:
Cuando evalúes/califiques una tarea o entrega de un estudiante y asignes una nota numérica, DEBES incluir al FINAL ABSOLUTO de tu respuesta (después de todo el texto visible) el siguiente bloque de señal exactamente así:

___GRADING_SIGNAL___
{"esCalificacion": true, "nota": X}
___END_SIGNAL___

Donde X es la nota numérica (0-10, acepta decimales como 8.5).
Ejemplo correcto al final de una evaluación:
___GRADING_SIGNAL___
{"esCalificacion": true, "nota": 8}
___END_SIGNAL___

Si NO estás calificando (por ejemplo, respondiendo una pregunta general, dando información, o conversando), NO incluyas este bloque de señal. NUNCA lo incluyas si no estás dando una nota numérica a una entrega.
Esta señal es invisible para el usuario y es procesada por el sistema.`;

                        const systemPrompt = isQuizGeneration 
                            ? 'Eres un sistema experto de evaluación educativa. Genera preguntas únicas, técnicas y específicas basadas SOLO en el texto proporcionado. ESTRUCTURA JSON OBLIGATORIA. PROHIBIDO usar "Ref:". PROHIBIDO opciones genéricas.'
                            : isGradingRequest
                            ? 'Eres un profesor experto evaluador. Responde en español. MODO CALIFICACIÓN ACTIVO. Recibes la descripción de una tarea y la entrega del estudiante. Tu trabajo es:\n1. Leer cuidadosamente la descripción/requisitos de la tarea\n2. Analizar el contenido de la entrega del estudiante\n3. Evaluar rigurosamente si la entrega cumple los requisitos\n4. Dar retroalimentación constructiva y detallada\n5. Asignar una nota numérica de 0 a 10\n\nSi el contenido del archivo parece vacío o ilegible, asigna 0/10 y explica por qué.' + GRADING_SIGNAL_INSTRUCTION
                            : 'Eres un tutor inteligente y experto. Responde en español. Si el usuario te pide explícitamente calificar o evaluar una entrega y le asignas una nota, incluye la señal de calificación. Si solo conversa o hace preguntas generales, NO incluyas señal de calificación.' + GRADING_SIGNAL_INSTRUCTION;
                            
                        console.log(`🧠 Usando DeepSeek (${isQuizGeneration ? 'QUIZ MODE' : 'CHAT MODE'})...`);
                        
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 90000); // 90 second timeout

                        const response = await fetch(DEEPSEEK_API_URL, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${deepseekApiKey}`
                            },
                            body: JSON.stringify({
                                model: 'deepseek-chat',
                                messages: [
                                    {
                                        role: 'system',
                                        content: systemPrompt
                                    },
                                    {
                                        role: 'user', 
                                        content: augmentedPrompt
                                    }
                                ],
                                temperature: 0.7,
                                max_tokens: 4096,
                                stream: false
                            }),
                            signal: controller.signal
                        });
                        
                        clearTimeout(timeoutId);

                        if (!response.ok) {
                            const errText = await response.text();
                            throw new Error(`DeepSeek API error: ${response.status} - ${errText}`);
                        }
                        
                        const json = await response.json();
                        data = {
                            response: json.choices?.[0]?.message?.content || ""
                        };
                        console.log('✅ DeepSeek respondió correctamente.');
                        console.log('📜 LLM Raw Response (DeepSeek):', data.response); // Keep log for debugging
                        
                    } catch (deepseekError) {
                        console.error('❌ Error CRÍTICO con DeepSeek:', deepseekError.message);
                        // Fallback logic continues below...
                        data = null;
                    }
                }
                
                // Fallback: OpenRouter if DeepSeek failed
                if (!data && process.env.OPENROUTER_API_KEY) {
                    try {
                        // -------------------------------------------------------------------------
                        // OPENROUTER API CALL (OpenAI Compatible)
                        // -------------------------------------------------------------------------
                        const openRouterUrl = "https://openrouter.ai/api/v1/chat/completions";
                        // Prioritize Chat-specific env var, then generic, then fallback. Avoid using embedding models for chat.
                        const envModel = process.env.OPENROUTER_CHAT_MODEL || process.env.OPENROUTER_MODEL;
                        const safeEnvModel = (envModel && !envModel.toLowerCase().includes('embedding')) ? envModel : null;
                        
                        // Fix for invalid model IDs sent by older clients (specifically Qwen3-Embedding incorrectly sent to Chat)
                        // User Request: Force DeepSeek (via OpenRouter or Native)
                        let finalModel = model;
                        if (!finalModel || finalModel === "Qwen3-VL-Embedding-8B" || finalModel === "qwen/qwen3-embedding-8b" || (typeof finalModel === 'string' && finalModel.toLowerCase().includes('embedding'))) {
                             console.warn(`⚠️ Detected invalid chat model ID request ('${finalModel}' sent to Chat endpoint). Swapping to 'deepseek/deepseek-chat'.`);
                             finalModel = "deepseek/deepseek-chat";
                        }

                        let openRouterModel = safeEnvModel || finalModel || "deepseek/deepseek-chat";
                        
                        // FINAL SAFETY CHECK: If the resolved model is still an embedding model (e.g. from misconfigured env var), FORCE a chat model.
                        if (openRouterModel.toLowerCase().includes('embedding')) {
                            console.warn(`⚠️ FINAL CHECK: Model '${openRouterModel}' is an embedding model. Forcing fallback to 'deepseek/deepseek-chat'.`);
                            openRouterModel = "deepseek/deepseek-chat";
                        }
                        
                        console.log(`🤖 Sending request to OpenRouter (Model: ${openRouterModel})`);
                        
                        const response = await fetch(openRouterUrl, {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                                'HTTP-Referer': process.env.BASE_URL || 'https://coursev.com', // Required by OpenRouter
                                'X-Title': 'CourseV MCP Backend'
                            },
                            body: JSON.stringify({
                                model: openRouterModel, 
                                messages: [
                                    { role: "system", content: isQuizGeneration 
                                        ? 'Eres un sistema experto de evaluación educativa. Genera preguntas únicas, técnicas y específicas basadas SOLO en el texto proporcionado. ESTRUCTURA JSON OBLIGATORIA.'
                                        : isGradingRequest
                                        ? 'Eres un profesor experto evaluador. Responde en español. Evalúa la entrega del estudiante contra los requisitos de la tarea. Asigna una nota de 0 a 10. Al FINAL ABSOLUTO de tu respuesta incluye:\n___GRADING_SIGNAL___\n{"esCalificacion": true, "nota": X}\n___END_SIGNAL___\nDonde X es la nota numérica. Si NO estás calificando, NO incluyas este bloque.'
                                        : 'Eres un tutor inteligente y experto. Responde en español. Si el usuario te pide calificar una entrega y asignas nota, incluye al final:\n___GRADING_SIGNAL___\n{"esCalificacion": true, "nota": X}\n___END_SIGNAL___\nSi solo conversas, NO incluyas este bloque.'
                                    },
                                    { role: "user", content: augmentedPrompt }
                                ],
                                temperature: 0.7
                            })
                        });

                        if (!response.ok) {
                            const errText = await response.text();
                            throw new Error(`OpenRouter API error: ${response.status} ${response.statusText} - ${errText}`);
                        }

                        const json = await response.json();
                        // Normalize OpenRouter (OpenAI-style) response to expected Ollama-style internal format for processing
                        data = {
                            response: json.choices?.[0]?.message?.content || ""
                        };
                    } catch (orError) {
                         // 🛑 CRITICAL: Do NOT fallback if error is Context Length (token limit) related
                         // This prevents trying to send a massive prompt to a local model which will likely crash or also fail.
                         if (orError.message && (orError.message.includes('context length') || orError.message.includes('tokens') || orError.message.includes('too large'))) {
                             console.error(`❌ OpenRouter Context Length Error: ${orError.message}`);
                             console.warn("🚫 Aborting fallback to local model due to Context Length violation. This request should probably be handled via RAG/Ingest.");
                             throw orError; 
                         }

                        console.warn(`⚠️ OpenRouter call failed: ${orError.message}. Falling back to local DeepSeek/Ollama.`);
                        // Fallback proceeds to next block if data is still undefined
                    }
                } 
                
                // Fallback or Standard Local Call (Ollama local)
                if (!data && ollamaUrl) {
                    // -------------------------------------------------------------------------
                    // STANDARD OLLAMA LOCAL CALL (último recurso)
                    // -------------------------------------------------------------------------
                    const baseUrl = ollamaUrl.endsWith('/') ? ollamaUrl.slice(0, -1) : ollamaUrl;
                    const targetUrl = `${baseUrl}/api/generate`;
                    
                    // Validate model for local call too (prevent sending embedding models to chat endpoint)
                    let localModel = model || 'deepseek-chat';
                    if (localModel.toLowerCase().includes('embedding')) {
                         console.warn(`⚠️ Detected embedding model '${localModel}' for Chat fallback. Swapping to 'deepseek-chat'.`);
                         localModel = 'deepseek-chat';
                    }

                    console.log(`🤖 Fallback: Sending request to local Ollama at ${targetUrl} (Model: ${localModel})`);
            
                    const response = await fetch(targetUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: localModel,
                            prompt: augmentedPrompt,
                            stream: false,
                            options: {
                                temperature: 0.7 // Standard creativity
                            }
                        })
                    });
            
                    if (!response.ok) {
                        throw new Error(`DeepSeek API error: ${response.status} ${response.statusText}`);
                    }
                    
                    data = await response.json();
                }

                // Si ningún LLM respondió, lanzar error
                if (!data || !data.response) {
                    // If this was the last attempt, we let it fall through to the final error check
                     if (attempt < MAX_RETRIES) {
                        console.warn(`⚠️ Attempt ${attempt} failed to get any response. Retrying...`);
                        continue;
                    }
                } else {
                     // 🛑 DUPLICATE CHECK (Inside Loop)
                    // If we are generating questions (not grading), check for duplicates immediately
                    if (!isGradingRequest && historyQuestionsList && historyQuestionsList.length > 0) {
                        try {
                            const rawCheck = typeof data.response === 'string' ? data.response : JSON.stringify(data.response);
                            const start = rawCheck.indexOf('[');
                            const end = rawCheck.lastIndexOf(']');
                            if (start !== -1 && end !== -1) {
                                const jsonStr = rawCheck.substring(start, end + 1);
                                const parsedCheck = JSON.parse(jsonStr);
                                if (Array.isArray(parsedCheck)) {
                                    const newTexts = parsedCheck.map(q => (q.question || q.pregunta || '').trim()).filter(Boolean);
                                    // Check against history
                                    const duplicateCount = newTexts.filter(t => questionExistsInHistory(t, historyQuestionsList)).length;
                                    
                                    if (duplicateCount > 0 && duplicateCount >= newTexts.length / 2) {
                                        console.warn(`♻️ GENERATION REJECTED: ${duplicateCount}/${newTexts.length} questions are duplicates. (Attempt ${attempt}/${MAX_RETRIES})`);
                                        if (attempt < MAX_RETRIES) {
                                            augmentedPrompt += `\n\n❌ GENERACIÓN ANTERIOR DESCARTADA: Generaste preguntas duplicadas (${newTexts.slice(0,2).join(', ')}...). \n⚠️ INSTRUCCIÓN CRÍTICA: Debes generar preguntas COMPLETAMENTE NUEVAS. No repitas NADA del historial.`;
                                            data = null; // Force retry
                                            continue;
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            // Ignore parse errors here, let main parser handle it or fail
                        }
                    } 
                    
                    // If valid and unique (or close enough), break out of loop
                    break;
                }
            } // End of retry loop

            if (!data || !data.response) {
                throw new Error('No se pudo obtener respuesta de ningún modelo LLM tras ' + MAX_RETRIES + ' intentos.');
            }

                // Attempt to normalize and shuffle options so the correct answer isn't always in the same position.
                let respuestaTexto = data.response;

                // 🛠️ FIX: Clean Markdown code blocks from DeepSeek response
                if (typeof respuestaTexto === 'string') {
                    if (respuestaTexto.includes('```json')) {
                        respuestaTexto = respuestaTexto.split('```json')[1].split('```')[0].trim();
                    } else if (respuestaTexto.includes('```')) {
                        respuestaTexto = respuestaTexto.split('```')[1].split('```')[0].trim();
                    }
                }

        try {
            // Ensure we have a string to search for JSON array
            const raw = typeof respuestaTexto === 'string' ? respuestaTexto : JSON.stringify(respuestaTexto);
            
            console.log('🔍 Attempting to extract JSON from response...');
            const start = raw.indexOf('[');
            const end = raw.lastIndexOf(']');
            
            if (start !== -1 && end !== -1 && start < end) {
                const arrayJson = raw.substring(start, end + 1);
                let parsed;
                try {
                    parsed = JSON.parse(arrayJson);
                    console.log(`✅ JSON Parsed Successfully. Found ${parsed.length} items.`);
                } catch (parseErr) {
                    console.error('❌ JSON Parse Error:', parseErr.message);
                    console.log('📜 Raw Snippet:', arrayJson.substring(0, 100) + '...');
                    throw parseErr;
                }

                if (Array.isArray(parsed)) {
                    // Fisher-Yates shuffle helper
                    const shuffle = (arr) => {
                        for (let i = arr.length - 1; i > 0; i--) {
                            const j = Math.floor(Math.random() * (i + 1));
                            [arr[i], arr[j]] = [arr[j], arr[i]];
                        }
                    };

                    const transformed = parsed.map((q) => {
                        try {
                            if (!q || !Array.isArray(q.options)) return q;
                            // Keep a copy of the original correct value (by index)
                            let origIdx = 0;
                            if (typeof q.correctIndex === 'number') {
                                origIdx = q.correctIndex;
                            } else if (typeof q.correctIndex === 'string') {
                                // Handle string indices like "0", "1", "A", "B"
                                if (/^\d+$/.test(q.correctIndex)) {
                                    origIdx = parseInt(q.correctIndex, 10);
                                } else {
                                    // Try to map "A"->0, "B"->1, etc. if model returns letters
                                    const map = { 'a': 0, 'b': 1, 'c': 2, 'd': 3, 'A': 0, 'B': 1, 'C': 2, 'D': 3 };
                                    if (q.correctIndex in map) {
                                        origIdx = map[q.correctIndex];
                                    }
                                }
                            }
                            
                            // Validate bounds
                            if (origIdx < 0 || origIdx >= q.options.length) origIdx = 0;

                            const origCorrect = q.options[origIdx];
                            const newOptions = q.options.slice();
                            shuffle(newOptions);
                            
                            // Find new index of the original correct option.
                            let newIndex = newOptions.findIndex(o => o === origCorrect);
                            if (newIndex === -1) {
                                // Should not happen if logic is correct, but safe fallback
                                newIndex = 0;
                            }
                            return {
                                ...q,
                                options: newOptions,
                                correctIndex: newIndex
                            };
                        } catch (e) {
                            // If anything goes wrong with a single question, return it unchanged
                            return q;
                        }
                    });



                    // Helper: normalize text
                    const normalizeText = (s) => s ? s.trim().toLowerCase() : '';

                    let filtered = [];

                    // ═══════════════════════════════════════════════════════════════
                    // VALIDATION — Filter blacklisted/invalid questions.
                    // Actual DB save (question_sessions) happens AFTER this block,
                    // in the unified AUTO-SAVE section before res.json().
                    // ═══════════════════════════════════════════════════════════════

                    if (userId && courseId) {
                        try {
                            console.log(`🔍 Validating ${transformed.length} questions (User: ${userId})...`);

                            // Validate & Filter (Blacklist Only — no DB save)
                            const validQuestions = [];
                            for (const q of transformed) {
                                if (!q.question || !Array.isArray(q.options)) continue;

                                const BLACKLISTED_OPTIONS = [
                                    'detalle superficial',
                                    'información no relacionada',
                                    'definición técnica precisa',
                                    'concepto erróneo común',
                                    'definición opuesta al concepto',
                                    'ninguna de las anteriores',
                                    'todas las anteriores',
                                    'opción incorrecta',
                                    'respuesta incorrecta',
                                    'dato irrelevante',
                                    'afirmación falsa sobre',
                                    '(ref:',
                                    'ref:'
                                ];
                                
                                const hasBlacklistedOption = q.options.some(opt => {
                                    const optLower = (opt || '').toLowerCase().trim();
                                    return BLACKLISTED_OPTIONS.some(blacklisted => optLower.includes(blacklisted));
                                });
                                
                                if (hasBlacklistedOption) {
                                    console.log('🚫 Rechazando pregunta con opción genérica/prohibida:', q.question);
                                    continue;
                                }

                                if (q.question && (q.question.includes('(Ref:') || q.question.includes('Ref:'))) {
                                     console.log('🚫 Rechazando pregunta con marca de referencia (Ref:):', q.question);
                                     continue;
                                }
                                
                                validQuestions.push(q);
                            }

                            // Return validated questions (auto-save happens after response is built)
                            filtered = validQuestions.length > 0 ? validQuestions : [];
                            console.log(`✅ Validated ${filtered.length} questions (from ${transformed.length}).`);

                        } catch (e) {
                            console.warn('⚠️ Failed to validate questions:', e?.message || e);
                            filtered = transformed;
                        }
                    } else {
                        filtered = transformed;
                    }

                                // If everything was filtered out (duplicates/disallowed), attempt up to 2 retries
                                if ((userId && courseId) && Array.isArray(filtered) && filtered.length === 0 && historyQuestionsList.length > 0) {
                                    console.log('🔁 All questions filtered; attempting DeepSeek/LLM retries to generate distinct questions');
                                    for (let attempt = 1; attempt <= 2 && filtered.length === 0; attempt++) {
                                        try {
                                            // Sample a NEW set of history for the retry to give different negative examples
                                            const retryShuffledHistory = [...historyQuestionsList].sort(() => 0.5 - Math.random());
                                            const retrySample = retryShuffledHistory.slice(0, 60);

                                            const retryPrompt = augmentedPrompt + `\n\nREINTENTO ${attempt}: Genera 10 preguntas totalmente diferentes que NO sean idénticas a las siguientes (ya vistas):\n${retrySample.map((q,i)=>`${i+1}. ${q}`).join('\n')}\nSi no es posible, intenta cambiar el enfoque de las preguntas.`;
                                            
                                            let retryData = null;

                                            // 1. Retry with DeepSeek (Priority)
                                            if (deepseekApiKey) {
                                                const dsResp = await fetch("https://api.deepseek.com/chat/completions", {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${deepseekApiKey}` },
                                                    body: JSON.stringify({
                                                        model: 'deepseek-chat',
                                                        messages: [{ role: 'system', content: 'Eres un sistema experto.' }, { role: 'user', content: retryPrompt }],
                                                        temperature: 0.8,
                                                        max_tokens: 4096,
                                                        stream: false
                                                    })
                                                });
                                                if (dsResp.ok) {
                                                    const dsJson = await dsResp.json();
                                                    retryData = { response: dsJson.choices?.[0]?.message?.content || "" };
                                                }
                                            } 
                                            // 2. Retry with OpenRouter
                                            else if (process.env.OPENROUTER_API_KEY) {
                                                const orResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                                                    method: 'POST',
                                                    headers: { 
                                                        'Content-Type': 'application/json', 
                                                        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
                                                        'HTTP-Referer': process.env.BASE_URL || 'https://coursev.com',
                                                        'X-Title': 'CourseV MCP Backend'
                                                    },
                                                    body: JSON.stringify({
                                                        model: process.env.OPENROUTER_CHAT_MODEL || 'deepseek/deepseek-chat', 
                                                        messages: [{ role: "user", content: retryPrompt }],
                                                        temperature: 0.8
                                                    })
                                                });
                                                if (orResp.ok) {
                                                    const orJson = await orResp.json();
                                                    retryData = { response: orJson.choices?.[0]?.message?.content || "" };
                                                }
                                            }
                                            // 3. Retry with Local Ollama
                                            else if (ollamaUrl) {
                                                const baseUrl = ollamaUrl.endsWith('/') ? ollamaUrl.slice(0, -1) : ollamaUrl;
                                                const localTarget = `${baseUrl}/api/generate`;
                                                const localResp = await fetch(localTarget, {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ model: model || 'deepseek-chat', prompt: retryPrompt, stream: false, options: { temperature: 0.8 } })
                                                });
                                                if (localResp.ok) retryData = await localResp.json();
                                            }

                                            if (!retryData) {
                                                 console.warn(`⚠️ Retry ${attempt} failed: No LLM response.`);
                                                 continue;
                                            }

                                            // Process Retry Response (Common Logic)
                                            let rawRetry = typeof retryData.response === 'string' ? retryData.response : JSON.stringify(retryData.response);
                                            // Clean Markdown
                                            if (rawRetry.includes('```json')) rawRetry = rawRetry.split('```json')[1].split('```')[0].trim();
                                            else if (rawRetry.includes('```')) rawRetry = rawRetry.split('```')[1].split('```')[0].trim();

                                            const s = rawRetry.indexOf('[');
                                            const e = rawRetry.lastIndexOf(']');
                                            if (s !== -1 && e !== -1 && s < e) {
                                                try {
                                                    const arrJ = rawRetry.substring(s, e + 1);
                                                    const parsedRetry = JSON.parse(arrJ);
                                                    if (Array.isArray(parsedRetry) && parsedRetry.length > 0) {
                                                        const transformedRetry = parsedRetry.map(q => {
                                                            try {
                                                                if (!q || !Array.isArray(q.options)) return q;
                                                                let origIdx = 0;
                                                                if (typeof q.correctIndex === 'number') origIdx = q.correctIndex;
                                                                else if (typeof q.correctIndex === 'string' && /^\d+$/.test(q.correctIndex)) origIdx = parseInt(q.correctIndex);
                                                                
                                                                const origCorrect = q.options[origIdx] || q.options[0];
                                                                const newOptions = q.options.slice();
                                                                for (let i = newOptions.length - 1; i > 0; i--) {
                                                                    const j = Math.floor(Math.random() * (i + 1));
                                                                    [newOptions[i], newOptions[j]] = [newOptions[j], newOptions[i]];
                                                                }
                                                                let newIndex = newOptions.findIndex(o => o === origCorrect);
                                                                if (newIndex === -1) newIndex = 0;
                                                                return { ...q, options: newOptions, correctIndex: newIndex };
                                                            } catch (qq) { return q; }
                                                        });

                                                        // Filter parsedRetry using questionExistsInHistory
                                                        const historyToCheck = existingHistory && existingHistory.length ? existingHistory : historyQuestionsList;
                                                        const newlyFiltered = transformedRetry.filter(q => {
                                                            try { const qText = q.question || q.pregunta || JSON.stringify(q); return !questionExistsInHistory(qText, historyToCheck); } catch (ex) { return true; }
                                                        });

                                                        if (newlyFiltered.length > 0) {
                                                            // Return validated retry questions (auto-save happens after response is built)
                                                            filtered = newlyFiltered;
                                                            console.log(`✅ Retry accepted ${filtered.length} questions.`);
                                                            break;
                                                        }
                                                    }
                                                } catch (parseErr) {
                                                    console.warn('⚠️ Could not parse retry response JSON array:', parseErr?.message || parseErr);
                                                }
                                            }
                                        } catch (retryErr) {
                                            console.warn('⚠️ Retry attempt failed:', retryErr?.message || retryErr);
                                        }
                                    }
                                }

                                respuestaTexto = JSON.stringify(filtered);
                }
            }
        } catch (e) {
            console.warn('⚠️ Could not parse/shuffle LLM response JSON array:', e?.message || e);
            // Keep original data.response in case of parse failure
            respuestaTexto = data.response;
        }

        // ═══════════════════════════════════════════════════════════════
        // 🎯 GRADING SIGNAL PARSING: Extract the ___GRADING_SIGNAL___ block
        // from the LLM response. This is the PRIMARY and RELIABLE method.
        // Falls back to legacy regex only if the signal block is missing.
        // ═══════════════════════════════════════════════════════════════
        let extractedGrade = null;
        let isGrading = false;

        if (typeof respuestaTexto === 'string') {
            try {
                // PRIMARY: Parse ___GRADING_SIGNAL___ block
                const signalRegex = /___GRADING_SIGNAL___\s*\n?\s*(\{[^}]+\})\s*\n?\s*___END_SIGNAL___/;
                const signalMatch = respuestaTexto.match(signalRegex);

                if (signalMatch && signalMatch[1]) {
                    try {
                        const signalData = JSON.parse(signalMatch[1]);
                        if (signalData.esCalificacion === true && signalData.nota !== undefined) {
                            extractedGrade = parseFloat(signalData.nota);
                            if (!isNaN(extractedGrade)) {
                                isGrading = true;
                                // Clamp grade to 0-10 range
                                extractedGrade = Math.max(0, Math.min(10, extractedGrade));
                                console.log(`🎯 GRADING SIGNAL detected: nota=${extractedGrade}/10`);
                            }
                        }
                    } catch (parseErr) {
                        console.warn('⚠️ Failed to parse GRADING_SIGNAL JSON:', parseErr.message);
                    }

                    // Strip the signal block from visible text
                    respuestaTexto = respuestaTexto.replace(/\s*___GRADING_SIGNAL___\s*\n?\s*\{[^}]+\}\s*\n?\s*___END_SIGNAL___\s*/g, '').trim();
                }

                // FALLBACK: Legacy regex for backward compatibility (only if signal not found)
                if (!isGrading) {
                    const gradeMatch = respuestaTexto.match(/\*\*calificación actual:\s*([\d\.]+)\/10\*\*/i) ||
                                      respuestaTexto.match(/calificación actual:\s*([\d\.]+)\/10/i) ||
                                      respuestaTexto.match(/\*\*calificación:\s*([\d\.]+)\/10\*\*/i) ||
                                      respuestaTexto.match(/calificación:\s*([\d\.]+)\/10/i) ||
                                      respuestaTexto.match(/\*\*nota:\s*([\d\.]+)\/10\*\*/i) ||
                                      respuestaTexto.match(/nota:\s*([\d\.]+)\/10/i) ||
                                      respuestaTexto.match(/\*\*nota final:\s*([\d\.]+)\/10\*\*/i);

                    if (gradeMatch && gradeMatch[1]) {
                        const val = parseFloat(gradeMatch[1]);
                        if (!isNaN(val)) {
                            // Only activate grading via fallback if this was actually a grading request
                            // This prevents false positives like "que se nota al hablar de Marie Curie"
                            if (isGradingRequest) {
                                extractedGrade = val;
                                isGrading = true;
                                console.log(`🎓 Grade extracted via FALLBACK regex: ${extractedGrade}/10 (isGradingRequest=${isGradingRequest})`);
                            } else {
                                console.log(`⚠️ Grade pattern found in text (${val}/10) but isGradingRequest=false — ignoring to prevent false positive`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn('⚠️ Error extracting grade from response:', e.message);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // 🔥 AUTO-SAVE QUESTION SESSION TO SUPABASE
        // Single unified save point for ALL quiz generation paths.
        // Saves to question_sessions with user_id, course_id, topic_id, task_id.
        // Uses MCPService.saveReinforcementHistory which creates the session
        // and saves individual questions with hash/embedding uniqueness checks.
        // ═══════════════════════════════════════════════════════════════
        if (isQuizGeneration && userId && courseId && !isGrading) {
            try {
                // Parse respuestaTexto to get the questions array
                let questionsToSave = [];
                try {
                    const parsed = JSON.parse(respuestaTexto);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        questionsToSave = parsed;
                    }
                } catch (_) { /* not JSON — skip save */ }

                if (questionsToSave.length > 0) {
                    console.log(`💾 [AUTO-SAVE] Saving ${questionsToSave.length} questions to question_sessions (User: ${userId}, Course: ${courseId}, Topic: ${topicId}, Task: ${taskId})...`);
                    const mcpService = new MCPService();
                    const saveResult = await mcpService.saveReinforcementHistory(
                        userId, courseId, questionsToSave, topicId, taskId
                    );
                    if (saveResult && saveResult.success) {
                        console.log(`✅ [AUTO-SAVE] Session created with ${saveResult.savedCount} questions saved.`);
                    } else {
                        console.warn(`⚠️ [AUTO-SAVE] saveReinforcementHistory returned: ${JSON.stringify(saveResult)}`);
                    }
                } else {
                    console.log('ℹ️ [AUTO-SAVE] No parseable questions in response — skipping session save.');
                }
            } catch (autoSaveErr) {
                console.error('❌ [AUTO-SAVE] Failed to save question session:', autoSaveErr.message);
            }
        }

        // Return in MicroservicioPromptResponse format matching Android expectations
        res.json({
            respuesta_texto: respuestaTexto,
            nota: extractedGrade,
            esCalificacion: isGrading,
            contenidoVacio: false,
            error: null
        });

    } catch (error) {
        console.error('❌ Error processing prompt:', error);
        res.status(500).json({
            respuesta_texto: null,
            error: error.message,
            detalle: error.stack
        });
    }
});

// Helper function to check if a question already exists in history
function questionExistsInHistory(questionText, historyList) {
    if (!questionText || !historyList || !Array.isArray(historyList)) return false;
    const normalized = questionText.trim().toLowerCase();
    
    return historyList.some(item => {
        let historyText = "";
        if (typeof item === 'string') {
            historyText = item;
        } else if (item && typeof item === 'object') {
            historyText = item.question || item.pregunta || JSON.stringify(item);
        }
        
        if (!historyText) return false;
        
        const hNormalized = historyText.trim().toLowerCase();
        // Check for exact match or significant overlap (e.g. one contains the other)
        // Using a length check to avoid trivial matches like "a" inside "apple"
        if (normalized === hNormalized) return true;
        
        if (normalized.length > 20 && hNormalized.length > 20) {
             if (normalized.includes(hNormalized) || hNormalized.includes(normalized)) return true;
        }
        
        return false;
    });
}

export default router;