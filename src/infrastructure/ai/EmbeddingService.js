import { OpenAIEmbeddings } from "@langchain/openai";
import { OllamaEmbeddings } from "@langchain/community/embeddings/ollama";

export class EmbeddingService {
    static instance = null;

    static getInstance() {
        if (!EmbeddingService.instance) {
            EmbeddingService.instance = new EmbeddingService();
        }
        return EmbeddingService.instance;
    }

    constructor() {
        if (EmbeddingService.instance) return EmbeddingService.instance;

        const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
        const openAiApiKey = process.env.OPENAI_API_KEY;
        
        // Prioritize OpenAI for embeddings as DeepSeek might not have a dedicated embedding endpoint compatible with this SDK version
        if (openAiApiKey) {
            console.log("Initializing OpenAI Embeddings...");
            this.model = new OpenAIEmbeddings({
                openAIApiKey: openAiApiKey,
                modelName: "text-embedding-3-small"
            });
        } else if (deepSeekApiKey) {
             // Attempt to use DeepSeek if they have an embedding endpoint (experimental)
             console.log("Initializing DeepSeek Embeddings...");
             this.model = new OpenAIEmbeddings({
                openAIApiKey: deepSeekApiKey,
                configuration: {
                    baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
                },
                modelName: "deepseek-embedding" // Assuming this model name
            });
        } else {
            console.log("Initializing Ollama Embeddings...");
            this.model = new OllamaEmbeddings({
                baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
                model: "nomic-embed-text" // Standard open source embedding model
            });
        }
    }

    async embedQuery(text) {
        try {
            return await this.model.embedQuery(text);
        } catch (error) {
            console.error("Error generating query embedding:", error);
            throw error;
        }
    }

    async embedDocuments(texts) {
        try {
            return await this.model.embedDocuments(texts);
        } catch (error) {
            console.error("Error generating document embeddings:", error);
            throw error;
        }
    }
}
