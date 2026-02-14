import { Result } from '../../../shared/Result.js';

/**
 * Base Controller
 * Provides standardized methods for handling responses and errors.
 */
export class BaseController {
    /**
     * Standardizes the response format.
     * Uses Result pattern to determine success or failure.
     * 
     * @param {Request} req 
     * @param {Response} res 
     * @param {NextFunction} next 
     * @param {Promise<Result>|Result} actionResult 
     */
    async handleResult(res, next, actionResult) {
        try {
            // Handle promise if passed
            const result = await Promise.resolve(actionResult);

            if (result.isFail()) {
                const error = result.getError();
                // Pass to error handler middleware
                return next(error);
            }

            const value = result.getValue();
            // If value has a valid property (like from validation), use it, otherwise use value
            return res.json({
                success: true,
                data: value
            });

        } catch (err) {
            // Unexpected errors
            next(err);
        }
    }

    /**
     * Helper to execute a service call and handle result
     * @param {Function} serviceCallFn - Function that returns a Result
     */
    async store(req, res, next, serviceCallFn) {
        return this.handleResult(res, next, serviceCallFn());
    }

    // Alias for get/read operations
    async ok(res, result) {
        return res.json({ success: true, data: result });
    }
    async fail(next, error) {
        return next(error);
    }
}

