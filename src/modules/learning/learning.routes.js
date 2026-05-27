import { Router } from 'express';

export function learningRoutes({ learningController }) {
  const router = Router();
  router.post('/comic', learningController.generateComic);
  router.post('/video', learningController.generateVideo);
  return router;
}
export default learningRoutes;
