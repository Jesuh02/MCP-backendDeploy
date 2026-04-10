import { Router } from 'express';

export function institucionRoutes({ institucionController, authMiddleware, requireRoles }) {
    const router = Router();

    // Public routes (no auth needed)
    router.get('/cross-tenant', institucionController.listAllTenants);
    router.get('/user-institutions/:username', institucionController.lookupUserAcrossTenants);
    router.get('/status/:id', institucionController.checkInstitutionStatus);
    router.post('/billing/webhook', institucionController.billingWebhook);

    router.get('/', institucionController.list);
    router.get('/search', institucionController.search);

    // Authenticated route: user checks own institution billing status
    // Must be BEFORE /:id to avoid Express matching 'my' as :id
    if (authMiddleware) {
        router.get('/my/billing-status', authMiddleware, institucionController.myInstitutionStatus);
    }

    // SuperAdmin routes (role 4) — require auth + role check
    // Must be BEFORE /:id to avoid route conflicts with /admin/all
    if (authMiddleware && requireRoles) {
        router.get('/admin/all', authMiddleware, requireRoles(4), institucionController.listAllAdmin);
    }

    router.get('/:id', institucionController.getById);
    router.post('/', institucionController.create);
    router.put('/:id', institucionController.update);
    router.delete('/:id', institucionController.delete);

    // SuperAdmin routes (role 4) — parametric routes
    if (authMiddleware && requireRoles) {
        router.put('/:id/payment-due', authMiddleware, requireRoles(4), institucionController.setPaymentDueDate);
        router.post('/:id/suspend', authMiddleware, requireRoles(4), institucionController.suspend);
        router.post('/:id/unsuspend', authMiddleware, requireRoles(4), institucionController.unsuspend);
        router.get('/:id/access', authMiddleware, requireRoles(3, 4), institucionController.checkAccess);
        router.post('/:id/billing/initiate', authMiddleware, requireRoles(3, 4), institucionController.initiateBillingPayment);
        router.get('/:id/billing/payments', authMiddleware, requireRoles(3, 4), institucionController.getBillingPayments);
    }

    return router;
}
export default institucionRoutes;
