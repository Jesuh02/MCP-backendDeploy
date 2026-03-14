export class CollaboratorController {
    constructor({ collaboratorService }) {
        this.collaboratorService = collaboratorService;
    }

    getByCourse = async (req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const result = await this.collaboratorService.getByCourse(courseId, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    add = async (req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const userId = parseInt(req.body.userId);
            const result = await this.collaboratorService.add(courseId, userId, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.status(201).json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    remove = async (req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const userId = parseInt(req.params.userId);
            const result = await this.collaboratorService.remove(courseId, userId, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    sync = async (req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const userIds = req.body.userIds || [];
            const result = await this.collaboratorService.sync(courseId, userIds, req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default CollaboratorController;
