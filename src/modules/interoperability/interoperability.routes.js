import { Router } from 'express';

export function interoperabilityRoutes({ interoperabilityController, requireRoles }) {
  const router = Router();
  const adminOnly = requireRoles(3, 4);

  router.get('/dashboard', adminOnly, interoperabilityController.getDashboard);
  router.get('/events', adminOnly, interoperabilityController.getEvents);
  router.post('/events', adminOnly, interoperabilityController.recordEvent);
  router.post('/actions/:standardCode/:action', adminOnly, interoperabilityController.runAction);
  router.post('/checklist/:standardCode/:itemKey', adminOnly, interoperabilityController.toggleChecklist);

  return router;
}

export default interoperabilityRoutes;
