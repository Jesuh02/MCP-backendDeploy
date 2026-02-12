import { BaseController } from './BaseController.js';
import { initiatePaymentSchema } from '../../../domain/validators/CommonSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';

export class PaymentController extends BaseController {
    constructor({ paymentService }) {
        super();
        this.paymentService = paymentService;
    }

    initiate = async(req, res, next) => {
        const { error, value } = initiatePaymentSchema.validate(req.body);
        if (error) return next(ValidationError.fromJoi(error));
        this.store(req, res, next, () => this.paymentService.initiate({...value, userId: req.user.userId }));
    };

    checkStatus = async(req, res, next) => {
        this.store(req, res, next, () => this.paymentService.checkStatus(req.params.transactionId));
    };

    webhook = async(req, res, next) => {
        this.store(req, res, next, () => this.paymentService.handleWebhook(req.body));
    };

    getMyTransactions = async(req, res, next) => {
        this.store(req, res, next, () => this.paymentService.getUserTransactions(req.user.userId));
    };

    getBanks = async(req, res, next) => {
        this.store(req, res, next, () => this.paymentService.getBanks());
    };

    hasPurchased = async(req, res, next) => {
        const courseId = parseInt(req.params.courseId);
        this.store(req, res, next, () => this.paymentService.hasPurchasedCourse(req.user.userId, courseId));
    };
}
export default PaymentController;