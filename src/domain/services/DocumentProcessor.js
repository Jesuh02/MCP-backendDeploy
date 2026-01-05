import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";

export class DocumentProcessor {
    constructor() {
        this.splitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200,
        });
    }

    async splitText(text) {
        if (!text) return [];
        try {
            const docs = await this.splitter.createDocuments([text]);
            return docs.map(doc => doc.pageContent);
        } catch (error) {
            console.error("Error splitting text:", error);
            return [text]; // Fallback to full text if split fails (though unlikely)
        }
    }
}
