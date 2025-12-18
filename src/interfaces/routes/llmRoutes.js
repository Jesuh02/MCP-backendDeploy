import { Router } from 'express';
// Note: In Node 18+, fetch is global. If older, might need node-fetch. Assuming environment supports it.

const router = Router();

router.post('/procesar-prompt', async (req, res) => {
    try {
        const { prompt, ollamaUrl, model } = req.body;
        
        console.log(`🤖 Processing prompt with model ${model || 'default'} at ${ollamaUrl}`);

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
                prompt: prompt,
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