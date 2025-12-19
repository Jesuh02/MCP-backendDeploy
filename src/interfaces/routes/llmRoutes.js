import { Router } from 'express';
import { R2StorageService } from '../../services/R2StorageService.js';
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

                    respuestaTexto = JSON.stringify(transformed);
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