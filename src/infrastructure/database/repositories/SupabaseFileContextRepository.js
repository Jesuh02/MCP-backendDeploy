/**
 * SupabaseFileContextRepository — CRUD for file_contexts table.
 */
export class SupabaseFileContextRepository {
    constructor(client) { this.client = client; }

    async findById(id) {
        const { data, error } = await this.client.from('file_contexts').select('*').eq('id', id).single();
        if (error || !data) return null;
        return data;
    }

    async findBySubmissionId(submissionId) {
        const { data, error } = await this.client.from('file_contexts').select('*').eq('submission_id', submissionId).order('created_at', { ascending: false });
        if (error) return [];
        return data || [];
    }

    async findAll({ offset = 0, limit = 50 } = {}) {
        const { data, error } = await this.client.from('file_contexts').select('*').order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (error) return [];
        return data || [];
    }

    async create(fileContextData) {
        const payload = {
            submission_id: fileContextData.submissionId,
            file_name: fileContextData.fileName || null,
            file_type: fileContextData.fileType || null,
            file_content: fileContextData.fileContent || null,
            extracted_text: fileContextData.extractedText || null,
            content_summary: fileContextData.summary || null,
            metadata: fileContextData.metadata || null,
        };
        const { data, error } = await this.client.from('file_contexts').insert(payload).select().single();
        if (error) throw new Error(`Error creando file context: ${error.message}`);
        return data;
    }

    async delete(id) {
        const { error } = await this.client.from('file_contexts').delete().eq('id', id);
        if (error) throw new Error(`Error eliminando file context: ${error.message}`);
        return true;
    }
}
export default SupabaseFileContextRepository;