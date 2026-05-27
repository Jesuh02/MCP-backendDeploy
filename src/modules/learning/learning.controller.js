/**
 * LearningController — HTTP layer for AI-assisted learning artifacts.
 *
 * Routes:
 *   POST /api/learning/comic   { courseId, topicId, taskId }
 *   POST /api/learning/video   { courseId, topicId, taskId }
 */
import { ValidationError } from '../../shared/errors/index.js';

const parseId = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export class LearningController {
  /** @param {{ learningService: import('./learning.service.js').LearningDomainService }} deps */
  constructor({ learningService }) {
    this.learningService = learningService;
  }

  generateComic = async (req, res, next) => {
    try {
      const userId = req.user?.userId || req.user?.id;
      const courseId = parseId(req.body.courseId ?? req.body.course_id);
      const topicId = parseId(req.body.topicId ?? req.body.topic_id);
      const taskId = parseId(req.body.taskId ?? req.body.task_id);

      if (!userId) return next(new ValidationError('Authentication required'));
      if (!courseId) return next(new ValidationError('courseId is required'));

      const data = await this.learningService.generateComic({ courseId, topicId, taskId, userId });
      res.json(data);
    } catch (err) {
      if (err?.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      next(err);
    }
  };

  generateVideo = async (req, res, next) => {
    try {
      const userId = req.user?.userId || req.user?.id;
      const courseId = parseId(req.body.courseId ?? req.body.course_id);
      const topicId = parseId(req.body.topicId ?? req.body.topic_id);
      const taskId = parseId(req.body.taskId ?? req.body.task_id);

      if (!userId) return next(new ValidationError('Authentication required'));
      if (!courseId) return next(new ValidationError('courseId is required'));

      const data = await this.learningService.generateVideo({ courseId, topicId, taskId, userId });
      res.json(data);
    } catch (err) {
      if (err?.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      next(err);
    }
  };

  getVideoStatus = async (req, res, next) => {
    try {
      const { jobId } = req.params;
      if (!jobId) return res.status(400).json({ error: 'jobId is required' });
      const job = this.learningService.getVideoStatus(jobId);
      if (!job) return res.status(404).json({ error: 'Job not found or expired' });
      res.json(job);
    } catch (err) {
      next(err);
    }
  };
}

export default LearningController;
