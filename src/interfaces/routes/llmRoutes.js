import { Router } from 'express';
import { R2StorageService } from '../../services/R2StorageService.js';
import { SupabaseService } from '../../infrastructure/database/SupabaseService.js';
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
                            const supabase = SupabaseService.getInstance();
                            if (supabase && supabase.client) {
                                const { data: existing, error } = await supabase.client
                                    .from('reinforcement_question_history')
                                    .select('questions')
                                    .eq('user_id', userId)
                                    .eq('course_id', courseId)
                                    .single();

                                const history = (existing && existing.questions) ? existing.questions : [];

                                filtered = transformed.filter(q => {
                                    try {
                                        const qText = q.question || q.pregunta || JSON.stringify(q);
                                        return !questionExistsInHistory(qText, history);
                                    } catch (e) { return true; }
                                });

                                // Save newly selected questions back to history (append, keep last 50)
                                if (filtered.length > 0) {
                                    const toSave = filtered.map(fq => fq);
                                    const allQuestions = Array.isArray(history) ? [...history, ...toSave] : toSave;
                                    const recentQuestions = allQuestions.slice(-50);
                                    await supabase.client
                                        .from('reinforcement_question_history')
                                        .upsert({ user_id: userId, course_id: courseId, questions: recentQuestions }, { onConflict: 'user_id,course_id' });
                                } else {
                                    console.log(`ℹ️ All generated questions were already seen by user ${userId} for course ${courseId}`);
                                }
                            }
                        } catch (e) {
                            console.warn('⚠️ Failed to consult/save reinforcement history:', e?.message || e);
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