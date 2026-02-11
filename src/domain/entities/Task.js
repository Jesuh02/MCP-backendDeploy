/**
 * Task — Entidad de dominio para Tarea de un tema.
 *
 * Refleja exactamente las columnas de la tabla `tasks`:
 *   id, topic_id, title, description, due_date, created_at
 *
 * Principio: la entidad de dominio usa camelCase; la capa de
 * infraestructura se encarga del mapeo snake_case ↔ camelCase.
 */
export class Task {
    /**
     * @param {object} props
     * @param {number|null}  props.id
     * @param {string}       props.title
     * @param {string}       props.description
     * @param {number}       props.topicId
     * @param {string|null}  props.dueDate
     * @param {string|null}  props.createdAt
     */
    constructor({ id = null, title, description = '', topicId, dueDate = null, createdAt = null } = {}) {
        this.id = id;
        this.title = title;
        this.description = description;
        this.topicId = topicId;
        this.dueDate = dueDate;
        this.createdAt = createdAt;
    }

    /**
     * Construye una instancia de Task a partir de una fila de Supabase (snake_case).
     * @param {object} row — Fila cruda de la tabla `tasks`.
     * @returns {Task}
     */
    static fromSupabaseRow(row) {
        return new Task({
            id: row.id,
            title: row.title,
            description: row.description || '',
            topicId: row.topic_id ?? row.topicId,
            dueDate: row.due_date ?? row.dueDate ?? null,
            createdAt: row.created_at ?? row.createdAt ?? null,
        });
    }

    /**
     * Serializa la entidad a un objeto plano con ambas notaciones
     * (camelCase + snake_case) para compatibilidad con todos los clientes.
     * @returns {object}
     */
    toJSON() {
        return {
            id: this.id,
            title: this.title,
            description: this.description,
            topicId: this.topicId,
            topic_id: this.topicId,
            dueDate: this.dueDate,
            due_date: this.dueDate,
            createdAt: this.createdAt,
            created_at: this.createdAt,
        };
    }
}
export default Task;