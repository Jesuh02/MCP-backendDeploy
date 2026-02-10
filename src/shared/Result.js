/**
 * Result<T> — Patrón monádico para flujo de éxito / error sin excepciones.
 *
 * Uso:
 *   const ok = Result.ok(data);          // { success: true, data }
 *   const fail = Result.fail('reason');   // { success: false, error }
 *
 *   if (ok.isOk())   console.log(ok.getValue());
 *   if (fail.isFail()) console.log(fail.getError());
 */
export class Result {
    /**
     * @param {boolean} success
     * @param {*} value  — dato de éxito o mensaje / objeto de error
     */
    constructor(success, value) {
        this.success = success;
        this._value = value;
        Object.freeze(this);
    }

    /** @returns {boolean} */
    isOk() {
        return this.success === true;
    }

    /** @returns {boolean} */
    isFail() {
        return this.success === false;
    }

    /**
     * Devuelve el valor de éxito.
     * @returns {*}
     * @throws {Error} si el resultado es un fallo.
     */
    getValue() {
        if (!this.success) {
            throw new Error('No se puede obtener el valor de un Result fallido. Use getError().');
        }
        return this._value;
    }

    /**
     * Devuelve el error.
     * @returns {*}
     * @throws {Error} si el resultado es exitoso.
     */
    getError() {
        if (this.success) {
            throw new Error('No se puede obtener el error de un Result exitoso. Use getValue().');
        }
        return this._value;
    }

    // ─── Factories ──────────────────────────────────────────

    /**
     * Crea un Result exitoso.
     * @template T
     * @param {T} value
     * @returns {Result}
     */
    static ok(value) {
        return new Result(true, value);
    }

    /**
     * Crea un Result fallido.
     * @param {string|Error|object} error
     * @returns {Result}
     */
    static fail(error) {
        return new Result(false, error);
    }
}

export default Result;