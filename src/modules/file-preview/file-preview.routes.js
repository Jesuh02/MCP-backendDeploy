import { Router } from 'express';

export function filePreviewRoutes({ filePreviewController }) {
    const router = Router();

    router.post('/preview', filePreviewController.getPreview);

    return router;
}
export default filePreviewRoutes;
