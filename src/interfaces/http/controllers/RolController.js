/**
 * RolController — Roles, recursos, rol_recursos.
 */
export class RolController {
    constructor({ rolService }) {
        this.rolService = rolService;
    }

    listRoles = async(req, res, next) => {
        try {
            const result = await this.rolService.listRoles();
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getRolById = async(req, res, next) => {
        try {
            const result = await this.rolService.getRolById(parseInt(req.params.id));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getUserRoleIds = async(req, res, next) => {
        try {
            const userId = parseInt(req.params.userId);
            const result = await this.rolService.getUserRoleIds(userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    isUserDocente = async(req, res, next) => {
        try {
            const userId = parseInt(req.params.userId);
            const result = await this.rolService.isUserDocente(userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    promoteToDocente = async(req, res, next) => {
        try {
            const userId = parseInt(req.params.userId);
            const result = await this.rolService.promoteToDocente(userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    listRecursos = async(req, res, next) => {
        try {
            const result = await this.rolService.listRecursos();
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    getRecursosByRol = async(req, res, next) => {
        try {
            const result = await this.rolService.getRecursosByRol(parseInt(req.params.rolId));
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    listRolRecursos = async(req, res, next) => {
        try {
            const result = await this.rolService.listRolRecursos();
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    ensureCreatorRole = async(req, res, next) => {
        try {
            const userId = parseInt(req.params.userId);
            const result = await this.rolService.ensureCreatorRole(userId);
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };

    syncCreatorRoles = async(req, res, next) => {
        try {
            const result = await this.rolService.syncAllCreatorRoles();
            if (result.isFail()) return next(result.getError());
            res.json({ success: true, data: result.getValue() });
        } catch (err) { next(err); }
    };
}
export default RolController;