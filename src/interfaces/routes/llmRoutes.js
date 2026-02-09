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
                const userId = req.body.userId || req.body.user_id || req.body.usuarioId || null;
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

                // Check if session exists to see if we can skip ingestion (User Rule: omit creation of new embeddings if session exists)
                let skipIngestion = false;
                if (userId && taskId && topicId) {
                    try {
                        const { data } = await SupabaseService.getInstance().client
                            .from('question_sessions')
                            .select('id')
                            .eq('user_id', userId)
                            .eq('task_id', taskId)
                            .eq('topic_id', topicId)
                            .maybeSingle();
                        if (data) {
                            skipIngestion = true;
                            console.log(`ℹ️ Session ${data.id} exists for this task. Will skip new embedding ingestion.`);
                        }
                    } catch (e) {
                        console.warn('⚠️ Failed to check question_sessions:', e.message);
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

                // Process jsonContent to fetch files from R2 (ONLY if NOT retrieved from RAG or explicitly requested)
                // Note: If contextFromRAG is true, we might SKIP downloading files to save time/bandwidth
                // However, user said "el LLM no haga el proceso de crear embeddings", implying we skip the *ingestion*, 
                // but we should still possibly put text in prompt if RAG failed?
                // Strategy: If RAG found content, we assume it's good and skip file download.
                // If not found, we download, extract, AND INGEST.

                if (jsonContent && !contextFromRAG) {
                    try {
                        const files = JSON.parse(jsonContent);
                        if (Array.isArray(files) && files.length > 0) {
                            console.log(`📂 Procesando ${files.length} archivos adjuntos...`);
                            const r2Service = R2StorageService.getInstance();
                            const ragService = new RAGService(); // Warning: Multiple instances lightweight

                            for (const file of files) {
                                if (file.uri && (r2Service.isR2Url(file.uri) || file.uri.startsWith('http'))) {
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
                            }
                        }
                    } catch (e) {
                        console.warn("⚠️ Error parsing jsonContent for files:", e.message);
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

                // 🛑 DETECT GRADING INTENT FIRST: If taskDescription, fileContent, or submissionId are present,
                // this is a GRADING request from ChatBotFragment, NOT a quiz generation request.
                const hasGradingContext = !!(taskDescription || (fileContent && fileContent.length > 50) || submissionId);
                const gradingKeywords = ['calific', 'nota', 'evalu', 'puntaje', 'grade', 'score', 'revisar entrega'];
                const hasGradingKeyword = gradingKeywords.some(kw => promptLower.includes(kw));
                // isGradingRequest is true if we have grading context (taskDescription/fileContent/submissionId)
                // OR if grading keywords appear in the prompt WITHOUT quiz generation pattern
                const isGradingRequest = hasGradingContext || (hasGradingKeyword && !promptLower.includes('genera') && !promptLower.includes('quiz'));

                console.log(`🔍 Intent Detection: hasGradingContext=${hasGradingContext}, hasGradingKeyword=${hasGradingKeyword}, isGradingRequest=${isGradingRequest}`);

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
                            // Pass up to 50 previous questions to ensure better coverage against duplicates
                            augmentedPrompt += `\n\n--- AVISO: Evita generar preguntas iguales o muy similares a las siguientes (ya dadas a este usuario en este curso):\n${historyQuestionsList.slice(-50).map((q,i)=>`${i+1}. ${q}`).join('\n')}\n---\nPor favor, crea preguntas totalmente diferentes que no repitan ni parafraseen las anteriores.`;
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
                
                // ALWAYS prefer DeepSeek
                if (deepseekApiKey) {
                    try {
                        const systemPrompt = isQuizGeneration 
                            ? 'Eres un sistema experto de evaluación educativa. Genera preguntas únicas, técnicas y específicas basadas SOLO en el texto proporcionado. ESTRUCTURA JSON OBLIGATORIA. PROHIBIDO usar "Ref:". PROHIBIDO opciones genéricas.'
                            : isGradingRequest
                            ? 'Eres un profesor experto evaluador. Responde en español. MODO CALIFICACIÓN ACTIVO. Recibes la descripción de una tarea y la entrega del estudiante. Tu trabajo es:\n1. Leer cuidadosamente la descripción/requisitos de la tarea\n2. Analizar el contenido de la entrega del estudiante\n3. Evaluar rigurosamente si la entrega cumple los requisitos\n4. Dar retroalimentación constructiva y detallada\n5. OBLIGATORIO: Incluir al final de tu respuesta la línea exacta "**calificación actual: X/10**" (donde X es la nota numérica). Sin esta línea, el profesor NO podrá guardar la nota en el sistema. Ejemplo: "**calificación actual: 8/10**"\n6. OBLIGATORIO: Como PRIMERA línea de tu respuesta escribe exactamente "[GRADING_SIGNAL]" (sin comillas). Esto activa la interfaz de calificación en la app. SOLO inclúyela cuando estés calificando una entrega real.\n\nSi el contenido del archivo parece vacío o ilegible, asigna 0/10 y explica por qué. Incluye [GRADING_SIGNAL] igualmente porque sigue siendo una calificación.'
                            : 'Eres un tutor inteligente y experto. Responde en español.\n\n═══ SISTEMA DE SEÑAL DE CALIFICACIÓN ═══\nExiste una señal especial llamada [GRADING_SIGNAL] que activa botones de calificación en la app del estudiante.\n\nREGLAS ABSOLUTAS:\n1. INCLUYE "[GRADING_SIGNAL]" como PRIMERA línea de tu respuesta ÚNICAMENTE cuando el usuario te pide EXPLÍCITAMENTE calificar, evaluar, puntuar o dar nota a una entrega/tarea específica.\n2. NUNCA incluyas [GRADING_SIGNAL] si el usuario solo está conversando, haciendo preguntas académicas, pidiendo explicaciones o usando palabras como "nota", "evaluación" en sentido coloquial.\n3. Cuando incluyas [GRADING_SIGNAL], DEBES también incluir al final: "**calificación actual: X/10**"\n\nEJEMPLOS DONDE **NO** DEBES INCLUIR [GRADING_SIGNAL]:\n- "¿qué se nota al hablar de Marie Curie?" → "nota" = observar, NO calificación\n- "¿cómo me evalúo a mí mismo?" → pregunta general, no pide calificar entrega\n- "explícame la nota musical Do" → "nota" = nota musical\n- "dame un resumen del tema" → solicitud informativa\n- "¿qué calificación necesito para aprobar?" → pregunta informativa, NO pide calificar\n\nEJEMPLOS DONDE **SÍ** DEBES INCLUIR [GRADING_SIGNAL]:\n- "califica mi entrega" / "califica esta tarea"\n- "ponle nota a mi trabajo" / "dame la nota de esta entrega"\n- "evalúa mi tarea" / "revisa y califica mi entrega"\n- "¿cuánto saqué?" (cuando hay contexto de tarea enviada)\n\nRecuerda: Si no estás 100% seguro de que el usuario quiere una calificación numérica de una entrega de tarea, NO incluyas [GRADING_SIGNAL].';
                            
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
                                        ? 'Eres un profesor experto evaluador. Responde en español. Evalúa la entrega del estudiante contra los requisitos de la tarea. OBLIGATORIO: Incluir al final "**calificación actual: X/10**". Como PRIMERA línea escribe exactamente "[GRADING_SIGNAL]".'
                                        : 'Eres un tutor inteligente y experto. Responde en español. SOLO incluye "[GRADING_SIGNAL]" como primera línea si el usuario EXPLÍCITAMENTE pide calificar/evaluar/puntuar una entrega de tarea. Si solo conversa, hace preguntas o usa palabras como "nota" en sentido coloquial (ej: "qué se nota"), NO incluyas [GRADING_SIGNAL] bajo ninguna circunstancia.'
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
                    throw new Error('No se pudo obtener respuesta de ningún modelo LLM (DeepSeek, OpenRouter, Ollama)');
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

                    if (userId && courseId) {
                        try {
                            const supabase = SupabaseService.getInstance();

                            // 1. Ensure Session Exists (Paso 0)
                            let sessionId = null;
                            if (taskId && topicId) {
                                try {
                                    const { data: sessionData } = await supabase.client
                                        .from('question_sessions')
                                        .insert({ user_id: userId, course_id: courseId, topic_id: topicId, task_id: taskId })
                                        .select('id')
                                        .single();
                                    if (sessionData) sessionId = sessionData.id;
                                    console.log(`✅ Session created/logged: ${sessionId}`);
                                } catch(e) { 
                                     console.warn('Session creation warning (might exist):', e.message);
                                }
                            }

                            console.log(`🔍 Validating ${transformed.length} questions (User: ${userId})...`);

                            // 2. Validate & Filter (Simpler Blacklist Only for Speed/Stability)
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

                            // 3. Save to Supabase (Robust Method)
                            if (validQuestions.length > 0) {
                                console.log(`💾 Saving ${validQuestions.length} validated questions to Supabase...`);
                                // Call MCPService saver with Strict Uniqueness
                                const mcpSaver = new MCPService();
                                const savedResult = await mcpSaver.saveReinforcementHistory(userId, courseId, validQuestions, topicId, taskId, sessionId);
                                // UPDATE: Use ONLY the questions that were actually saved (unique)
                                if (savedResult && savedResult.savedQuestions) {
                                     filtered = savedResult.savedQuestions;
                                     console.log(`✅ Accepted ${filtered.length} unique questions (Rejected ${validQuestions.length - filtered.length} duplicates).`);
                                } else {
                                     filtered = []; 
                                }
                            } else {
                                filtered = [];
                            }

                        } catch (e) {
                            console.warn('⚠️ Failed to consult/save reinforcement history (DB check):', e?.message || e);
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
                                                            try {
                                                                // Save using MCPService with Strict Uniqueness
                                                                const mcpSaver = new MCPService();
                                                                const retrySaveResult = await mcpSaver.saveReinforcementHistory(userId, courseId, newlyFiltered, topicId, taskId, sessionId);
                                                                
                                                                if (retrySaveResult && retrySaveResult.savedQuestions && retrySaveResult.savedQuestions.length > 0) {
                                                                    filtered = retrySaveResult.savedQuestions;
                                                                    console.log(`✅ Retry accepted ${filtered.length} unique questions.`);
                                                                    break; // Success!
                                                                } else {
                                                                    console.warn('⚠️ Retry questions were all duplicates (rejected by DB).');
                                                                    filtered = []; // Continue loop
                                                                }
                                                            } catch (upErr) { console.warn('⚠️ Failed to save retry results:', upErr?.message || upErr); }
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

        // Extract grade if present (Backend-side parsing to ensure Android buttons appear)
        let extractedGrade = null;
        let isGrading = false;

        if (typeof respuestaTexto === 'string') {
            // 🎯 SEMANTIC GRADING SIGNAL: The LLM includes [GRADING_SIGNAL] ONLY when it semantically
            // determines the user is requesting a task grade. This prevents false positives like
            // "que se nota al hablar de Marie Curie?" from triggering grading buttons.
            if (respuestaTexto.includes('[GRADING_SIGNAL]')) {
                isGrading = true;
                // Strip the tag from the visible response
                respuestaTexto = respuestaTexto.replace(/\[GRADING_SIGNAL\]\s*/g, '').trim();
                console.log('🎯 [GRADING_SIGNAL] detected - LLM confirms this is a grading request');
            }

            // Only extract grade if [GRADING_SIGNAL] was present
            // This prevents conversational mentions of "nota" from activating grading UI
            if (isGrading) {
                try {
                    // Regex to find **calificación actual: X/10** or similar patterns
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
                            extractedGrade = val;
                            console.log(`🎓 Grade extracted from response: ${extractedGrade}/10 (with GRADING_SIGNAL)`);
                        }
                    }
                } catch (e) {
                    console.warn('⚠️ Error extracting grade from response:', e.message);
                }
            } else {
                console.log('ℹ️ No [GRADING_SIGNAL] in response - grading UI will NOT be activated');
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