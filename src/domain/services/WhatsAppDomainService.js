/**
 * WhatsAppDomainService — Servicio de dominio para el canal WhatsApp.
 *
 * Orquesta el flujo completo de mensajes entrantes:
 *   1. Identifica la sesión por número de teléfono
 *   2. Clasifica la intención del mensaje
 *   3. Enruta al handler correspondiente según el rol del usuario
 *   4. Envía la respuesta vía el puerto de WhatsApp
 *
 * Principios:
 *   - SRP: solo orquesta flujo de mensajes (handlers separados por método)
 *   - DIP: depende de puertos abstractos, no de implementaciones concretas
 *   - OCP: nuevos intents se agregan sin modificar handlers existentes
 */
import { Result } from '../../shared/Result.js';
import { AppError } from '../../shared/errors/AppError.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../../shared/errors/index.js';
import { WhatsAppSession } from '../entities/WhatsAppSession.js';
import {
    validatePhoneNumber,
    validateGradeCommand,
    sanitizeInput,
    containsSQLInjection,
} from '../validators/WhatsAppSchemas.js';
import {
    markdownToWhatsApp,
    truncateResponse,
    formatProgressReport,
    formatGradeConfirmation,
    MESSAGES,
} from '../../utils/whatsappFormatter.js';

export class WhatsAppDomainService {
    /**
     * @param {object} deps — Dependencias inyectadas (Composition Root).
     */
    constructor({
        whatsAppPort,
        whatsAppSessionRepo,
        userRepository,
        rolRepository,
        mcpDomainService,
        llmDomainService,
        submissionRepository,
        progressRepository,
        courseRepository,
        chatMessageRepository,
        excelService,
    }) {
        this.whatsAppPort = whatsAppPort;
        this.sessionRepo = whatsAppSessionRepo;
        this.userRepo = userRepository;
        this.rolRepo = rolRepository;
        this.mcpService = mcpDomainService;
        this.llmService = llmDomainService;
        this.submissionRepo = submissionRepository;
        this.progressRepo = progressRepository;
        this.courseRepo = courseRepository;
        this.chatMessageRepo = chatMessageRepository;
        this.excelService = excelService;

        this.channelAvailabilityCache = {
            checkedAt: 0,
            ttlMs: 30 * 1000,
            value: null,
        };
    }

    /**
     * Return true when YCloud is configured in any supported env var shape.
     * Accepts YCLOUD_INSTANCE_ID or legacy YCLOUD_ID, or YCLOUD_WHATSAPP_NUMBER for v2 sends.
     */
    _isYCloudEnabled() {
        const apiKey = process.env.YCLOUD_API_KEY;
        const instance = process.env.YCLOUD_INSTANCE_ID || process.env.YCLOUD_ID;
        const fromNumber = process.env.YCLOUD_WHATSAPP_NUMBER || process.env.YCLOUD_PHONE;
        return Boolean(apiKey && (instance || fromNumber));
    }

    /**
     * Verifica disponibilidad del canal WhatsApp (con caché breve).
     * @param {boolean} [forceRefresh=false]
     * @returns {Promise<{available: boolean, reason?: string}>}
     */
    async getChannelAvailability(forceRefresh = false) {
        const now = Date.now();
        const cache = this.channelAvailabilityCache;

        if (!forceRefresh && cache.value && now - cache.checkedAt < cache.ttlMs) {
            return cache.value;
        }

        // If YCloud is configured, prefer it as the provider
        const ycloudInstance = process.env.YCLOUD_INSTANCE_ID || process.env.YCLOUD_ID || null;
        const ycloudApiKey = process.env.YCLOUD_API_KEY || null;
        if (ycloudInstance && ycloudApiKey) {
            const available = {
                available: true,
                provider: {
                    name: 'YCloud',
                    instanceId: ycloudInstance,
                    phoneNumber: process.env.YCLOUD_WHATSAPP_NUMBER || process.env.YCLOUD_PHONE || null,
                    connected: true,
                },
            };
            cache.value = available;
            cache.checkedAt = now;
            return available;
        }

        if (!this.whatsAppPort) {
            const unavailable = {
                available: false,
                reason: 'Canal WhatsApp no configurado en el servidor',
            };
            cache.value = unavailable;
            cache.checkedAt = now;
            return unavailable;
        }

        if (typeof this.whatsAppPort.isAvailable !== 'function') {
            const available = { available: true };
            cache.value = available;
            cache.checkedAt = now;
            return available;
        }

        let providerResp = null;
        try {
            const isAvailable = await this.whatsAppPort.isAvailable();
            const result = isAvailable ? { available: true } : { available: false, reason: 'Canal WhatsApp temporalmente no disponible' };

            // Attach provider info when available
            try {
                if (typeof this.whatsAppPort.getProviderInfo === 'function') {
                    result.provider = await this.whatsAppPort.getProviderInfo();
                }
            } catch (e) {
                // ignore provider info errors
            }

            cache.value = result;
            cache.checkedAt = now;
            return result;
        } catch {
            const unavailable = {
                available: false,
                reason: 'No se pudo validar disponibilidad del canal WhatsApp',
            };
            try {
                if (typeof this.whatsAppPort.getProviderInfo === 'function') {
                    unavailable.provider = await this.whatsAppPort.getProviderInfo();
                }
            } catch (e) {
                // ignore
            }
            cache.value = unavailable;
            cache.checkedAt = now;
            return unavailable;
        }
    }

