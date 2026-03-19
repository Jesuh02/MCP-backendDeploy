/**
 * QuestionCacheService — In-memory TTL cache for pre-generated quiz questions.
 *
 * Stores pre-generated questions keyed by userId:courseId:topicId:taskId:difficulty
 * so they can be served instantly when the user taps "Start".
 *
 * Singleton pattern — one cache per process.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_SIZE = 500;

let instance = null;

export class QuestionCacheService {
    constructor() {
        this.cache = new Map();
        this.generatingKeys = new Set(); // Track in-flight generation to avoid duplicates
    }

    static getInstance() {
        if (!instance) instance = new QuestionCacheService();
        return instance;
    }

    _key(userId, courseId, topicId, taskId, difficulty) {
        return `${userId}:${courseId}:${topicId || 0}:${taskId || 0}:${(difficulty || 'HARD').toUpperCase()}`;
    }

    get(userId, courseId, topicId, taskId, difficulty) {
        const key = this._key(userId, courseId, topicId, taskId, difficulty);
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > DEFAULT_TTL_MS) {
            this.cache.delete(key);
            return null;
        }
        return entry.questions;
    }

    set(userId, courseId, topicId, taskId, difficulty, questions) {
        // Evict oldest entries if cache is full
        if (this.cache.size >= MAX_CACHE_SIZE) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        const key = this._key(userId, courseId, topicId, taskId, difficulty);
        this.cache.set(key, { questions, timestamp: Date.now() });
    }

    delete(userId, courseId, topicId, taskId, difficulty) {
        const key = this._key(userId, courseId, topicId, taskId, difficulty);
        this.cache.delete(key);
    }

    isGenerating(userId, courseId, topicId, taskId, difficulty) {
        return this.generatingKeys.has(this._key(userId, courseId, topicId, taskId, difficulty));
    }

    markGenerating(userId, courseId, topicId, taskId, difficulty) {
        this.generatingKeys.add(this._key(userId, courseId, topicId, taskId, difficulty));
    }
    clearGenerating(userId, courseId, topicId, taskId, difficulty) {
        this.generatingKeys.delete(this._key(userId, courseId, topicId, taskId, difficulty));
    }
}

export default QuestionCacheService;