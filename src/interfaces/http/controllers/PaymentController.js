import { BaseController } from './BaseController.js';
import { initiatePaymentSchema } from '../../../domain/validators/CommonSchemas.js';
import { ValidationError } from '../../../shared/errors/index.js';

export class PaymentController extends BaseController {
    constructor({ paymentService }) {
        super();
        this.paymentService = paymentService;
    }

    initiate = async(req, res, next) => {
        try {
            // Prefer userId from JWT (secure). Fall back to body (legacy Android clients
            // that call /api/payment/initiate without Bearer token).
            // Security: creating a PENDING transaction is low-risk; actual course access
            // is only granted by the Wompi webhook after confirmed payment.
            const userId = req.user?.userId || req.body?.userId;
            if (!userId) {
                return next(new ValidationError('Se requiere userId (vía token o en el body)'));
            }

            const { error, value } = initiatePaymentSchema.validate(req.body);
            if (error) return next(ValidationError.fromJoi(error));

            const result = await this.paymentService.initiate({
                ...value,
                userId: parseInt(userId, 10),
            });

            if (result.isFail()) return next(result.getError());

            const data = result.getValue();
            // Map response to match Android PaymentInitiationResponse DTO
            // Android expects: { success, urlBankPayment, transactionId, message, courseName, amount }
            return res.json({
                success: true,
                data,
                // Flat fields for Android compatibility
                urlBankPayment: data.checkoutUrl,
                transactionId: data.reference,
                courseName: data.courseName || 'Curso',
                amount: data.amount || 0,
                message: `Pagar por ${data.courseName || 'Curso'}`,
            });
        } catch (err) {
            next(err);
        }
    };

    checkStatus = async(req, res, next) => {
        this.store(req, res, next, () => this.paymentService.checkStatus(req.params.transactionId));
    };

    webhook = async(req, res, next) => {
        try {
            console.log('📥 [PaymentController] Webhook hit');
            const result = await this.paymentService.handleWebhook(req.body);
            // Always return 200 to Wompi even on errors — they retry on non-200
            if (result.isFail()) {
                console.error('❌ Webhook processing failed:', result.getError());
                return res.status(200).json({ success: false, message: result.getError().message });
            }
            return res.status(200).json({ success: true, data: result.getValue() });
        } catch (err) {
            console.error('❌ Webhook exception:', err);
            return res.status(200).json({ success: false, message: err.message });
        }
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