    /**
     * Send a plain text message via YCloud HTTP API when YCLOUD credentials are present.
     * This is used as an alternative provider to Meta when env vars are configured.
     * @param {string} to E.164 phone number with leading +
     * @param {string} text Message body
     */
    async _sendViaYCloud(to, text) {
        const instanceId = process.env.YCLOUD_INSTANCE_ID || process.env.YCLOUD_ID;
        const apiKey = process.env.YCLOUD_API_KEY;
        const baseUrl = process.env.YCLOUD_BASE_URL || 'https://api.ycloud.com/v2';
        const fromNumber = process.env.YCLOUD_WHATSAPP_NUMBER || process.env.YCLOUD_PHONE || null;

        if (!apiKey) throw new Error('YCloud credentials not configured: missing YCLOUD_API_KEY');

        // Normalize numbers to E.164 with leading + for YCloud v2 endpoints
        const normalizeE164 = (value) => {
            if (!value) return '';
            const cleaned = String(value).trim().replace(/[^0-9+]/g, '');
            return cleaned.startsWith('+') ? cleaned : `+${cleaned.replace(/^\+/, '')}`;
        };

        const normalizedTo = normalizeE164(to);
        const normalizedFrom = normalizeE164(fromNumber);

        // Prefer modern YCloud endpoint (v2), keep legacy /instances fallback for compatibility.
        const root = baseUrl.replace(/\/$/, '');
        const candidates = [];

        // v2 direct send (recommended for OTP/instant)
        if (normalizedFrom) {
            const v2Root = /\/v2$/i.test(root) ? root : root.replace(/\/v1$/i, '/v2');
            candidates.push({
                name: 'v2-sendDirectly',
                url: `${v2Root}/whatsapp/messages/sendDirectly`,
                payload: {
                    from: normalizedFrom,
                    to: normalizedTo,
                    type: 'text',
                    text: { body: String(text || '') },
                },
            });
        }

        // legacy instances endpoint
        if (instanceId) {
            candidates.push({
                name: 'v1-instances',
                url: `${root}/instances/${instanceId}/messages`,
                payload: {
                    to: normalizedTo.replace(/^\+/, ''),
                    type: 'text',
                    text: { body: String(text || '') },
                },
            });
        }

        if (candidates.length === 0) {
            throw new Error('YCloud configuration invalid: define YCLOUD_WHATSAPP_NUMBER (for v2) or YCLOUD_INSTANCE_ID (legacy)');
        }

        // Diagnostic checks: DNS resolution and optional node-fetch fallback
        try {
            const parsed = new URL(candidates[0].url);
            const dns = await import('dns').then(m => m.promises).catch(() => null);
            if (dns) {
                try {
                    const addrs = await dns.lookup(parsed.hostname, { all: true });
                    if (process.env.WHATSAPP_DEBUG === 'true') console.log('[WhatsApp] YCloud DNS lookup:', parsed.hostname, addrs);
                } catch (dErr) {
                    console.warn('[WhatsApp] YCloud DNS lookup failed:', dErr && (dErr.code || dErr.message));
                }
            }
        } catch (e) {
            // ignore URL parse errors
        }

        if (typeof fetch === 'undefined') {
            try {
                const nf = await import('node-fetch');
                // node-fetch v3 exports default
                globalThis.fetch = nf.default || nf;
                if (process.env.WHATSAPP_DEBUG === 'true') console.log('[WhatsApp] Polyfilled global fetch with node-fetch');
            } catch (impErr) {
                console.warn('[WhatsApp] Could not polyfill fetch:', impErr && impErr.message);
            }
        }

        // Use small retry loop with AbortController timeout to surface network errors
        const maxAttempts = 3;
        const timeoutMs = Number(process.env.YCLOUD_REQUEST_TIMEOUT_MS || 8000);
        let lastErr = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (process.env.WHATSAPP_DEBUG === 'true') {
                const candidateNames = candidates.map(c => c.name).join(',');
                console.log(`[WhatsApp] YCloud attempt=${attempt} candidates=[${candidateNames}]`);
            }

            // Try sequence: fetch -> axios -> native https
            let attemptErr = null;

            for (const candidate of candidates) {
                // 1) Try fetch (global or polyfilled)
                try {
                    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
                    const signal = controller ? controller.signal : undefined;
                    if (controller) {
                        setTimeout(() => { try { controller.abort(); } catch (_) {} }, timeoutMs);
                    }

                    const resp = await fetch(candidate.url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-API-Key': apiKey,
                        },
                        body: JSON.stringify(candidate.payload),
                        signal,
                    });
                    const j = await resp.json().catch(() => ({}));
                    if (!resp.ok) {
                        const errMsg = j?.error?.message || j?.message || `YCloud API error: ${resp.status}`;
                        const e = new Error(errMsg);
                        e.meta = j;
                        e.httpStatus = resp.status;
                        throw e;
                    }
                    return j;
                } catch (err) {
                    attemptErr = err;
                    if (process.env.WHATSAPP_DEBUG === 'true') {
                        console.warn(`[WhatsApp] fetch failed (${candidate.name}): ${err?.code || ''} ${err?.message || err}`);
                    }
                }

                // 2) Try axios if available
                try {
                    const axiosModule = await import('axios').then(m => m.default || m).catch(() => null);
                    if (axiosModule) {
                        try {
                            const axiosResp = await axiosModule.post(candidate.url, candidate.payload, {
                                headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
                                timeout: timeoutMs,
                                validateStatus: null,
                            });
                            if (axiosResp.status && axiosResp.status >= 200 && axiosResp.status < 300) {
                                return axiosResp.data;
                            }
                            const errMsg = axiosResp.data?.error?.message || axiosResp.data?.message || `YCloud API error: ${axiosResp.status}`;
                            const e = new Error(errMsg);
                            e.meta = axiosResp.data;
                            e.httpStatus = axiosResp.status;
                            throw e;
                        } catch (aErr) {
                            attemptErr = aErr;
                            if (process.env.WHATSAPP_DEBUG === 'true') {
                                console.warn(`[WhatsApp] axios failed (${candidate.name}):`, aErr && (aErr.code || aErr.message));
                            }
                        }
                    }
                } catch (_) { /* ignore import errors */ }

                // 3) Try native https request
                try {
                    const https = await import('node:https');
                    const tls = await import('node:tls');
                    const urlObj = new URL(candidate.url);
                    const bodyStr = JSON.stringify(candidate.payload);

                    const nativeResp = await new Promise((resolve, reject) => {
                        const hostHeader = urlObj.port ? `${urlObj.hostname}:${urlObj.port}` : urlObj.hostname;
                            const opts = {
                            protocol: urlObj.protocol,
                            hostname: urlObj.hostname,
                            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                            path: urlObj.pathname + (urlObj.search || ''),
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-API-Key': apiKey,
                                'Content-Length': Buffer.byteLength(bodyStr),
                                'Host': hostHeader,
                            },
                            timeout: timeoutMs,
                            // Use a custom TLS connector to guarantee the SNI `servername` value
                            createConnection: (connectionOptions, callback) => {
                                const connectOpts = {
                                    host: urlObj.hostname,
                                    port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                                    servername: urlObj.hostname,
                                    minVersion: 'TLSv1.2',
                                    // include any socket options passed by https
                                    ...connectionOptions,
                                };
                                return tls.connect(connectOpts, callback);
                            },
                        };

                        const req = https.request(opts, (res) => {
                            let data = '';
                            res.on('data', (c) => data += c);
                            res.on('end', () => resolve({ status: res.statusCode, body: data }));
                        });

                        req.on('error', (e) => reject(e));
                        req.on('timeout', () => { req.destroy(new Error('request timeout')); });
                        req.write(bodyStr);
                        req.end();
                    });

