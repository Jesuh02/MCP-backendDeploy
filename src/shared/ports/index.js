/**
 * Barrel — Exporta todas las interfaces de puertos.
 *
 * Uso:
 *   import { IStoragePort, IEmailPort } from '../shared/ports/index.js';
 */
export { IStoragePort } from './IStoragePort.js';
export { IFileUploader, IFileReader } from './IStoragePorts.segregated.js';
export { INotificationPort } from './INotificationPort.js';
export { IEmailPort } from './IEmailPort.js';
export { IPaymentGatewayPort } from './IPaymentGatewayPort.js';
export { ILLMPort } from './ILLMPort.js';
export { ICachePort } from './ICachePort.js';
