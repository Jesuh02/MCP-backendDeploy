/**
 * services/index.js
 * Exportaciones centralizadas de todos los servicios
 */

export { UserService } from './UserService.js';
export { NotificationService } from './NotificationService.js';
export { R2StorageService } from './R2StorageService.js';

// Default exports for convenience
export default {
    UserService: () => import('./UserService.js').then(m => m.UserService),
    NotificationService: () => import('./NotificationService.js').then(m => m.NotificationService),
    R2StorageService: () => import('./R2StorageService.js').then(m => m.R2StorageService)
};
