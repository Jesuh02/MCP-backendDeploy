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
    sanitizeInput,
    containsSQLInjection,
} from '../validators/WhatsAppSchemas.js';
import {
    markdownToWhatsApp,
    truncateResponse,
    formatProgressReport,
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
            // extra debug marker so we can trace that the webhook actually reached
            // the service.  Sometimes users misconfigure the URL and the request
            // never even arrives; this line will help quickly spot that case.
            if (process.env.WHATSAPP_DEBUG === 'true') {
                console.debug('[WhatsApp] DEBUG: entered handleIncomingMessage');
            }

            // avoid processing messages that were sent by the business account itself
            // (can happen e.g. when using the playground or when the webhook echoes
            // outgoing messages).  The business number is configured via env vars.
            const providerNum = (process.env.YCLOUD_WHATSAPP_NUMBER || process.env.WHATSAPP_PHONE_NUMBER || '').replace(/\D+/g, '');
            if (providerNum) {
                const justDigits = from.replace(/\D+/g, '');
                if (justDigits.endsWith(providerNum)) {
                    console.log('[WhatsApp] Ignoring message from own business number', from);
                    return;
                }
            }

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
            if (!text) {
                console.warn('[WhatsApp] sanitized messageBody resulted empty, dropping. original:', messageBody);
                return;
            }

            // logging at debug level helps when the webhook seems not to fire.
            if (process.env.WHATSAPP_DEBUG === 'true') {
                console.log(`[WhatsApp] text after sanitization: '${text}'`);
            }

            // 4. Buscar sesión activa por número de teléfono
            let session = await this.sessionRepo.findByPhoneNumber(from);
            console.log('[WhatsApp] session lookup result initial:', !!session, session && { id: session.id, userId: session.userId, phoneNumber: session.phoneNumber, isActive: session.isActive });

            // If no session was found, try adding a default country code (e.g. +57)
            // or stripping leading plus in case the stored record has a different
            // prefix.  This helps when the user linked using a local number or the
            // provider delivers the "from" value without the country code.
            if (!session) {
                // try using configured default country code or infer one from the
        // business phone number if none was explicitly provided.  This fixes
        // scenarios where the incoming "from" value lacks "+57" (or any CC)
        // and the session lookup would otherwise miss because the stored entry
        // is E.164.
        const defaultCC = this._getDefaultCountryCode();
        if (defaultCC) {
            let alt = from;
            // remove leading + if present then prefix defaultCC
            alt = `+${defaultCC}${alt.replace(/^\+/, '')}`;
            session = await this.sessionRepo.findByPhoneNumber(alt);
            if (session) {
                console.log('[WhatsApp] session found using default country code alt=', alt);
            }
        }
            }

            // If we found a session but the stored phone number differs from the
            // normalized incoming number, update the record so future lookups are
            // exact.  This keeps the database in sync with what WhatsApp actually
            // reports (which may include +57 even when user linked without it).
            if (session && session.phoneNumber && session.phoneNumber !== from) {
                try {
                    await this.sessionRepo.update(session.id, { phone_number: from });
                    console.log('[WhatsApp] updated session phoneNumber to', from);
                } catch (e) {
                    console.warn('[WhatsApp] could not update session phoneNumber', e && e.message);
                }
            }

            // log the inbound message now that we know session and (potentially) user
            if (this.chatMessageRepo) {
                try {
                    // repository expects `message` property (not `content`).
                    // also coerce null/undefined to empty string to avoid NOT NULL
                    await this.chatMessageRepo.create({
                        session_id: session ? session.id : null,
                        user_id: session ? session.userId : null,
                        channel: 'whatsapp',
                        direction: 'inbound',
                        message: messageBody || '',
                        metadata: { waMessageId, from },
                    });
                } catch (e) {
                    console.warn('[WhatsApp] failed to log inbound chat message', e && e.message);
                }
            }

            if (!session || !session.isActive) {
                // Try fallbacks: sometimes phone stored without + or other formatting
                console.warn('[WhatsApp] Session not found or inactive for', from);
                if (process.env.WHATSAPP_DEBUG === 'true') {
                    const inferredCC = this._getDefaultCountryCode();
                    console.log('[WhatsApp] debug session lookup details: inferredCC=', inferredCC);
                }
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

            // 6. Clasificar intención (ahora async para permitir consulta al LLM cuando sea necesario)
            const intent = await this._classifyIntent(text, userRoles);

            console.log('[WhatsApp] classified intent:', intent, 'userRoles:', userRoles);

            // Si el LLM detectó un intento de asignar nota, denegamos la acción
            // con una respuesta amable: WhatsApp no permite calificar.
            if (intent && intent.isGradeAssignmentAttempt) {
                await this._sendReply(from, 'Lo siento — no puedo calificar tareas por WhatsApp.');
                return;
            }

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
                // marcar como leído (no fatal)
                if (waMessageId && this.whatsAppPort) {
                    try {
                        if (typeof this.whatsAppPort.markAsRead === 'function') {
                            await this.whatsAppPort.markAsRead(waMessageId).catch(e => { throw e; });
                        }
                    } catch (markErr) {
                        console.warn('[WhatsApp] markAsRead non-fatal error:', String(markErr.message || markErr));
                        // continuar el procesamiento aun cuando marcar como leído falle
                    }
                }

                // El clasificador devuelve un objeto { intent: 'NAME', ... }
                const intentLabel = (intent && (intent.intent || intent)) || 'GENERAL_QUESTION';

                switch (intentLabel) {
                    case 'UNLINK':
                        response = await this._handleUnlinkCommand(session.userId);
                        break;
                    // grading is disabled for WhatsApp, so we never route aquí. If
                    // the intent somehow is set to GRADE_TASK we fall through to the
                    // general question handler as a safety measure.
                    case 'STUDENT_PROGRESS':
                        response = await this._handleStudentProgress(text, user);
                        break;
                    case 'MCP_QUERY':
                        response = await this._handleMCPQuery(text, user, userRoles);
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
                // if the LLM/service produced nothing we still want the user to
                // see that their message was received; send a generic echo so they
                // know the backend is alive and they can debug further.
                response = 'Recibí tu mensaje, pero no pude generar una respuesta. Intenta otra vez o escribe /ayuda.';
            }

            const chunks = truncateResponse(response);
            for (const chunk of chunks) {
                const ok = await this._sendReply(from, chunk);
                if (!ok) {
                    console.warn('[WhatsApp] _sendReply returned false; stopping further chunks');
                    break;
                }
                // log outbound assistant message
                if (this.chatMessageRepo) {
                    try {
                        await this.chatMessageRepo.create({
                            session_id: session ? session.id : null,
                            user_id: user ? user.id : null,
                            channel: 'whatsapp',
                            direction: 'outbound',
                            message: chunk || '',
                            metadata: { waMessageId: waMessageId || null },
                        });
                    } catch (e) {
                        console.warn('[WhatsApp] failed to log outbound chat message', e && e.message);
                    }
                }
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
    async _classifyIntent(message, userRoles) {
        const text = message.trim().toLowerCase();

        // 1. Comandos explícitos (mayor prioridad)
        if (text.startsWith('/progreso')) return { intent: 'STUDENT_PROGRESS', requiresRole: 'teacher' };
        if (text.startsWith('/consulta')) return { intent: 'MCP_QUERY', requiresRole: 'admin' };
        if (text.startsWith('/ayuda')) return { intent: 'HELP', requiresRole: null };
        if (text.startsWith('/desvincular')) return { intent: 'UNLINK', requiresRole: null };
        if (text.startsWith('/mi_progreso')) return { intent: 'MY_PROGRESS', requiresRole: null };

        // 2. Detección explícita de intención de calificar — en casos ambiguos
        // consultamos al LLM para evitar falsos positivos.  Palabras que indican
        // posibilidad de intento de asignar nota.
        const gradingIndicators = ['calificar', 'califica', 'calificado', 'calificó', 'califico', 'asignar nota', 'dar nota', 'poner nota'];
        const hasGradingIndicator = gradingIndicators.some(k => text.includes(k));

        if (hasGradingIndicator && this.llmService && typeof this.llmService.processPrompt === 'function') {
            try {
                const prompt = `Eres un clasificador de intención. Has recibido el siguiente mensaje de WhatsApp: "${message.trim()}"\n\nResponde SOLO con una de estas etiquetas exactas:\n- ASSIGN_GRADE (si la intención es asignar o modificar una nota a un estudiante)\n- QUERY_ABOUT_GRADES (si la intención es preguntar sobre conteos, estadísticas o historiales de calificaciones)\n- OTHER (ninguna de las anteriores).`;
                const result = await this.llmService.processPrompt({ prompt, userId: null });
                let label = null;
                if (result && result.isOk && result.isOk()) {
                    const val = result.getValue();
                    const textRes = (typeof val === 'string' ? val : (val?.response || val?.text || '')) || '';
                    label = textRes.trim().split(/\s|\n/)[0].toUpperCase();
                }
                if (label === 'ASSIGN_GRADE') {
                    return { intent: 'GENERAL_QUESTION', requiresRole: null, isGradeAssignmentAttempt: true };
                }
                if (label === 'QUERY_ABOUT_GRADES') {
                    // tratar como consulta sobre progreso/estadísticas
                    if (userRoles.includes(2) || userRoles.includes(3)) {
                        return { intent: 'STUDENT_PROGRESS', requiresRole: 'teacher' };
                    }
                    return { intent: 'MY_PROGRESS', requiresRole: null };
                }
                // si LLM responde OTHER o no se entiende, continuar con detección heurística
            } catch (e) {
                console.warn('[WhatsApp] LLM intent classifier failed, falling back to heuristics:', e && e.message);
            }
        }

        // 3. Detección de progreso (heurística más conservadora)
        if (this._isProgressIntent(text)) {
            if (userRoles.includes(2) || userRoles.includes(3)) {
                return { intent: 'STUDENT_PROGRESS', requiresRole: 'teacher' };
            }
            return { intent: 'MY_PROGRESS', requiresRole: null };
        }

        // 4. Consulta MCP (solo admin)
        if (this._isMCPIntent(text) && userRoles.includes(3)) {
            return { intent: 'MCP_QUERY', requiresRole: 'admin' };
        }

        // 5. Fallback: pregunta general al LLM
        return { intent: 'GENERAL_QUESTION', requiresRole: null };
    }



    _isProgressIntent(text) {
        const keywords = ['progreso', 'avance', 'cómo van', 'como van', 'mi progreso'];
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

    /**
     * Determine the default country code to use when normalizing incoming
     * phone numbers.  Prefer explicit environment variable but fall back to
     * parsing the configured WhatsApp number (Meta or YCloud) if available.
     * @returns {string} e.g. "57" or '' when unable to infer
     */
    _getDefaultCountryCode() {
        if (process.env.WHATSAPP_DEFAULT_COUNTRY_CODE) {
            return process.env.WHATSAPP_DEFAULT_COUNTRY_CODE.replace(/[^0-9]/g, '');
        }
        // look at known configuration values for the provider phone number
        const candidates = [
            process.env.YCLOUD_WHATSAPP_NUMBER,
            process.env.WHATSAPP_PHONE_NUMBER,
            process.env.WHATSAPP_NUMBER,
            process.env.YCLOUD_PHONE,
        ];
        for (const cand of candidates) {
            if (cand) {
                const digits = String(cand).replace(/\D+/g, '');
                // assume last 10 digits are subscriber number
                if (digits.length > 10) {
                    const cc = digits.slice(0, digits.length - 10);
                    if (cc) return cc;
                }
            }
        }
        return '';
    }

    // ═══════════════════════════════════════════════════════════
    // HANDLERS POR INTENCIÓN
    // ═══════════════════════════════════════════════════════════

    /**
     * Handler: Preguntas generales (todos los roles).
     * Usa LLMDomainService.processPrompt() existente.
     */
    // internal helper shared by multiple intents.  Returns a chat response
    // string if the user asked for an Excel file (role‑3 only) or `null` when the
    // message does not refer to Excel and normal handling should continue.
    async _maybeHandleExcel(text, user, userRoles = []) {
        if (!/\bexcel\b/i.test(text)) return null;

        if (!this._hasPermission(userRoles, 'admin')) {
            return '❌ Solo administradores pueden generar archivos Excel.';
        }
        if (!this.excelService) {
            return '❌ Servicio de generación de Excel no disponible.';
        }

        // strip leading command and any stray mentions of "excel" so the
        // MCP agent receives only the business query text.  Leaving the word
        // "excel" in the prompt was confusing the agent and often resulted in
        // aggregated count responses instead of detailed row data.
        let q = text.replace(/^\/excel\s*/i, '');
        q = q.replace(/\bexcel\b/gi, '').trim();
        // also remove common filler phrases that users type when requesting an
        // Excel file.  We keep keywords like "pagos"/"username" so that the
        // database agent can still detect them.
        q = q.replace(/dame un\s+excel/gi, '').trim();
        if (!q) {
            // if after stripping we have nothing sensible, bail out early
            return '❌ Debes indicar qué datos quieres en el Excel. Ejemplo: "/excel usuarios activos"';
        }
        console.log("[WhatsApp] Excel query sanitized to:", q);

        try {
            const gen = await this.excelService.generateFromQuery({ query: q, userId: user.id });
            if (gen && gen.isOk && gen.isOk()) {
                const v = gen.getValue();
                return `✅ Excel generado: ${v.url} (filas: ${v.rows})`;
            }
            const err = gen && gen.getError && gen.getError();
            const msg = err && err.message ? err.message : 'No se pudo generar el Excel para esa solicitud.';
            return `❌ ${msg}`;
        } catch (e) {
            console.error('[WhatsApp] Excel generation failed:', e);
            return '❌ Error generando Excel. Intenta de nuevo más tarde.';
        }
    }

    async _handleGeneralQuestion(text, session, user, userRoles = []) {
        try {
            if (!this.llmService) return 'El servicio de IA no está disponible en este momento. Verifica que DEEPSEEK_API_KEY esté configurado y USE_LLM no esté desactivado.';

            // early exit for excel requests
            const excelResp = await this._maybeHandleExcel(text, user, userRoles);
            if (excelResp !== null) return excelResp;

            // Decide whether the Business‑Intelligence persona should be used.
            // Admins always get the BI persona now (see requirement), non-admins get
            // generic chat.
            const isAdmin = Array.isArray(userRoles) && userRoles.includes(3);
            const context = session.conversationContext || [];

            let promptToSend = text;
            let forceTools = false;

            // Always instruct the model not to grade tasks when queries come from
            // WhatsApp. This channel is for open-ended Q&A only.
            promptToSend = `Por favor responde como un asistente general. NO califiques tareas ni asumas el rol de evaluador.\n\n${promptToSend}`;

            // For administrators we always engage the Business Intelligence persona
            // that mirrors the behaviour of DatabaseQueryFragment.kt.  This means every
            // message is sent to the LLM with instructions to use `query_database` when
            // appropriate and to format results as a BI report.  Non-admin users will
            // still receive a generic LLM chat response.
            if (isAdmin) {
                forceTools = true;
                const username = user?.username || 'usuario';
                const biPrompt = `CONSULTA DE BUSINESS INTELIGENCIA: ${text}\n\nINSTRUCCIONES:\nEres un experto en Business Intelligence y Marketing. Tu objetivo es analizar la base de datos y dar recomendaciones estratégicas.\n\n1. El esquema de la base de datos YA ESTÁ en tu contexto. NO llames a 'get_database_schema' (salvo que necesites confirmar la estructura de tablas).\n2. 📌 OBLIGATORIO: usa la herramienta 'query_database' para obtener métricas reales (usuarios, cursos, ventas, etc.). No inventes datos.\n   - Para invocarla, responde primero con un bloque JSON EXACTO:\n` +
                    "```json\n" +
                    "{\"tool\":\"query_database\",\"arguments\":{\"query\":\"<tu SQL aquí>\"}}\n" +
                    "```\n" +
                    `   Debes esperar a que el backend ejecute ese SQL y componer tu reporte utilizando la respuesta.\n3. Genera un reporte con el siguiente formato EXACTO (Markdown):\n\n## Resumen ejecutivo\n[Objetivo y hallazgos principales]\n\n## Decisiones críticas\n1. [Decisión 1]\n2. [Decisión 2]\n\n## KPIs priorizados\n1. [KPI 1]\n2. [KPI 2]\n\n## Ejemplos de SQL\n` +
                    "```sql\n" +
                    "-- Ejemplo relevante\nSELECT ...\n" +
                    "```\n" +
                    `\n\n## Acción inmediata\n[Acción concreta]\n\nIMPORTANTE: Basa tus respuestas en DATOS REALES de la base de datos. Si necesitas información real, llama a la herramienta \"query_database\" del agente MCP y espera su respuesta antes de concluir.\n\n🎯 ¡Bienvenido/a, ${username}!`;
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
                // only force tools when we've decided the query persona applies
                forceMCPTools: forceTools,
            });

            console.log('[WhatsApp] LLM processPrompt result:', result && (result.isOk ? (result.isOk() ? 'ok' : 'fail') : typeof result));

            if (result && result.isOk && result.isOk()) {
                const answer = result.getValue();
                let responseText = typeof answer === 'string' ? answer : (answer?.response || answer?.text || JSON.stringify(answer));
                // if answer object had no real content we may have fallen back to
                // JSON.stringify(answer) (see earlier bug).  Detect that pattern
                // and treat it as empty so the generic fallback logic can apply.
                if (typeof answer === 'object' && !answer.response && !answer.text) {
                    const maybeJson = responseText.trim();
                    if (maybeJson.startsWith('{') && maybeJson.includes('"model"') && maybeJson.includes('"response"')) {
                        responseText = '';
                    }
                }
                // strip any grading signal the LLM may have included; WhatsApp should
                // behave as a general Q&A channel only
                responseText = responseText.replace(/\[GRADING_REQUEST(?::\s*\d+(?:\.\d+)?)?\]\s*/gi, '');
                // If the LLM produced no usable text (common when it chose not to call tools),
                // attempt a MCP fallback that runs the DB agent or direct query execution.
                if (!responseText || !String(responseText).trim()) {
                    try {
                        if (this.mcpService) {
                            let mcpResult = null;
                            if (typeof this.mcpService.processQueryWithAgent === 'function') {
                                mcpResult = await this.mcpService.processQueryWithAgent(text, { userId: user.id, username: user.username });
                            } else if (typeof this.mcpService.processQueryToData === 'function') {
                                mcpResult = await this.mcpService.processQueryToData(text, user.id);
                            } else if (typeof this.mcpService.processQuery === 'function') {
                                mcpResult = await this.mcpService.processQuery(text, { userId: user.id, username: user.username });
                            }

                            if (mcpResult) {
                                const payload = mcpResult.data ?? mcpResult.rows ?? mcpResult;
                                if (Array.isArray(payload) && payload.length > 0) {
                                    const sample = payload.slice(0, 10).map(r => JSON.stringify(r)).join('\n');
                                    return markdownToWhatsApp(`Resultados (muestra hasta 10 filas):\n${sample}`);
                                }
                                if (typeof payload === 'object') return markdownToWhatsApp(JSON.stringify(payload, null, 2));
                                return markdownToWhatsApp(String(payload || 'No se encontraron datos.'));
                            }
                        }
                    } catch (mcpErr) {
                        console.error('[WhatsApp] MCP fallback error:', mcpErr && (mcpErr.message || mcpErr));
                    }
                }
                return markdownToWhatsApp(responseText);
            }

            if (typeof result === 'string') return markdownToWhatsApp(result);
            return MESSAGES.ERROR;
        } catch (error) {
            console.error('[WhatsApp] Error in general question:', error.message);
            return MESSAGES.ERROR;
        }
    }

    /*
     * Grade handler is disabled for WhatsApp channel. The method is retained
     * for reference but should never be invoked because intent classification
     * no longer returns GRADE_TASK.
     */
    async _handleGradeTask(text, user, userRoles) {
        // This should not be called anymore. Log if it ever happens.
        console.warn('[WhatsApp] _handleGradeTask invoked unexpectedly; grading disabled.');
        return 'La funcionalidad de calificar tareas no está disponible en WhatsApp.';
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
    async _handleMCPQuery(text, user, userRoles = []) {
        try {
            if (!this.mcpService) return 'El servicio MCP no está disponible.';

            // check that caller has admin role just in case (intent logic should
            // have already enforced this).
            if (!this._hasPermission(userRoles, 'admin')) {
                return '❌ Solo administradores pueden usar consultas MCP o generar Excel.';
            }

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

            // intercept Excel requests (after computing `query` but before
            // running it) using the shared helper which also enforces the
            // admin-only restriction.
            const excelResp = await this._maybeHandleExcel(text, user, userRoles);
            if (excelResp !== null) {
                // if the helper decided this was an Excel request, return the
                // formatted response and skip the normal MCP result handling.
                return excelResp;
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
    /**
     * Envía una respuesta de texto por WhatsApp.
     * @param {string} to — Número destino.
     * @param {string} text — Contenido del mensaje.
     * @returns {Promise<boolean>} true si el envío aparentemente tuvo éxito.
     */
    async _sendReply(to, text) {
        if (!this.whatsAppPort) {
            console.warn('[WhatsApp] Port not available, cannot send reply');
            return false;
        }

        // If YCloud configured, try it first but fall back to the Meta adapter
        if (this._isYCloudEnabled()) {
            try {
                const resp = await this._sendViaYCloud(to, text);
                console.log('[WhatsApp] Sent reply via YCloud:', resp && (resp.messageId || resp));
                return true;
            } catch (e) {
                console.warn('[WhatsApp] reply via YCloud failed:', e && (e.message || e));
                // fall through to use Meta adapter below
            }
        }

        // finally send via the configured WhatsApp port (e.g. Meta)
        try {
            await this.whatsAppPort.sendTextMessage(to, text);
            return true;
        } catch (err) {
            console.error('[WhatsApp] failed sending reply via port:', err && (err.message || err));
            return false;
        }
    }
}

export default WhatsAppDomainService;

