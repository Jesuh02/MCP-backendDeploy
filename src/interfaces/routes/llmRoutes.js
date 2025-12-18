import { Router } from 'express';
import { R2StorageService } from '../../services/R2StorageService.js';
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
                                     // Only include text content. Skip binary/base64 to avoid confusing text-only models.
                                     if (!fileData.isBase64) {
                                         // Limit content size per file to avoid context window overflow
                                         const contentSnippet = fileData.content.substring(0, 8000); 
                                         augmentedPrompt += `\n\n--- Contenido del archivo: ${file.name} (${fileData.contentType}) ---\n${contentSnippet}`;
                                         if (fileData.content.length > 8000) {
                                             augmentedPrompt += `\n...(contenido truncado)...`;
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

        // Call Ollama
        // If ollamaUrl ends with /, remove it
        const baseUrl = ollamaUrl.endsWith('/') ? ollamaUrl.slice(0, -1) : ollamaUrl;
        const targetUrl = `${baseUrl}/api/generate`;
        
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model || 'llama3',
                prompt: augmentedPrompt,
                stream: false,
                options: {
                    temperature: 0.7 // Standard creativity
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
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