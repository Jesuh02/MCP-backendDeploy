import { initiatePaymentSchema } from '../../../domain/validators/CommonSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';

export class PaymentController {
    constructor({ paymentService }) {
        this.paymentService = paymentService;
    }

    initiate = async(req, res, next) => {
        try {
            const { error, value } = initiatePaymentSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));
            const result = await this.paymentService.initiate({...value, userId: req.user.userId });
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    checkStatus = async(req, res, next) => {
        try {
            const result = await this.paymentService.checkStatus(req.params.transactionId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
    webhook = async(req, res, next) => {
        try {
            const result = await this.paymentService.handleWebhook(req.body);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getMyTransactions = async(req, res, next) => {
        try {
            const result = await this.paymentService.getUserTransactions(req.user.userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getBanks = async(req, res, next) => {
        try {
            const result = await this.paymentService.getBanks();
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    hasPurchased = async(req, res, next) => {
        try {
            const courseId = parseInt(req.params.courseId);
            const result = await this.paymentService.hasPurchasedCourse(req.user.userId, courseId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default PaymentController;