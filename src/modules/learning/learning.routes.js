import { Router } from 'express';

export function learningRoutes({ learningController }) {
  const router = Router();
  router.post('/comic', learningController.generateComic);
  router.post('/video', learningController.generateVideo);
  router.get('/video/status/:jobId', learningController.getVideoStatus);
  return router;
}
export default learningRoutes;
