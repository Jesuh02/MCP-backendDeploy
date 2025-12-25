import { Router } from 'express';
import { R2StorageService } from '../../services/R2StorageService.js';
import { SupabaseService } from '../../infrastructure/database/SupabaseService.js';
import { MCPService } from '../../domain/services/MCPService.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');
const xlsx = require('xlsx');

// Note: In Node 18+, fetch is global. If older, might need node-fetch. Assuming environment supports it.

const router = Router();

router.post('/procesar-prompt', async (req, res) => {
    try {
        const { prompt, ollamaUrl, model, jsonContent } = req.body;
        
        console.log(`🤖 Processing prompt with model ${model || 'default'} at ${ollamaUrl}`);

        let augmentedPrompt = prompt;

        // Process jsonContent to fetch files from R2
        if (jsonContent) {
            try {
                const files = JSON.parse(jsonContent);
                if (Array.isArray(files) && files.length > 0) {
                    console.log(`📂 Procesando ${files.length} archivos adjuntos...`);
                    const r2Service = R2StorageService.getInstance();
                    
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
                                        // INCLUDE TODO el contenido del archivo (sin límite por archivo)
                                        const contentSnippet = extractedText;
                                        augmentedPrompt += `\n\n--- Contenido del archivo: ${rawName} (${fileData.contentType}) ---\n${contentSnippet}`;
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

        // Ensure ollamaUrl is valid
        if (!ollamaUrl) {
            throw new Error('ollamaUrl is required');
        }

        // If userId/courseId provided, fetch reinforcement history and instruct LLM to avoid repeats
        const userId = req.body.userId || req.body.user_id || req.body.usuarioId || null;
        const courseId = req.body.courseId || req.body.course_id || req.body.idCurso || null;
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
                    try { return JSON.stringify(h); } catch(e) { return null; }
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
                // Insertamos un encabezado que obliga al modelo a usar TODO el contenido
                // de los archivos del curso (tareas y temas) y a devolver un JSON estructurado.
                const llmRequestHeader = `LLM REQUEST START:
INSTRUCCIÓN CRÍTICA DE CONTEXTO:
El usuario ha adjuntado MÚLTIPLES archivos y contenidos del curso (tareas, temas, PDFs, documentos).
TU TAREA ES ANALIZAR Y UTILIZAR EL CONTENIDO DE **TODOS** LOS ARCHIVOS PROPORCIONADOS, SIN EXCEPCIÓN.
NO te limites a analizar solo el primer archivo o solo el último.
NO apliques límites de lectura: procesa la información completa de cada archivo adjunto para generar las preguntas.

Si hay archivos adjuntos (PDFs, Excel, Texto), su contenido está incluido en este prompt. ÚSALO TODO.
Priorice el contenido de los archivos sobre los nombres de las tareas si hay conflicto.

REGLA DE ALEATORIEDAD:
La respuesta correcta NO debe estar siempre en la primera opción (índice 0).
Distribuye aleatoriamente la posición de la respuesta correcta entre las opciones A, B, C y D.

FORMATO DE SALIDA REQUERIDO: Devuelva UN ÚNICO array JSON con objetos de esta forma:
[
    {
        "question": "Texto de la pregunta",
        "options": ["opción A","opción B","opción C","opción D"],
        "correctIndex": 2, // (0=A, 1=B, 2=C, 3=D) - VARÍA ESTE ÍNDICE ALEATORIAMENTE
        "difficulty": "easy|medium|hard",
        "topic": "tema o tarea relacionada (ej: 'Tarea 1 - Tema: Álgebra')",
        "source": "nombre_del_archivo_o_ruta_de_origen"
    }
]

LLM REQUEST END`;

                // Prepend header so the model sees the requirement first
                augmentedPrompt = llmRequestHeader + "\n\n" + augmentedPrompt;

                // Call LLM (DeepSeek via Ollama wrapper or Direct)
                // If ollamaUrl ends with /, remove it
        const baseUrl = ollamaUrl.endsWith('/') ? ollamaUrl.slice(0, -1) : ollamaUrl;
        const targetUrl = `${baseUrl}/api/generate`;
        
        console.log(`🤖 Sending request to DeepSeek at ${targetUrl} (Model: ${model || 'deepseek-chat'})`);

        // Prioritize file content in the prompt
        // If files were processed, we move them to the TOP of the prompt context
        // This helps the LLM focus on the files more than the task titles
        
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model || 'deepseek-chat', // Default to deepseek
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

        const data = await response.json();

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
                            
                            // Ensure explanation is present (fix for null explanation error)
                            let finalExplanation = q.explanation;
                            if (!finalExplanation || typeof finalExplanation !== 'string') {
                                finalExplanation = "Respuesta correcta basada en el análisis del contenido del curso.";
                            }

                            return {
                                ...q,
                                options: newOptions,
                                correctIndex: newIndex,
                                explanation: finalExplanation
                            };
                        } catch (e) {
                            // If anything goes wrong with a single question, return it unchanged
                            // but ensure explanation is at least present
                            if (q && !q.explanation) {
                                return { ...q, explanation: "Respuesta basada en el contenido." };
                            }
                            return q;
                        }
                    });

                    // If userId/courseId are provided, filter out any questions that were already served
                    // to that user in that course by consulting Supabase `reinforcement_question_history`.
                    const userId = req.body.userId || req.body.user_id || req.body.usuarioId || null;
                    const courseId = req.body.courseId || req.body.course_id || req.body.idCurso || null;

                    // Helper: normalize text
                    const normalizeText = (s) => {
                        if (!s) return '';
                        try {
                            return s.toString()
                                .toLowerCase()
                                .normalize('NFD')
                                .replace(/\p{Diacritic}/gu, '')
                                .replace(/[^a-z0-9\s]/g, ' ')
                                .replace(/\s+/g, ' ')
                                .trim();
                        } catch (e) {
                            return s.toString()
                                .toLowerCase()
                                .normalize('NFD')
                                .replace(/[\u0300-\u036f]/g, '')
                                .replace(/[^a-z0-9\s]/g, ' ')
                                .replace(/\s+/g, ' ')
                                .trim();
                        }
                    };

                    const questionExistsInHistory = (questionText, historyArray) => {
                        if (!questionText) return false;
                        const qNorm = normalizeText(questionText);
                        if (!historyArray || !Array.isArray(historyArray)) return false;
                        for (const h of historyArray) {
                            try {
                                let candidate = '';
                                if (!h) continue;
                                if (typeof h === 'string') candidate = h;
                                else if (h.question) candidate = h.question;
                                else if (h.pregunta) candidate = h.pregunta;
                                else candidate = JSON.stringify(h);

                                const cNorm = normalizeText(candidate);
                                if (!cNorm) continue;
                                if (cNorm === qNorm || cNorm.includes(qNorm) || qNorm.includes(cNorm)) {
                                    return true;
                                }
                            } catch (e) {
                                continue;
                            }
                        }
                        return false;
                    };

                    let filtered = transformed;

                    if (userId && courseId) {
                        try {
                            const mcpService = new MCPService();
                            
                            // Check against full history again
                            const history = existingHistory && existingHistory.length ? existingHistory : historyQuestionsList;
                            
                            filtered = transformed.filter(q => {
                                try {
                                    const qText = q.question || q.pregunta || JSON.stringify(q);
                                    return !questionExistsInHistory(qText, history);
                                } catch (e) { return true; }
                            });

                                        // Save newly selected questions back to history (append as new record)
                                        if (filtered.length > 0) {
                                            const toSave = filtered.map(fq => fq);
                                            await mcpService.saveReinforcementHistory(userId, courseId, toSave);
                                        } else {
                                            console.log(`ℹ️ All generated questions were already seen by user ${userId} for course ${courseId}`);
                                        }
                        } catch (e) {
                            console.warn('⚠️ Failed to consult/save reinforcement history:', e?.message || e);
                        }
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

                                                                let finalExpl = q.explanation;
                                                                if (!finalExpl || typeof finalExpl !== 'string') {
                                                                    finalExpl = "Respuesta correcta basada en el análisis del contenido.";
                                                                }

                                                                return { ...q, options: newOptions, correctIndex: newIndex, explanation: finalExpl };
                                                            } catch (qq) { 
                                                                if (q && !q.explanation) return { ...q, explanation: "Respuesta basada en el contenido." };
                                                                return q; 
                                                            }
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
                                                                await mcpService2.saveReinforcementHistory(userId, courseId, toSave);
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

export default router;