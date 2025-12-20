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
                    console.log(`📂 Processing ${files.length} attached files...`);
                    const r2Service = R2StorageService.getInstance();
                    
                    for (const file of files) {
                        if (file.uri && (r2Service.isR2Url(file.uri) || file.uri.startsWith('http'))) {
                            console.log(`📥 Downloading content for ${file.name}...`);
                            try {
                                // Use getSubmissionFileContent which handles various sources (R2, HTTP)
                                const fileData = await r2Service.getSubmissionFileContent(file.uri, file.name);
                                 
                                 if (fileData && fileData.content) {
                                     let extractedText = null;
                                     let processMsg = "";

                                     // Handle PDF
                                     if (fileData.contentType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
                                         try {
                                             console.log(`📄 Parsing PDF: ${file.name}`);
                                             // content is likely base64 for PDFs from R2StorageService
                                             const pdfBuffer = Buffer.from(fileData.content, fileData.isBase64 ? 'base64' : 'utf-8');
                                             const pdfData = await pdf(pdfBuffer);
                                             extractedText = pdfData.text;
                                             processMsg = `PDF parsed (${extractedText.length} chars)`;
                                             console.log(`✅ ${processMsg}`);
                                         } catch (e) {
                                             console.warn(`⚠️ PDF parse failed for ${file.name}: ${e.message}`);
                                         }
                                     }
                                     // Handle Excel
                                     else if (fileData.contentType.includes('spreadsheet') || fileData.contentType.includes('excel') || file.name.toLowerCase().match(/\.xlsx?$/)) {
                                         try {
                                             console.log(`📊 Parsing Excel: ${file.name}`);
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
                                             processMsg = `Excel parsed (${extractedText.length} chars)`;
                                             console.log(`✅ ${processMsg}`);
                                         } catch (e) {
                                             console.warn(`⚠️ Excel parse failed for ${file.name}: ${e.message}`);
                                         }
                                     }
                                     // Handle Text (already handled, but let's consolidate)
                                     else if (!fileData.isBase64) {
                                         extractedText = fileData.content;
                                         processMsg = "Text content";
                                     }

                                     if (extractedText) {
                                         // Only include text content. Skip binary/base64 to avoid confusing text-only models.
                                         // Limit content size per file to avoid context window overflow
                                         const contentSnippet = extractedText.substring(0, 15000); 
                                         augmentedPrompt += `\n\n--- Contenido del archivo: ${file.name} (${fileData.contentType}) ---\n${contentSnippet}`;
                                         if (extractedText.length > 15000) {
                                             augmentedPrompt += `\n...(contenido truncado, total ${extractedText.length} chars)...`;
                                         }
                                     } else {
                                         augmentedPrompt += `\n\n--- Archivo adjunto: ${file.name} (${fileData.contentType}) [Contenido binario no incluido] ---`;
                                     }
                                 }
                            } catch (e) {
                                console.warn(`⚠️ Failed to fetch file ${file.name}: ${e.message}`);
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
                            const origIdx = typeof q.correctIndex === 'number' ? q.correctIndex : 0;
                            const origCorrect = q.options[origIdx];
                            const newOptions = q.options.slice();
                            shuffle(newOptions);
                            // Find new index of the original correct option. If duplicates exist, find by value first occurrence.
                            let newIndex = newOptions.findIndex(o => o === origCorrect);
                            if (newIndex === -1) {
                                // Fallback: if value comparison fails, try to preserve by position mapping
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
                                    for (let attempt = 1; attempt <= 3 && filtered.length === 0; attempt++) {
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