/**
 * LearningController — HTTP layer for AI-assisted learning artifacts.
 *
 * Routes:
 *   POST /api/learning/comic   { courseId, topicId, taskId }
 *   POST /api/learning/video   { courseId, topicId, taskId }
 */
import axios from 'axios';
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
      const response = { ...job };
      delete response._cdnVideoUrl;
      if (job.status === 'completed' && job._cdnVideoUrl) {
        const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
        response.videoUrl = `${appUrl}/api/learning/video/stream/${jobId}`;
      }
      res.json(response);
    } catch (err) {
      next(err);
    }
  };

  streamVideo = async (req, res, next) => {
    try {
      const { jobId } = req.params;
      if (!jobId) return res.status(400).json({ error: 'jobId is required' });
      const cdnUrl = this.learningService.getCdnVideoUrl(jobId);
      if (!cdnUrl) return res.status(404).json({ error: 'Video not found or expired' });

      const upstream = await axios.get(cdnUrl, {
        responseType: 'stream',
        timeout: 30_000,
        headers: { 'User-Agent': 'CourseV/1.0' },
      });

      res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp4');
      if (upstream.headers['content-length']) {
        res.setHeader('Content-Length', upstream.headers['content-length']);
      }
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      upstream.data.pipe(res);
    } catch (err) {
      next(err);
    }
  };
}

export default LearningController;
