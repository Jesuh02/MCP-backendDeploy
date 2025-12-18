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
        const { prompt, ollamaUrl, model, jsonContent, requestNonce } = req.body;
        
        console.log(`🤖 Processing prompt with model ${model || 'default'} at ${ollamaUrl}`);

        let augmentedPrompt = prompt;

        // If a nonce/request id is provided, include it to ensure the model receives a unique prompt
        if (requestNonce) {
            augmentedPrompt = `Request-Nonce: ${requestNonce}\n\n` + augmentedPrompt;
            console.log(`🔐 Using requestNonce: ${requestNonce}`);
        }

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
        
        // Determine temperature based on task type
        // Higher temperature for quizzes to ensure variety (0.85), lower for code analysis (0.2)
        let temperature = 0.7;
        if (augmentedPrompt.includes("PREGUNTAS PROHIBIDAS") || augmentedPrompt.includes("Request ID")) {
            console.log("🎲 Quiz generation detected: increasing temperature to 0.85 for variety");
            temperature = 0.85;
        }

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model || 'deepseek-chat', // Default to deepseek
                prompt: augmentedPrompt,
                stream: false,
                options: {
                    temperature: temperature // Dynamic temperature
                }
            })
        });

        if (!response.ok) {
            throw new Error(`DeepSeek API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        // Return in MicroservicioPromptResponse format matching Android expectations
        res.json({
            respuesta_texto: data.response,
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