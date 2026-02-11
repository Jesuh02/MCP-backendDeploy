import { createTaskSchema, updateTaskSchema } from '../../../domain/validators/CommonSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';
import { parsePagination, buildPaginatedResponse } from '../../../shared/pagination.js';

export class TaskController {
    constructor({ taskService, notificationService, courseService, progressService, userService }) {
        this.taskService = taskService;
        this.notificationService = notificationService;
        this.courseService = courseService;
        this.progressService = progressService;
        this.userService = userService;
    }

    list = async(req, res, next) => {
        try {
            const pg = parsePagination(req.query);
            const result = await this.taskService.list(pg);
            if (result.isFail()) return next(result.getError());
            const { tasks, total } = result.getValue();
            res.json(buildPaginatedResponse(tasks, total, pg.page, pg.pageSize));
        } catch (err) { next(err); }
    };

    getById = async(req, res, next) => {
        try {
            const result = await this.taskService.getById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByTopic = async(req, res, next) => {
        try {
            const result = await this.taskService.getByTopic(parseInt(req.params.topicId));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getByCourse = async(req, res, next) => {
        try {
            const result = await this.taskService.getByCourse(parseInt(req.params.courseId));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    create = async(req, res, next) => {
        try {
            const { error, value } = createTaskSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.taskService.create(value);
            if (result.isFail()) return next(result.getError());

            const task = result.getValue();
            // Notify enrolled students
            this.notifyNewTask(task, req.user).catch(console.error);

            res.status(201).json({ success: true, data: task });
        } catch (err) { next(err); }
    };

    notifyNewTask = async(task, currentUser) => {
        try {
            if (!this.notificationService || !this.courseService || !this.progressService) return;

            // Get Course
            const courseResult = await this.courseService.getById(task.courseId);
            if (courseResult.isFail()) return;
            const course = courseResult.getValue();

            // Get Enrolled Students
            const progressResult = await this.progressService.getAllByCourse(task.courseId);
            if (progressResult.isFail()) return;
            const enrollments = progressResult.getValue();

            if (!enrollments || enrollments.length === 0) return;

            // Sender Info
            let senderUsername = currentUser ? currentUser.username : 'Instructor';
            let senderAvatarUrl = null;
            if (currentUser && currentUser.userId && this.userService) {
                const userResult = await this.userService.getById(currentUser.userId);
                if (userResult.isOk()) {
                    const u = userResult.getValue();
                    senderUsername = u.username || senderUsername;
                    senderAvatarUrl = u.avatar;
                }
            }

            // Send Notifications
            const promises = enrollments.map(e => {
                if (currentUser && e.userId === currentUser.userId) return Promise.resolve();
                return this.notificationService.sendNotification({
                    userId: e.userId,
                    title: `Nueva tarea: ${task.title}`,
                    message: `${senderUsername} ha publicado una nueva tarea en '${course.title}'`,
                    type: 'new_task',
                    relatedId: task.id,
                    senderUsername,
                    senderAvatarUrl,
                    thumbnailUrl: course.thumbnail_url || course.thumbnailUri || course.thumbnailUrl,
                    metadata: JSON.stringify({ taskId: task.id, courseId: course.id, type: 'new_task' })
                });
            });
            await Promise.all(promises);
        } catch (e) {
            console.error('Failed to notify new task', e);
        }
    };

    update = async(req, res, next) => {
        try {
            const { error, value } = updateTaskSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.taskService.update(parseInt(req.params.id), value);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    delete = async(req, res, next) => {
        try {
            const result = await this.taskService.delete(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default TaskController;