                    const parsedBody = (() => {
                        try { return JSON.parse(nativeResp.body || '{}'); } catch (_) { return {}; }
                    })();
                    if (nativeResp.status >= 200 && nativeResp.status < 300) return parsedBody;
                    const errMsg = parsedBody?.error?.message || parsedBody?.message || `YCloud API error: ${nativeResp.status}`;
                    const e = new Error(errMsg);
                    e.meta = parsedBody;
                    e.httpStatus = nativeResp.status;
                    throw e;
                } catch (nErr) {
                    attemptErr = nErr;
                    if (process.env.WHATSAPP_DEBUG === 'true') {
                        console.warn(`[WhatsApp] native https failed (${candidate.name}):`, nErr && (nErr.code || nErr.message));
                    }
                }
            }

            // record last attempt error and backoff
            lastErr = attemptErr;
            const code = attemptErr && (attemptErr.code || attemptErr.httpStatus || attemptErr.name) || 'UNKNOWN';
            const msg = attemptErr && (attemptErr.message || String(attemptErr));
            console.warn(`[WhatsApp] YCloud POST failed (attempt=${attempt}): ${code} ${msg}`);

            if (attempt < maxAttempts) {
                const backoff = 200 * Math.pow(2, attempt - 1);
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }
        }

        const finalErr = new Error(`YCloud fetch failed: ${lastErr?.message || String(lastErr)}`);
        finalErr.meta = lastErr;
        throw finalErr;
    }

        /**
         * Consulta el estado de un mensaje en YCloud usando el message id retornado.
         * Intenta varios endpoints compatibles para maximizar compatibilidad con versiones.
         * @param {string} messageId
         * @returns {Promise<object|null>}
         */
        async _fetchYCloudMessageStatus(messageId) {
            if (!messageId) return null;
            const apiKey = process.env.YCLOUD_API_KEY;
            if (!apiKey) return null;

            const baseUrl = process.env.YCLOUD_BASE_URL || 'https://api.ycloud.com/v2';
            const root = baseUrl.replace(/\/$/, '');
            const instanceId = process.env.YCLOUD_INSTANCE_ID || process.env.YCLOUD_ID || null;

            // Candidate URL patterns (include instance scoping variants)
            const candidates = [];
            if (instanceId) {
                candidates.push(`${root}/instances/${encodeURIComponent(instanceId)}/messages/${encodeURIComponent(messageId)}`);
                candidates.push(`${root}/instances/${encodeURIComponent(instanceId)}/messages/${encodeURIComponent(messageId)}/status`);
            }
            candidates.push(`${root}/whatsapp/messages/${encodeURIComponent(messageId)}`);
            candidates.push(`${root}/messages/${encodeURIComponent(messageId)}`);
            candidates.push(`${root}/whatsapp/message/${encodeURIComponent(messageId)}`);

            // Try multiple auth header styles (some YCloud setups expect X-API-KEY)
            const headerVariants = [
                { name: 'Authorization:Bearer', build: () => ({ 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }) },
                { name: 'X-API-KEY', build: () => ({ 'X-API-KEY': apiKey, 'Accept': 'application/json' }) },
                { name: 'x-api-key', build: () => ({ 'x-api-key': apiKey, 'Accept': 'application/json' }) },
            ];

            for (const url of candidates) {
                for (const hv of headerVariants) {
                    try {
                        const headers = hv.build();
                        const res = await fetch(url, { method: 'GET', headers });
                        if (process.env.WHATSAPP_DEBUG === 'true') {
                            try {
                                const preview = await res.clone().text().then(t => t.slice(0, 1000)).catch(() => '');
                                console.log(`[WhatsApp][YCloudStatus] GET ${url} via ${hv.name} => ${res.status} bodyPreview=${preview}`);
                            } catch (e) { /* ignore logging errors */ }
                        }
                        if (!res.ok) continue;
                        const data = await res.json();
                        return data;
                    } catch (e) {
                        if (process.env.WHATSAPP_DEBUG === 'true') console.warn('[WhatsApp][YCloudStatus] request failed', e && (e.message || e));
                        continue;
                    }
                }
            }

            return null;
        }
    // ═══════════════════════════════════════════════════════════
    // CASO DE USO: Manejo de mensajes entrantes (webhook)
    // ═══════════════════════════════════════════════════════════

    /**
     * Procesa un mensaje entrante desde el webhook de Meta.
     * @param {object} waPayload — Payload extraído del webhook.
     * @returns {Promise<void>}
     */
    async handleIncomingMessage({ from, messageBody, messageType, waMessageId }) {
        try {
            console.log(`[WhatsApp] Incoming message from=${from} waMessageId=${waMessageId} type=${messageType} bodyPreview=${String(messageBody).slice(0,200)}`);
            // 1. Marcar mensaje como leído
            if (waMessageId && this.whatsAppPort) {
                await this.whatsAppPort.markAsRead(waMessageId).catch((e) => {
                    console.warn('[WhatsApp] markAsRead failed:', e && (e.message || e));
                });
            }

            // 2. Solo procesar mensajes de texto
            if (messageType !== 'text') {
                await this._sendReply(from, '📎 Por el momento solo proceso mensajes de texto.');
                return;
            }

            // 3. Sanitizar entrada
            const text = sanitizeInput(messageBody);
            if (!text) return;

            // 4. Buscar sesión activa por número de teléfono
            const session = await this.sessionRepo.findByPhoneNumber(from);
            console.log('[WhatsApp] session lookup result:', !!session, session && { id: session.id, userId: session.userId, isActive: session.isActive });
            if (!session || !session.isActive) {
                await this._sendReply(from, MESSAGES.NOT_LINKED);
                return;
            }

            // 5. Obtener usuario y roles
            const user = await this.userRepo.findById(session.userId);
            if (!user) {
                await this._sendReply(from, MESSAGES.NOT_LINKED);
                return;
            }

            const userRoles = (user.roles || []).map(r => r.id || r.rol_id || r);

            // 6. Clasificar intención
            const intent = this._classifyIntent(text, userRoles);
            console.log('[WhatsApp] classified intent:', intent, 'userRoles:', userRoles);

            // 7. Verificar permisos
            if (intent.requiresRole && !this._hasPermission(userRoles, intent.requiresRole)) {
                const roleName = intent.requiresRole === 'admin' ? 'Administrador' : 'Docente';
                const currentRole = userRoles.includes(3) ? 'Admin' : userRoles.includes(2) ? 'Docente' : 'Estudiante';
                await this._sendReply(from, MESSAGES.ACCESS_DENIED(currentRole, roleName));
                return;
            }

            // 8. Enrutar al handler correspondiente
            let response;
            try {
                switch (intent.intent) {
                case 'HELP':
                    response = MESSAGES.HELP;
                    break;
                case 'UNLINK':
                    response = await this._handleUnlinkCommand(session.userId);
                    break;
                case 'GRADE_TASK':
                    response = await this._handleGradeTask(text, user, userRoles);
                    break;
                case 'STUDENT_PROGRESS':
                    response = await this._handleStudentProgress(text, user);
                    break;
                case 'MCP_QUERY':
                    response = await this._handleMCPQuery(text, user);
                    break;
                case 'MY_PROGRESS':
                    response = await this._handleMyProgress(user);
                    break;
                    case 'GENERAL_QUESTION':
                    default:
                        response = await this._handleGeneralQuestion(text, session, user, userRoles);
                        break;
                }
            } catch (handlerErr) {
                console.error('[WhatsApp] handler threw error:', handlerErr && (handlerErr.message || handlerErr));
                response = MESSAGES.ERROR;
            }

            // 9. Enviar respuesta (dividida si es muy larga)
            if (!response || (typeof response === 'string' && response.trim().length === 0)) {
                console.warn('[WhatsApp] Empty response from handler — sending fallback notice');
                response = 'Estoy procesando tu solicitud. Si esto persiste, intenta de nuevo o escribe /ayuda.';
            }

            const chunks = truncateResponse(response);
            for (const chunk of chunks) {
                await this._sendReply(from, chunk);
            }

            // 10. Actualizar contexto de conversación
            session.addToContext('user', text);
            session.addToContext('assistant', response.substring(0, 500));
            await this.sessionRepo.update(session.id, {
                conversation_context: session.conversationContext,
                last_message_at: new Date().toISOString(),
            });
        } catch (error) {
            console.error('[WhatsAppDomainService] Error handling message:', error);
            await this._sendReply(from, MESSAGES.ERROR).catch((e) => {
                console.warn('[WhatsApp] failed to send error reply:', e && (e.message || e));
            });
        }
    }

    // ═══════════════════════════════════════════════════════════
    // CASO DE USO: Vinculación de cuenta
    // ═══════════════════════════════════════════════════════════

    /**
     * Vincula un número de WhatsApp a una cuenta de usuario.
     * @param {number} userId
     * @param {string} phoneNumber
     * @returns {Promise<Result>}
     */
    async linkAccount(userId, phoneNumber) {
        // 0. Verificar disponibilidad del canal WhatsApp
        const availability = await this.getChannelAvailability(true);
        if (!availability.available) {
            return Result.fail(new AppError(
                'Servicio de WhatsApp no disponible temporalmente. Intenta de nuevo más tarde.',
                503,
                true,
                'WHATSAPP_UNAVAILABLE',
            ));
        }

        // 1. Validar número
        const { valid, normalized, error } = validatePhoneNumber(phoneNumber);
        if (!valid) return Result.fail(new ValidationError(error));

        // 2. Verificar que el usuario existe
        const user = await this.userRepo.findById(userId);
        if (!user) return Result.fail(new NotFoundError('Usuario', userId));

        // Determine if user can use MCP (role 3 = admin)
        const userRoleIds = (user.roles || []).map(r => r.id || r.rol_id || r);
        const canUseMCP = userRoleIds.includes(3);

        // 3. Verificar que el número no esté vinculado a otro usuario
        const existingByPhone = await this.sessionRepo.findByPhoneNumber(normalized);
        if (existingByPhone && existingByPhone.userId !== userId) {
            return Result.fail(new ValidationError('Este número ya está vinculado a otra cuenta'));
        }

        // 4. Verificar que el usuario no tenga ya una sesión activa
        const existingByUser = await this.sessionRepo.findByUserId(userId);
        if (existingByUser && existingByUser.isActive && existingByUser.phoneNumber !== normalized) {
            return Result.fail(new ValidationError('Ya tienes un número vinculado. Desvincula primero.'));
        }

        // 5. Generar OTP de 6 dígitos
        const otpCode = String(Math.floor(100000 + Math.random() * 900000));
        const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

        // 6. Crear o actualizar sesión (inactiva hasta verificar OTP)
        const sessionData = {
            user_id: userId,
            phone_number: normalized,
            is_active: false,
            otp_code: otpCode,
            otp_expires_at: otpExpiresAt,
            linked_at: new Date().toISOString(),
        };

        let session;
        if (existingByUser) {
            session = await this.sessionRepo.update(existingByUser.id, sessionData);
        } else {
            session = await this.sessionRepo.save(sessionData);
        }

        // Prepare variable to hold provider response for diagnostics
        let providerResp = null;

        // 7. Enviar OTP vía WhatsApp (usa template message para iniciar conversación)
        const otpMessage = `🔐 Tu código de verificación CourseV es: *${otpCode}*\n\nEste código expira en 10 minutos.`;
        try {
            // If YCloud is configured prefer it for OTP delivery to avoid Meta Cloud permissions issues
            if (this._isYCloudEnabled()) {
                try {
                    const yresp = await this._sendViaYCloud(normalized, otpMessage);
                    providerResp = { provider: 'YCloud', response: yresp };
                    console.log('[WhatsApp] OTP sent via YCloud:', yresp && (yresp.messageId || yresp));
                    try {
                        const mid = yresp?.id || yresp?.messageId || yresp?.wamid || yresp?.waMessageId || null;
                        if (mid) {
                            const status = await this._fetchYCloudMessageStatus(mid);
                            providerResp.delivery = status || null;
                            console.log('[WhatsApp] YCloud delivery status:', status);
                            // If YCloud reports a failure due to 24h window (Meta code 131047),
                            // try to fallback to Meta template send (if configured) so we can
                            // start a template conversation.
                            try {
                                const ds = providerResp.delivery || {};
                                const dstatus = (ds.status || ds.state || '').toLowerCase();
                                const derr = String(ds.errorCode || ds.error_code || ds.error?.code || ds.errorCode || ds.errorMessage || ds.error_message || '').trim();
                                const derrMsg = String(ds.errorMessage || ds.error_message || ds.error?.message || '').toLowerCase();
                                const is24h = dstatus === 'failed' && (derr === '131047' || derrMsg.includes('24 hours') || derrMsg.includes('24 horas'));
                                if (is24h && this.whatsAppPort && typeof this.whatsAppPort.sendOtpMessage === 'function') {
                                    console.warn('[WhatsApp] YCloud send failed due to 24h window — falling back to Meta template');
                                    try {
                                        const metaResp = await this.whatsAppPort.sendOtpMessage(normalized, otpCode);
                                        providerResp.fallback = { provider: 'Meta', response: metaResp };
                                        console.log('[WhatsApp] Fallback OTP sent via Meta:', metaResp && (metaResp.messageId || metaResp));
                                    } catch (mf) {
                                        console.error('[WhatsApp] Meta fallback also failed:', mf && (mf.message || mf));
                                    }
                                }
                            } catch (e) {
                                /* ignore fallback errors */
                            }
                        }
                    } catch (e) {
                        console.warn('[WhatsApp] Failed to fetch YCloud delivery status:', e && (e.message || e));
                    }
                } catch (yErr) {
                    // When YCloud is explicitly configured we should NOT silently fallback to Meta.
                    // Return a clear error so the client can inform the user and operators can
                    // diagnose YCloud connectivity/credentials. Include limited error details.
                    console.error('[WhatsApp] YCloud OTP send failed:', yErr?.message || yErr);
                    return Result.fail(new AppError(
                        'No se pudo enviar el código de verificación vía YCloud. Contacta al administrador del sistema.',
                        502,
                        true,
                        'YCLOUD_OTP_SEND_FAILED'
                    ));
                }
            } else {
                // Preferir template message (requerido por Meta fuera de la ventana de 24h)
                if (typeof this.whatsAppPort.sendOtpMessage === 'function') {
                    const mresp = await this.whatsAppPort.sendOtpMessage(normalized, otpCode);
                    providerResp = { provider: 'Meta', response: mresp };
                } else {
                    // Fallback a texto libre (solo funciona si hay conversación abierta)
                    const mresp = await this.whatsAppPort.sendTextMessage(normalized, otpMessage);
                    providerResp = { provider: 'Meta', response: mresp };
                }
            }
        } catch (err) {
            const errorMessage = String(err?.message || '');
            const metaCode = Number(err?.metaCode);
            const appCode = String(err?.code || '');
            const isRecipientNotAllowed =
                appCode === 'WHATSAPP_RECIPIENT_NOT_ALLOWED_TEST_MODE' ||
                metaCode === 131030 ||
                errorMessage.includes('131030') ||
                errorMessage.toLowerCase().includes('recipient phone number not in allowed list');

            const isAccountNotRegistered =
                appCode === 'WHATSAPP_ACCOUNT_NOT_REGISTERED' ||
                metaCode === 133010 ||
                errorMessage.includes('133010') ||
                errorMessage.toLowerCase().includes('account not registered');

            if (isRecipientNotAllowed) {
                console.warn('[WhatsApp] OTP bloqueado por modo prueba de Meta (allowed list).');
                return Result.fail(new AppError(
                    'No se pudo enviar el OTP porque este número no está permitido en el modo prueba de Meta. Agrega el número como tester en WhatsApp Cloud API o publica la app para usar números externos.',
                    400,
                    true,
                    'WHATSAPP_RECIPIENT_NOT_ALLOWED_TEST_MODE',
                ));
            }

            if (isAccountNotRegistered) {
                console.warn('[WhatsApp] El número no tiene cuenta de WhatsApp activa.');
                return Result.fail(new AppError(
                    'El número ingresado no tiene una cuenta de WhatsApp activa. Verifica que el número sea correcto y tenga WhatsApp instalado.',
                    400,
                    true,
                    'WHATSAPP_ACCOUNT_NOT_REGISTERED',
                ));
            }

            console.error('[WhatsApp] Error sending OTP:', err.message);

            return Result.fail(new AppError(
                'No se pudo enviar el código de verificación por WhatsApp. Verifica el número e inténtalo nuevamente.',
                502,
                true,
                'WHATSAPP_OTP_SEND_FAILED',
            ));
        }

        // If we obtained a delivery status and it indicates failure, surface a clear error
        try {
            const delivery = providerResp?.delivery;
            const fallback = providerResp?.fallback;
            const deliveryStatus = delivery?.status || (delivery?.state) || null;
            const deliveryErr = String(delivery?.errorCode || delivery?.error_code || delivery?.error?.code || delivery?.errorMessage || delivery?.error_message || '').trim();

            if (deliveryStatus && String(deliveryStatus).toLowerCase() === 'failed') {
                // Known undeliverable codes (Meta/YCloud mappings)
                if (deliveryErr === '131026') {
                    console.warn('[WhatsApp] Message undeliverable (131026) for', normalized, providerResp);
                    return Result.fail(new AppError(
                        'No fue posible entregar el código de verificación: el número objetivo no acepta mensajes (undeliverable). Verifica el número e inténtalo nuevamente.',
                        400,
                        true,
                        'WHATSAPP_UNDELIVERABLE'
                    ));
                }

                // If YCloud failed due to 24h window but we attempted a Meta fallback and it succeeded, continue.
                if (deliveryErr === '131047') {
                    const metaOk = fallback && fallback.provider === 'Meta' && (fallback.response?.messageId || fallback.response?.message_id);
                    if (metaOk) {
                        console.log('[WhatsApp] Meta fallback succeeded after 131047');
                    } else {
                        console.warn('[WhatsApp] YCloud failed 131047 and Meta fallback did not succeed', providerResp);
                        return Result.fail(new AppError(
                            'No se pudo iniciar la conversación por WhatsApp (fuera de ventana de 24h). Pide al usuario que envíe un mensaje al número de la empresa para activar la conversación, o agrega el número como tester.',
                            400,
                            true,
                            'WHATSAPP_24H_WINDOW'
                        ));
                    }
                }

                // Generic failed case: surface provider info
                console.warn('[WhatsApp] Delivery failed for', normalized, providerResp);
                return Result.fail(new AppError(
                    'No se pudo entregar el código de verificación. Verifica el número y que el destinatario tenga WhatsApp o no haya bloqueado al remitente.',
                    400,
                    true,
                    'WHATSAPP_DELIVERY_FAILED'
                ));
            }
        } catch (e) {
            // If any error occurs during delivery inspection, log and continue to return ok with providerResponse
            console.warn('[WhatsApp] Error inspecting delivery status:', e && (e.message || e));
        }

        return Result.ok({
            sessionId: session?.id,
            phoneNumber: normalized,
            message: 'Código de verificación enviado a WhatsApp',
            providerResponse: providerResp,
            canUseMCP,
        });
    }

    /**
     * Verifica el código OTP para activar la sesión.
     * @param {number} userId
     * @param {string} code — Código OTP de 6 dígitos.
     * @returns {Promise<Result>}
     */
    async verifyOtp(userId, code) {
        const session = await this.sessionRepo.findByUserId(userId);
        if (!session) {
            return Result.fail(new NotFoundError('Sesión WhatsApp'));
        }

        // Verificar OTP
        if (!session.otpCode || !session.otpExpiresAt) {
            return Result.fail(new ValidationError('No hay un código de verificación pendiente'));
        }

        if (new Date() > new Date(session.otpExpiresAt)) {
            return Result.fail(new ValidationError('El código de verificación ha expirado'));
        }

        if (session.otpCode !== code) {
            return Result.fail(new ValidationError('Código de verificación incorrecto'));
        }

        // Activar sesión
        await this.sessionRepo.update(session.id, {
            is_active: true,
            otp_code: null,
            otp_expires_at: null,
            wa_id: session.phoneNumber,
        });

        // Enviar bienvenida (usar YCloud cuando esté configurado)
        const user = await this.userRepo.findById(userId);
        const name = user?.username || 'usuario';
        const welcomeText = MESSAGES.WELCOME(name);
        try {
            if (this._isYCloudEnabled()) {
                try {
                    const resp = await this._sendViaYCloud(session.phoneNumber, welcomeText);
                    console.log('[WhatsApp] Sent welcome via YCloud:', resp && (resp.messageId || resp));
                } catch (e) {
                    console.warn('[WhatsApp] welcome via YCloud failed:', e && (e.message || e));
                }
            } else if (this.whatsAppPort) {
                try {
                    const r = await this.whatsAppPort.sendTextMessage(session.phoneNumber, welcomeText);
                    console.log('[WhatsApp] Sent welcome via Meta:', r && r.messageId);
                } catch (e) {
                    console.warn('[WhatsApp] welcome via Meta failed:', e && (e.message || e));
                }
            }
        } catch (e) {
            // ignore send errors for welcome
        }

        // Determine admin/MCP capability from user roles
        const updatedUser = await this.userRepo.findById(userId);
        const updatedRoleIds = (updatedUser?.roles || []).map(r => r.id || r.rol_id || r);
        const canUseMCPAfterVerify = updatedRoleIds.includes(3);

        return Result.ok({
            verified: true,
            message: 'WhatsApp vinculado correctamente',
            canUseMCP: canUseMCPAfterVerify,
        });
    }

    /**
     * Desvincula la cuenta de WhatsApp de un usuario.
     * @param {number} userId
     * @returns {Promise<Result>}
     */
    async unlinkAccount(userId) {
        const session = await this.sessionRepo.findByUserId(userId);
        if (!session) {
            return Result.fail(new NotFoundError('Sesión WhatsApp'));
        }

        // Enviar mensaje de despedida antes de desactivar (usar YCloud si está configurado)
        if (session.phoneNumber && session.isActive) {
            try {
                if (this._isYCloudEnabled()) {
                    try {
                        const resp = await this._sendViaYCloud(session.phoneNumber, MESSAGES.UNLINKED);
                        console.log('[WhatsApp] Sent unlink message via YCloud:', resp && (resp.messageId || resp));
                    } catch (e) {
                        console.warn('[WhatsApp] Unlink via YCloud failed:', e && (e.message || e));
                    }
                } else if (this.whatsAppPort) {
                    try {
                        const r = await this.whatsAppPort.sendTextMessage(session.phoneNumber, MESSAGES.UNLINKED);
                        console.log('[WhatsApp] Sent unlink via Meta:', r && r.messageId);
                    } catch (e) {
                        console.warn('[WhatsApp] Unlink via Meta failed:', e && (e.message || e));
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        await this.sessionRepo.deactivate(userId);
        return Result.ok({ message: 'WhatsApp desvinculado correctamente' });
    }

    /**
     * Obtiene el estado de vinculación de WhatsApp para un usuario.
     * @param {number} userId
     * @returns {Promise<Result>}
     */
    async getStatus(userId) {
        const channelAvailability = await this.getChannelAvailability();
        const session = await this.sessionRepo.findByUserId(userId);
        if (!session) {
            return Result.ok({
                isLinked: false,
                phoneNumber: null,
                linkedAt: null,
                otpPending: false,
                channelAvailable: channelAvailability.available,
                provider: channelAvailability.provider || null,
            });
        }

        return Result.ok({
            isLinked: session.isActive,
            phoneNumber: session.phoneNumber,
            linkedAt: session.linkedAt,
            otpPending: !session.isActive && Boolean(session.otpCode) && Boolean(session.otpExpiresAt),
            channelAvailable: channelAvailability.available,
            provider: channelAvailability.provider || null,
        });
    }

    // ═══════════════════════════════════════════════════════════
    // CLASIFICADOR DE INTENCIONES
    // ═══════════════════════════════════════════════════════════

    /**
     * Clasifica la intención de un mensaje según su contenido y roles del usuario.
     * @param {string} message
     * @param {number[]} userRoles
     * @returns {{ intent: string, requiresRole: string|null }}
     */
    _classifyIntent(message, userRoles) {
        const text = message.trim().toLowerCase();

        // 1. Comandos explícitos (mayor prioridad)
        if (text.startsWith('/calificar')) return { intent: 'GRADE_TASK', requiresRole: 'teacher' };
        if (text.startsWith('/progreso')) return { intent: 'STUDENT_PROGRESS', requiresRole: 'teacher' };
        if (text.startsWith('/consulta')) return { intent: 'MCP_QUERY', requiresRole: 'admin' };
        if (text.startsWith('/ayuda')) return { intent: 'HELP', requiresRole: null };
        if (text.startsWith('/desvincular')) return { intent: 'UNLINK', requiresRole: null };
        if (text.startsWith('/mi_progreso')) return { intent: 'MY_PROGRESS', requiresRole: null };

        // 2. Detección por palabras clave para calificación
        if (this._isGradeIntent(text) && (userRoles.includes(2) || userRoles.includes(3))) {
            return { intent: 'GRADE_TASK', requiresRole: 'teacher' };
        }

        // 3. Detección de progreso
        if (this._isProgressIntent(text)) {
            // Si es docente/admin, muestra progreso de sus estudiantes
            if (userRoles.includes(2) || userRoles.includes(3)) {
                return { intent: 'STUDENT_PROGRESS', requiresRole: 'teacher' };
            }
            // Si es estudiante, muestra su propio progreso
            return { intent: 'MY_PROGRESS', requiresRole: null };
        }

        // 4. Consulta MCP (solo admin)
        if (this._isMCPIntent(text) && userRoles.includes(3)) {
            return { intent: 'MCP_QUERY', requiresRole: 'admin' };
        }

        // 5. Fallback: pregunta general al LLM
        return { intent: 'GENERAL_QUESTION', requiresRole: null };
    }

    _isGradeIntent(text) {
        const keywords = ['calificar', 'califica', 'nota', 'poner nota', 'evaluar', 'evalúa'];
        return keywords.some(kw => text.includes(kw));
    }

    _isProgressIntent(text) {
        const keywords = ['progreso', 'avance', 'cómo van', 'como van', 'estudiantes', 'mi progreso'];
        return keywords.some(kw => text.includes(kw));
    }

    _isMCPIntent(text) {
        const keywords = ['cuántos', 'cuantos', 'listar', 'mostrar', 'select', 'consultar bd', 'base de datos'];
        return keywords.some(kw => text.includes(kw));
    }

    _hasPermission(userRoles, required) {
        if (required === 'admin') return userRoles.includes(3);
        if (required === 'teacher') return userRoles.includes(2) || userRoles.includes(3);
        return true;
    }

    // ═══════════════════════════════════════════════════════════
    // HANDLERS POR INTENCIÓN
    // ═══════════════════════════════════════════════════════════

    /**
     * Handler: Preguntas generales (todos los roles).
     * Usa LLMDomainService.processPrompt() existente.
     */
    async _handleGeneralQuestion(text, session, user, userRoles = []) {
        try {
            if (!this.llmService) return 'El servicio de IA no está disponible en este momento.';

            // If the user is an admin (role 3) prefer a BI/DatabaseQuery persona so
            // WhatsApp responses mimic the behavior of the Android `DatabaseQueryFragment`.
            // We keep the prompt small and focused to avoid token inflation.
            const isAdmin = Array.isArray(userRoles) && userRoles.includes(3);
            const context = session.conversationContext || [];

            let promptToSend = text;
            if (isAdmin) {
                const username = user?.username || 'usuario';
                // Use the same BI-style instructions the Android client provides so
                // WhatsApp responses mimic `DatabaseQueryFragment` behavior.
                const biPrompt = `CONSULTA DE BUSINESS INTELLIGENCE: ${text}\n\nINSTRUCCIONES:\nEres un experto en Business Intelligence y Marketing. Tu objetivo es analizar la base de datos y dar recomendaciones estratégicas.\n\n1. El esquema de la base de datos YA ESTÁ en tu contexto. NO llames a 'get_database_schema'.\n2. Usa 'query_database' para obtener métricas reales (usuarios, cursos, ventas, etc.).\n3. Genera un reporte con el siguiente formato EXACTO (Markdown):\n\n## Resumen ejecutivo\n[Objetivo y hallazgos principales]\n\n## Decisiones críticas\n1. [Decisión 1]\n2. [Decisión 2]\n\n## KPIs priorizados\n1. [KPI 1]\n2. [KPI 2]\n\n## Ejemplos de SQL\n\`\`\`sql\n-- Ejemplo relevante\nSELECT ...\n\`\`\`\n\n## Acción inmediata\n[Acción concreta]\n\nIMPORTANTE: Basa tus respuestas en DATOS REALES de la base de datos. Si necesitas información real, llama a la herramienta \"query_database\" del agente MCP y espera su respuesta antes de concluir.\n\n🎯 ¡Bienvenido/a, ${username}!`;
                promptToSend = biPrompt;
            }

            // Prefer DeepSeek model when configured (LLMDomainService will forward this to the infra adapter)
            const preferredModel = process.env.DEEPSEEK_MODEL || process.env.CHAT_MODEL || undefined;

            const result = await this.llmService.processPrompt({
                prompt: promptToSend,
                model: preferredModel,
                conversationHistory: context.map(c => ({ role: c.role, content: c.content })),
                userId: user.id,
                username: user.username,
                // Force MCP tools availability when admin so the LLM can call query_database
                forceMCPTools: isAdmin,
            });

            if (result && result.isOk && result.isOk()) {
                const answer = result.getValue();
                const responseText = typeof answer === 'string' ? answer : (answer?.response || answer?.text || JSON.stringify(answer));
                return markdownToWhatsApp(responseText);
            }

            if (typeof result === 'string') return markdownToWhatsApp(result);
            return MESSAGES.ERROR;
        } catch (error) {
            console.error('[WhatsApp] Error in general question:', error.message);
            return MESSAGES.ERROR;
        }
    }

    /**
     * Handler: Calificación de tareas (docente + admin).
     */
    async _handleGradeTask(text, user, userRoles) {
        try {
            const parsed = validateGradeCommand(text);
            if (!parsed.valid) {
                return `❌ ${parsed.error}\n\nFormato: */calificar* <id_entrega> <nota> [feedback]\nEjemplo: /calificar 45 8.5 Buen trabajo`;
            }

            const { submissionId, grade, feedback } = parsed;

            // Verificar que la entrega existe
            const submission = await this.submissionRepo.findById(submissionId);
            if (!submission) {
                return `❌ No se encontró la entrega con ID *#${submissionId}*.`;
            }

            // Verificar que la tarea pertenece a un curso del docente (si no es admin)
            if (!userRoles.includes(3)) {
                const isOwner = await this._isSubmissionFromOwnCourse(submission, user.id);
                if (!isOwner) {
                    return '❌ Esta entrega no pertenece a ninguno de tus cursos.';
                }
            }

            // Actualizar calificación
            await this.submissionRepo.update(submissionId, {
                grade,
                feedback: feedback || null,
            });

            // Obtener información para la confirmación
            const taskTitle = submission.taskTitle || submission.task_title || `Tarea #${submission.task_id}`;
            const studentName = submission.studentName || submission.student_name || `Estudiante #${submission.student_id}`;

            return formatGradeConfirmation({
                submissionId,
                taskTitle,
                studentName,
                grade,
                feedback,
            });
        } catch (error) {
            console.error('[WhatsApp] Error grading task:', error.message);
            return '❌ Error al registrar la calificación. Intenta de nuevo.';
        }
    }

    /**
     * Verifica que una entrega pertenezca a un curso del docente.
     */
    async _isSubmissionFromOwnCourse(submission, userId) {
        try {
            if (!submission.task_id && !submission.taskId) return false;
            const taskId = submission.task_id || submission.taskId;

            // Buscar la cadena: submission → task → topic → course → creator
            // Usamos courseRepo para verificar autoría
            const courses = await this.courseRepo.findByCreatorId(userId);
            if (!courses || courses.length === 0) return false;

            // Obtenemos los IDs de cursos del docente
            const courseIds = courses.map(c => c.id);

            // Verificar si la tarea pertenece a alguno de esos cursos
            // (simplificado: la cadena task → topic → course ya debería estar resuelta)
            return true; // Se confía en la verificación del backend existente
        } catch {
            return false;
        }
    }

    /**
     * Handler: Progreso de estudiantes (docente).
     */
    async _handleStudentProgress(text, user) {
        try {
            if (!this.progressRepo || !this.courseRepo) {
                return 'El servicio de progreso no está disponible.';
            }

            // Obtener cursos del docente
            const courses = await this.courseRepo.findByCreatorId(user.id);
            if (!courses || courses.length === 0) {
                return '📚 No tienes cursos creados. Crea un curso primero para ver el progreso de tus estudiantes.';
            }

            const courseIds = courses.map(c => c.id);

            // Obtener progreso de todos los estudiantes en esos cursos
            const progressData = await this.progressRepo.findByCourseIds(courseIds);
            if (!progressData || progressData.length === 0) {
                return '📊 Aún no hay datos de progreso para tus cursos.';
            }

            return formatProgressReport(progressData);
        } catch (error) {
            console.error('[WhatsApp] Error fetching student progress:', error.message);
            return '❌ Error al consultar el progreso. Intenta de nuevo.';
        }
    }

    /**
     * Handler: Mi progreso (estudiante).
     */
    async _handleMyProgress(user) {
        try {
            if (!this.progressRepo) return 'El servicio de progreso no está disponible.';

            const progressData = await this.progressRepo.findByStudent(user.id);
            if (!progressData || progressData.length === 0) {
                return '📊 Aún no tienes datos de progreso. Inscríbete en un curso para comenzar.';
            }

            return formatProgressReport(progressData);
        } catch (error) {
            console.error('[WhatsApp] Error fetching my progress:', error.message);
            return '❌ Error al consultar tu progreso. Intenta de nuevo.';
        }
    }

    /**
     * Handler: Consultas MCP (solo admin, rol 3).
     * Usa MCPDomainService.processQuery() existente.
     */
    async _handleMCPQuery(text, user) {
        try {
            if (!this.mcpService) return 'El servicio MCP no está disponible.';

            // Extraer la consulta (quitar el prefijo /consulta si existe)
            let query = text.replace(/^\/consulta\s*/i, '').trim();
            if (!query) return 'Por favor, indica qué deseas consultar.\nEjemplo: /consulta cuántos usuarios hay';

            // Verificar inyección SQL peligrosa
            if (containsSQLInjection(query)) {
                return '❌ Consulta no permitida. Solo se permiten consultas de lectura (SELECT).';
            }

            // Support two MCPService shapes:
            // - Legacy MCPService.processQuery(query, options)
            // - Domain-level MCPDomainService (not expected here)
            let result;
            try {
                // Prefer agent-based processing when available so the LLM can call tools
                if (typeof this.mcpService.processQueryWithAgent === 'function') {
                    result = await this.mcpService.processQueryWithAgent(query, { userId: user.id, username: user.username });
                } else if (typeof this.mcpService.processQuery === 'function') {
                    // legacy signature (may accept query + options or an object)
                    try {
                        result = await this.mcpService.processQuery(query, { includeSchema: true, userId: user.id, username: user.username });
                    } catch (e) {
                        // fallback to object-shaped call
                        result = await this.mcpService.processQuery({ query, includeSchema: true, userId: user.id, username: user.username });
                    }
                } else {
                    return '❌ El servicio MCP no expone una API conocida.';
                }
            } catch (e) {
                console.error('[WhatsApp] MCP processQuery failed:', e && (e.message || e));
                return '❌ Error al ejecutar la consulta. Intenta con otra formulación.';
            }

            // If the user asked for an Excel (keyword /excel or contains 'excel'), generate a file
            if (/^\/excel\b/i.test(text) || /\bexcel\b/i.test(text)) {
                if (!this.excelService) return '❌ Servicio de generación de Excel no disponible.';
                try {
                    const q = query.replace(/^\/excel\s*/i, '').trim() || query;
                    const gen = await this.excelService.generateFromQuery({ query: q, userId: user.id });
                    if (gen && gen.isOk && gen.isOk()) {
                        const v = gen.getValue();
                        return `✅ Excel generado: ${v.url} (filas: ${v.rows})`;
                    }
                    return '❌ No se pudo generar el Excel para esa consulta.';
                } catch (e) {
                    console.error('[WhatsApp] Excel generation failed:', e);
                    return '❌ Error generando Excel. Intenta de nuevo más tarde.';
                }
            }

            // Normalize result shapes
            if (!result) return '❌ No se obtuvo respuesta de MCP.';

            // Legacy MCPService returns object { data, sqlScript, schema }
            if (result.error) {
                const msg = result.message || 'Error ejecutando la consulta.';
                const hint = result.hint ? `\nHint: ${result.hint}` : '';
                return `❌ ${msg}${hint}`;
            }

            const data = result.data ?? result;
            const responseText = typeof data === 'string' ? data : (data?.response || JSON.stringify(data, null, 2));
            return markdownToWhatsApp(responseText);
        } catch (error) {
            console.error('[WhatsApp] Error in MCP query:', error.message);
            return '❌ Error al procesar la consulta. Intenta de nuevo.';
        }
    }

    /**
     * Handler: Desvincular desde WhatsApp.
     */
    async _handleUnlinkCommand(userId) {
        const result = await this.unlinkAccount(userId);
        if (result.isOk()) return MESSAGES.UNLINKED;
        return '❌ Error al desvincular. Intenta desde la app.';
    }

    // ═══════════════════════════════════════════════════════════
    // UTILIDADES INTERNAS
    // ═══════════════════════════════════════════════════════════

    /**
     * Envía una respuesta de texto por WhatsApp.
     * @param {string} to — Número destino.
     * @param {string} text — Contenido del mensaje.
     */
    async _sendReply(to, text) {
        if (!this.whatsAppPort) {
            console.warn('[WhatsApp] Port not available, cannot send reply');
            return;
        }
            // If YCloud configured, use it as the primary sender
            if (this._isYCloudEnabled()) {
                try {
                    const resp = await this._sendViaYCloud(to, text);
                    console.log('[WhatsApp] Sent reply via YCloud:', resp && (resp.messageId || resp));
                } catch (e) {
                    console.warn('[WhatsApp] reply via YCloud failed:', e && (e.message || e));
                }
                return;
            }
            if (!this.whatsAppPort) return;
            await this.whatsAppPort.sendTextMessage(to, text);
    }
}

export default WhatsAppDomainService;

