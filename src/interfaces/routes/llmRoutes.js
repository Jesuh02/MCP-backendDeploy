import { Router } from 'express';
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
                const { prompt, ollamaUrl, model, jsonContent } = req.body;

                // 🛑 CRITICAL: If model is an embedding model, it MUST NOT go to chat
                // The prompt will be processed for Ingestion (embeddings), then we return early.
                const isEmbeddingModel = model && (
                    model.toLowerCase().includes('embedding') ||
                    model.toLowerCase().includes('text-embed') ||
                    model === "Qwen3-VL-Embedding-8B"
                );

                if (isEmbeddingModel) {
                    console.log(`📡 Embedding model detected (${model}). Processing ONLY for Document Ingestion (RAG).`);
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
                                            // Handle Text (already handled, but let's consolidate)
                                            else if (!fileData.isBase64) {
                                                extractedText = fileData.content;
                                                processMsg = "Contenido de texto plano";
                                                console.log(`📝 CONTENIDO TEXTO (${rawName} - primeros 1000 chars):\n${extractedText.substring(0, 1000)}...`);
                                            }

                                            if (extractedText) {
                                                // Only include text content. Skip binary/base64 to avoid confusing text-only models.
                                                // SAFETY LIMIT: OpenRouter has 160k token limit.
                                                // We cap total prompt size to avoid 400 Bad Request errors.
                                                const MAX_TOTAL_CONTEXT_CHARS = 400000; // ~100k tokens safe limit
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
                                                        console.log('✅ Ingestion complete.');
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

                // If userId/courseId provided, fetch reinforcement history and instruct LLM to avoid repeats
                let historyQuestionsList = [];
                let existingHistory = [];
                if (userId && courseId) {
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


                // LLM REQUEST START: instrucción fija para generación de preguntas
                const llmRequestHeader = `🎯 SISTEMA DE GENERACIÓN DE PREGUNTAS - MODO ESTRICTO

CONTEXTO: Se te proporciona contenido educativo real de un curso. DEBES crear preguntas basadas ÚNICAMENTE en la información específica del contenido proporcionado.

═══════════════════════════════════════════════════════════════
📋 INSTRUCCIONES OBLIGATORIAS (FAILURE = RECHAZO TOTAL)
═══════════════════════════════════════════════════════════════

1. ANALIZA el contenido proporcionado e identifica:
   - Conceptos clave y definiciones
   - Datos específicos (fechas, nombres, porcentajes, fórmulas)
   - Procesos o procedimientos descritos
   - Comparaciones o diferencias mencionadas

2. GENERA preguntas que:
   ✅ Pregunten sobre hechos ESPECÍFICOS del contenido
   ✅ Tengan UNA sola respuesta correcta verificable en el texto
   ✅ Usen vocabulario técnico del dominio

3. CADA OPCIÓN debe ser:
   ✅ Una afirmación completa y específica (mínimo 8 palabras)
   ✅ Técnicamente plausible para alguien que no leyó el material
   ✅ Diferente en contenido semántico a las demás opciones

═══════════════════════════════════════════════════════════════
⛔ PROHIBICIONES ABSOLUTAS - SI VIOLAS ESTO, TU RESPUESTA ES INVÁLIDA
═══════════════════════════════════════════════════════════════

NUNCA uses estas frases como opciones (lista negra):
- "Detalle superficial irrelevante"
- "Información no relacionada directamente"  
- "Definición técnica precisa sobre..."
- "Concepto erróneo común sobre..."
- "Definición opuesta al concepto"
- "Ninguna de las anteriores"
- "Todas las anteriores"
- "Opción incorrecta"
- Cualquier metadescripción que NO sea contenido real

NUNCA incluyas en la pregunta:
- "(Ref: número)"
- Nombres de archivos
- IDs de sesión

═══════════════════════════════════════════════════════════════
📝 FORMATO DE SALIDA (JSON PURO - SIN TEXTO ADICIONAL)
═══════════════════════════════════════════════════════════════

[
    {
        "question": "Según el texto, ¿cuál es la principal diferencia entre machine learning supervisado y no supervisado?",
        "options": [
            "El supervisado requiere datos etiquetados mientras que el no supervisado encuentra patrones sin etiquetas",
            "El no supervisado necesita más capacidad computacional que el supervisado para funcionar",
            "El supervisado solo funciona con imágenes mientras el no supervisado procesa texto",
            "Ambos métodos son idénticos pero el supervisado es una versión más antigua"
        ],
        "correctIndex": 0,
        "difficulty": "medium",
        "topic": "Machine Learning",
        "explanation": "El aprendizaje supervisado usa datos con etiquetas conocidas para entrenar, mientras que el no supervisado descubre estructuras ocultas en datos sin etiquetar."
    }
]

NOTA: La posición de correctIndex debe variar aleatoriamente (0, 1, 2, o 3) entre preguntas.

═══════════════════════════════════════════════════════════════
📚 CONTENIDO DEL CURSO PARA ANALIZAR:
═══════════════════════════════════════════════════════════════
`; 

                // Prepend header so the model sees the requirement first
                augmentedPrompt = llmRequestHeader + "\n\n" + augmentedPrompt;

                // ═══════════════════════════════════════════════════════════════
                // 🔥 DEEPSEEK PRIORITY: Siempre usar DeepSeek para generación
                // ═══════════════════════════════════════════════════════════════
                
                // DeepSeek API configuration (priority over OpenRouter for chat)
                const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
                const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
                
                let data;
                
                // ALWAYS prefer DeepSeek for question generation
                if (deepseekApiKey) {
                    try {
                        console.log('🧠 Usando DeepSeek para generación de preguntas...');
                        
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
                                        content: 'Eres un experto en educación que genera preguntas de examen de alta calidad. SIEMPRE respondes en formato JSON puro sin texto adicional. Tus opciones de respuesta son específicas y técnicas, NUNCA genéricas.'
                                    },
                                    {
                                        role: 'user', 
                                        content: augmentedPrompt
                                    }
                                ],
                                temperature: 0.7,
                                max_tokens: 4096
                            })
                        });
                        
                        if (!response.ok) {
                            const errText = await response.text();
                            throw new Error(`DeepSeek API error: ${response.status} - ${errText}`);
                        }
                        
                        const json = await response.json();
                        data = {
                            response: json.choices?.[0]?.message?.content || ""
                        };
                        console.log('✅ DeepSeek respondió correctamente');
                        
                    } catch (deepseekError) {
                        console.error('❌ Error con DeepSeek:', deepseekError.message);
                        // Fallback to OpenRouter or local
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
                        let finalModel = model;
                        if (!finalModel || finalModel === "Qwen3-VL-Embedding-8B" || finalModel === "qwen/qwen3-embedding-8b" || (typeof finalModel === 'string' && finalModel.toLowerCase().includes('embedding'))) {
                             console.warn(`⚠️ Detected invalid chat model ID request ('${finalModel}' sent to Chat endpoint). Swapping to default Chat model.`);
                             finalModel = process.env.OPENROUTER_CHAT_MODEL || "qwen/qwen-2.5-vl-7b-instruct";
                        }

                        let openRouterModel = safeEnvModel || finalModel || "qwen/qwen-2.5-vl-7b-instruct";
                        
                        // FINAL SAFETY CHECK: If the resolved model is still an embedding model (e.g. from misconfigured env var), FORCE a chat model.
                        if (openRouterModel.toLowerCase().includes('embedding')) {
                            console.warn(`⚠️ FINAL CHECK: Model '${openRouterModel}' is an embedding model. Forcing fallback to chat model.`);
                            openRouterModel = "qwen/qwen-2.5-vl-7b-instruct";
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
        try {
            // Ensure we have a string to search for JSON array
            const raw = typeof respuestaTexto === 'string' ? respuestaTexto : JSON.stringify(respuestaTexto);
            const start = raw.indexOf('[');
            const end = raw.lastIndexOf(']');
            if (start !== -1 && end !== -1 && start < end) {
                const arrayJson = raw.substring(start, end + 1);
                const parsed = JSON.parse(arrayJson);
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
                            const embeddingService = EmbeddingService.getInstance();

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
                                     // Try fetching if insert failed (likely shouldn't happen with identity PK unless logic changes, but safeguard)
                                }
                            }

                            console.log(`🔍 Validating ${transformed.length} questions for uniqueness (User: ${userId})...`);

                            for (const q of transformed) {
                                try {
                                    // Validate q structure
                                    if (!q.question || !Array.isArray(q.options)) continue;

                                    // ═══════════════════════════════════════════════════════════
                                    // 🚫 LISTA NEGRA: Rechazar opciones genéricas ANTES de procesar
                                    // ═══════════════════════════════════════════════════════════
                                    const BLACKLISTED_OPTIONS = [
                                        'detalle superficial',
                                        'información no relacionada',
                                        'definición técnica precisa sobre',
                                        'concepto erróneo común',
                                        'definición opuesta al concepto',
                                        'ninguna de las anteriores',
                                        'todas las anteriores',
                                        'opción incorrecta',
                                        'respuesta incorrecta',
                                        'dato irrelevante',
                                        'afirmación falsa sobre'
                                    ];
                                    
                                    const hasBlacklistedOption = q.options.some(opt => {
                                        const optLower = (opt || '').toLowerCase().trim();
                                        return BLACKLISTED_OPTIONS.some(blacklisted => optLower.includes(blacklisted));
                                    });
                                    
                                    if (hasBlacklistedOption) {
                                        console.log('🚫 Rechazando pregunta con opción genérica/prohibida:', q.question);
                                        continue;
                                    }
                                    
                                    // Validar que las opciones tengan contenido mínimo (al menos 5 palabras)
                                    const hasShortOptions = q.options.some(opt => {
                                        const words = (opt || '').trim().split(/\s+/).length;
                                        return words < 4;
                                    });
                                    
                                    if (hasShortOptions) {
                                        console.log('🚫 Rechazando pregunta con opciones muy cortas:', q.question);
                                        continue;
                                    }

                                    // Normalize & Hash (Paso B)
                                    const normalizedQ = normalizeText(q.question);
                                    const hash = crypto.createHash('sha256').update(normalizedQ).digest('hex');

                                    // Check exact hash in DB
                                    const { data: hashExists } = await supabase.client.from('questions_history')
                                        .select('id').eq('user_id', userId).eq('question_hash', hash).maybeSingle();
                                    
                                    if (hashExists) {
                                        console.log('🚫 Skipping duplicate hash:', q.question);
                                        continue;
                                    }

                                    // Embed Question (Paso C)
                                    let qEmbedding = null;
                                    try {
                                        qEmbedding = await embeddingService.embedQuery(q.question);
                                        
                                        // Validar que el embedding sea un array válido de números
                                        if (!qEmbedding || !Array.isArray(qEmbedding) || qEmbedding.length === 0) {
                                            console.warn('⚠️ Embedding generado es inválido (null o vacío).');
                                            qEmbedding = null;
                                        } else if (qEmbedding.some(n => typeof n !== 'number' || isNaN(n))) {
                                            console.warn('⚠️ Embedding contiene valores no numéricos.');
                                            qEmbedding = null;
                                        }
                                    } catch (embErr) {
                                        console.warn('❌ Error generando embedding para pregunta:', embErr.message);
                                        qEmbedding = null;
                                    }

                                    if (qEmbedding) {
                                        // Semantic Search (Paso D & E)
                                        const { data: similarQuestions } = await supabase.client.rpc('match_questions', {
                                            query_embedding: qEmbedding,
                                            match_threshold: 0.9,
                                            match_count: 1,
                                            filter_user_id: userId
                                        });
                                        
                                        if (similarQuestions && similarQuestions.length > 0) {
                                            console.log(`🚫 Skipping semantically similar question (${(similarQuestions[0].similarity*100).toFixed(1)}%):`, similarQuestions[0].question_text);
                                            continue;
                                        }
                                    }

                                    // Validate Options (Paso G) - Validar opciones semánticamente únicas
                                    let optionsValid = true;
                                    let optionEmbeddings = [];
                                    
                                    if (qEmbedding) { // Only generate embeddings if service is working
                                        try {
                                             // Generate embeddings in parallel for speed
                                             const embeddings = await Promise.all(q.options.map(opt => embeddingService.embedQuery(opt)));
                                             optionEmbeddings = q.options.map((opt, i) => ({ text: opt, embedding: embeddings[i] }));

                                             // Validar unicidad de opciones contra el historial del usuario
                                             for (const optEmbObj of optionEmbeddings) {
                                                if (optEmbObj.embedding) {
                                                    const { data: similarOptions } = await supabase.client.rpc('match_options', {
                                                        query_embedding: optEmbObj.embedding,
                                                        match_threshold: 0.95, // Umbral muy alto para evitar falsos positivos con palabras cortas
                                                        match_count: 1,
                                                        filter_user_id: userId
                                                    });
                                                    
                                                    if (similarOptions && similarOptions.length > 0) {
                                                        console.log(`🚫 Rechazando opción repetida (${(similarOptions[0].similarity*100).toFixed(1)}%): "${optEmbObj.text}"`);
                                                        optionsValid = false;
                                                        break;
                                                    }
                                                }
                                             }

                                        } catch (e) {
                                             console.warn("⚠️ Option embedding failed, falling back to null", e.message);
                                             optionEmbeddings = q.options.map(o => ({ text: o, embedding: null }));
                                        }
                                    } else {
                                        // Fallback: Map options without embedding
                                        optionEmbeddings = q.options.map(o => ({ text: o, embedding: null }));
                                    }

                                    if (!optionsValid) { 
                                        continue;
                                    }

                                    // Save Question (Paso F)
                                    const { data: qInserted, error: qError } = await supabase.client
                                        .from('questions_history')
                                        .insert({
                                            session_id: sessionId,
                                            user_id: userId,
                                            course_id: courseId,
                                            question_text: q.question,
                                            question_hash: hash,
                                            question_embedding: qEmbedding,
                                            correct_index: q.correctIndex,
                                            explanation: q.explanation || '' 
                                        })
                                        .select('id')
                                        .single();

                                    if (qError || !qInserted) {
                                        console.warn('Failed to insert question:', qError);
                                        continue;
                                    }

                                    // Save Options (Paso H)
                                    for (let i=0; i<optionEmbeddings.length; i++) {
                                        await supabase.client.from('question_options').insert({
                                            question_id: qInserted.id,
                                            option_text: optionEmbeddings[i].text,
                                            option_embedding: optionEmbeddings[i].embedding,
                                            order_index: i
                                        });
                                    }
                                    
                                    // Add to filtered list (to return to user)
                                    filtered.push(q);
                                } catch(e) {
                                    console.error('Error processing question uniqueness:', e);
                                }
                            }
                            
                            console.log(`✅ Accepted ${filtered.length} unique questions out of ${transformed.length}`);

                        } catch (e) {
                            console.warn('⚠️ Failed to consult/save reinforcement history (DB check):', e?.message || e);
                            filtered = transformed;
                        }
                    } else {
                        filtered = transformed;
                    }

                                // If everything was filtered out (duplicates/disallowed), attempt up to 2 retries
                                if ((userId && courseId) && Array.isArray(filtered) && filtered.length === 0 && historyQuestionsList.length > 0) {
                                    console.log('🔁 All questions filtered; attempting DeepSeek retries to generate distinct questions');
                                    for (let attempt = 1; attempt <= 2 && filtered.length === 0; attempt++) {
                                        try {
                                            // Sample a NEW set of history for the retry to give different negative examples
                                            const retryShuffledHistory = [...historyQuestionsList].sort(() => 0.5 - Math.random());
                                            const retrySample = retryShuffledHistory.slice(0, 60);

                                            const retryPrompt = augmentedPrompt + `\n\nREINTENTO ${attempt}: Genera 10 preguntas totalmente diferentes que NO sean idénticas a las siguientes (ya vistas):\n${retrySample.map((q,i)=>`${i+1}. ${q}`).join('\n')}\nSi no es posible, intenta cambiar el enfoque de las preguntas.`;

                                            const retryResp = await fetch(targetUrl, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ model: model || 'deepseek-chat', prompt: retryPrompt, stream: false, options: { temperature: 0.8 } })
                                            });

                                            if (!retryResp.ok) {
                                                console.warn(`⚠️ Retry ${attempt} DeepSeek API error: ${retryResp.status} ${retryResp.statusText}`);
                                                continue;
                                            }

                                            const retryData = await retryResp.json();
                                            const rawRetry = typeof retryData.response === 'string' ? retryData.response : JSON.stringify(retryData.response);
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
                                                                const origIdx = typeof q.correctIndex === 'number' ? q.correctIndex : 0;
                                                                const origCorrect = q.options[origIdx];
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

                                                        // Filter parsedRetry using questionExistsInHistory against existingHistory (or historyQuestionsList)
                                                        const historyToCheck = existingHistory && existingHistory.length ? existingHistory : historyQuestionsList;
                                                        const newlyFiltered = transformedRetry.filter(q => {
                                                            try { const qText = q.question || q.pregunta || JSON.stringify(q); return !questionExistsInHistory(qText, historyToCheck); } catch (ex) { return true; }
                                                        });

                                                        if (newlyFiltered.length > 0) {
                                                            filtered = newlyFiltered;
                                                            // Upsert these into history
                                                            try {
                                                                const mcpService2 = new MCPService();
                                                                const toSave = filtered.map(fq => fq);
                                                                await mcpService2.saveReinforcementHistory(userId, courseId, toSave, topicId, taskId);
                                                            } catch (upErr) { console.warn('⚠️ Failed to save retry results:', upErr?.message || upErr); }
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

        // Return in MicroservicioPromptResponse format matching Android expectations
        res.json({
            respuesta_texto: respuestaTexto,
            nota: null,
            esCalificacion: false,
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