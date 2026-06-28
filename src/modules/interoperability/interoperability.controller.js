import { ValidationError } from '../../shared/errors/index.js';

function actorId(req) {
  return req.user?.userId || req.user?.id || null;
}

export class InteroperabilityController {
  constructor({ interoperabilityService }) {
    this.interoperabilityService = interoperabilityService;
  }

  getDashboard = async (_req, res, next) => {
    try {
      const data = await this.interoperabilityService.getDashboard();
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  };

  getEvents = async (req, res, next) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 80));
      const data = await this.interoperabilityService.getEvents({ limit });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  };

  recordEvent = async (req, res, next) => {
    try {
      if (!req.body?.eventType && !req.body?.event_type) {
        return next(new ValidationError('eventType is required'));
      }
      const data = await this.interoperabilityService.recordLearningEvent(req.body, actorId(req));
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  };

  runAction = async (req, res, next) => {
    try {
      const { standardCode, action } = req.params;
      const data = await this.interoperabilityService.runAction(
        standardCode,
        action,
        req.body || {},
        actorId(req),
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  };

  toggleChecklist = async (req, res, next) => {
    try {
      const { standardCode, itemKey } = req.params;
      const data = await this.interoperabilityService.toggleChecklist(
        standardCode,
        itemKey,
        Boolean(req.body?.done),
        actorId(req),
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  };
}

export default InteroperabilityController;
