/**
 * SupabaseCourseReadRepository — Read Model ligero para consultas de listado.
 *
 * CQRS parcial: separa las queries de lectura (listados, búsquedas) del
 * modelo completo de escritura. Solo selecciona los campos necesarios para
 * vistas de catálogo/listado, reduciendo el payload y mejorando performance.
 *
 * El CourseDomainService puede usar este para listados públicos,
 * mientras que las operaciones de escritura usan el repositorio completo.
 */

// Campos ligeros para vistas de listado (catálogo, búsqueda, enrolled)
const LIST_FIELDS = 'id, title, description, thumbnail_url, creator_user_id, is_active, is_premium, price, category, level, deadline, created_at';

// Campos para vista de estudiante (enrolled view)
const ENROLLED_FIELDS = 'id, title, thumbnail_url, is_active, category';

export class SupabaseCourseReadRepository {
    constructor(client) {
            this.client = client;
        }
        /**
         * Lista cursos para catálogo — solo campos esenciales.
         */
    async listForCatalog({ offset = 0, limit = 20, activeOnly = false, excludeCreatorId = null } = {}) {
        let query = this.client.from('courses').select(LIST_FIELDS);
        if (activeOnly) query = query.eq('is_active', true);
        if (excludeCreatorId) query = query.neq('creator_user_id', excludeCreatorId);

        const { data, error } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw new Error(error.message);
        return data || [];
    }

    /**
     * Busca cursos — solo campos esenciales.
     */
    async searchForCatalog(searchQuery, { offset = 0, limit = 20, activeOnly = false } = {}) {
        const raw = (searchQuery || '').trim();
        if (!raw) return [];
        const safe = raw.replace(/[\\",()]/g, '');
        const filter = `title.ilike."%${safe}%",description.ilike."%${safe}%"`;

        let query = this.client.from('courses').select(LIST_FIELDS).or(filter);
        if (activeOnly) query = query.eq('is_active', true);

        const { data, error } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw new Error(error.message);
        return data || [];
    }

    /**
     * Cursos inscritos por estudiante — vista mínima.
     */
    async listForStudent(courseIds) {
        if (!courseIds || courseIds.length === 0) return [];

        const { data, error } = await this.client
            .from('courses')
            .select(ENROLLED_FIELDS)
            .in('id', courseIds);

        if (error) throw new Error(error.message);
        return data || [];
    }

    /**
     * Cursos gratuitos — vista catálogo.
     */
    async listFreeForCatalog({ offset = 0, limit = 20, activeOnly = false } = {}) {
        let query = this.client.from('courses').select(LIST_FIELDS).eq('is_premium', false);
        if (activeOnly) query = query.eq('is_active', true);

        const { data, error } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw new Error(error.message);
        return data || [];
    }

    /**
     * Cursos premium — vista catálogo.
     */
    async listPremiumForCatalog({ offset = 0, limit = 20, activeOnly = false } = {}) {
        let query = this.client.from('courses').select(LIST_FIELDS).eq('is_premium', true);
        if (activeOnly) query = query.eq('is_active', true);

        const { data, error } = await query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw new Error(error.message);
        return data || [];
    }

    /**
     * Cursos por IDs — vista ligera.
     */
    async findByIdsLightweight(ids) {
        if (!ids || ids.length === 0) return [];

        const { data, error } = await this.client
            .from('courses')
            .select(LIST_FIELDS)
            .in('id', ids);

        if (error) throw new Error(error.message);
        return data || [];
    }
}

export default SupabaseCourseReadRepository;