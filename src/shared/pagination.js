/**
 * Helpers de paginación estándar.
 *
 * Uso:
 *   const { offset, limit } = parsePagination(req.query);
 *   const result = buildPaginatedResponse(rows, total, page, pageSize);
 */

/**
 * Extrae y normaliza parámetros de paginación de un query / body.
 * @param {object} params
 * @param {number} [params.page=1]
 * @param {number} [params.pageSize=20]
 * @param {string} [params.sortBy]
 * @param {'asc'|'desc'} [params.sortOrder='desc']
 * @returns {{ page: number, pageSize: number, offset: number, limit: number, sortBy: string|null, sortOrder: string }}
 */
export function parsePagination(params = {}) {
    const page = Math.max(1, parseInt(params.page, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(params.pageSize, 10) || 20));
    const offset = (page - 1) * pageSize;
    // Usar undefined en lugar de null para permitir valores por defecto en desestructuración
    const sortBy = params.sortBy || undefined;
    const sortOrder = params.sortOrder === 'asc' ? 'asc' : 'desc';

    return { page, pageSize, offset, limit: pageSize, sortBy, sortOrder };
}

/**
 * Construye la respuesta paginada estándar.
 * @template T
 * @param {T[]} data      — filas de la página actual.
 * @param {number} total   — total de registros sin paginar.
 * @param {number} page    — página actual.
 * @param {number} pageSize— tamaño de página.
 * @returns {{ success: true, data: T[], pagination: object }}
 */
export function buildPaginatedResponse(data, total, page, pageSize) {
    const totalPages = Math.ceil(total / pageSize) || 1;
    return {
        success: true,
        data,
        pagination: {
            page,
            pageSize,
            total,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1,
        },
    };
}

export default { parsePagination, buildPaginatedResponse };