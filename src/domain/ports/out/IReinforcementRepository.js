/**
 * IReinforcementRepository — Puerto de salida para persistencia de historial de refuerzo.
 * @interface
 */
export class IReinforcementRepository {
    async getHistory(userId, courseId) { throw new Error('Not implemented'); }
    async saveHistory(userId, courseId, questions) { throw new Error('Not implemented'); }
    async clearHistory(userId, courseId) { throw new Error('Not implemented'); }
}
export default IReinforcementRepository;

