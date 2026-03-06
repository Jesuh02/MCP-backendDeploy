/**
 * QueryTimeout.js — Utility to wrap database queries with timeout protection
 *
 * Prevents indefinite hanging on Supabase queries.
 * Throws TimeoutError if query takes longer than specified duration.
 */

export class TimeoutError extends Error {
    constructor(ms) {
        super(`Query timeout after ${ms}ms`);
        this.name = 'TimeoutError';
        this.ms = ms;
    }
}

/**
 * Wraps a promise with a timeout.
 * @param {Promise} promise - The promise to wrap
 * @param {number} ms - Timeout in milliseconds (default: 10000)
 * @returns {Promise} The wrapped promise
 * @throws {TimeoutError} If timeout is exceeded
 */
export function withTimeout(promise, ms = 10000) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new TimeoutError(ms)), ms)
        ),
    ]);
}
/**
 * Wraps a Supabase query with timeout protection.
 * Usage: await withQueryTimeout(client.from('users').select())
 * @param {Promise} supabaseQuery - The Supabase query builder promise
 * @param {number} ms - Timeout in milliseconds (default: 15000 for DB queries)
 * @returns {Promise<{data, error}>} The query result
 */
export async function withQueryTimeout(supabaseQuery, ms = 15000) {
    try {
        return await withTimeout(supabaseQuery, ms);
    } catch (err) {
        if (err instanceof TimeoutError) {
            const timeoutError = {
                code: 'QUERY_TIMEOUT',
                message: `Database query timeout after ${ms}ms`,
                hint: 'Check network connectivity and Supabase availability'
            };
            return { data: null, error: timeoutError };
        }
        throw err;
    }
}
