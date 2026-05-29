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
import { WhatsAppSession } from './whatsapp-session.entity.js';
import {
    validatePhoneNumber,
    sanitizeInput,
    containsSQLInjection,
} from './whatsapp.schemas.js';
import {
    markdownToWhatsApp,
    truncateResponse,
    formatProgressReport,
    MESSAGES,
} from '../../utils/whatsappFormatter.js';
import { getAllTenantEntries, TENANT_CONFIGS, runInTenantContext, getTenantClient, getCurrentTenantId, getTenantMcpServerUrl } from '../../config/tenantRegistry.js';
import { SupabaseUserRepository } from '../user/infrastructure/supabase.user.repository.js';
import { SupabasePersonaRepository } from '../persona/infrastructure/supabase.persona.repository.js';

/** Key used to persist the user's selected query-tenant in conversationContext. */
const TENANT_SEL_PREFIX = '__TENANT_SEL__:';
/** Key used to signal that the bot is waiting for institution selection. */
const PENDING_SEL_CONTENT = '__PENDING_TENANT_SEL__';
/** Key used to track when the institution menu was last sent (for 24h frequency). */
const TENANT_ASK_TIMESTAMP_PREFIX = '__TENANT_ASK_AT__:';
/** 24 hours in milliseconds — don't re-ask the institution menu within this window. */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export class WhatsAppDomainService {
    /**
     * @param {object} deps — Dependencias inyectadas (Composition Root).
     */
    constructor({
        whatsAppPort,
        whatsAppSessionRepo,
        crossTenantSessionRepo,
        userRepository,
        rolRepository,
        mcpDomainService,
        llmDomainService,
        submissionRepository,
        progressRepository,
        courseRepository,
        chatMessageRepository,
        excelService,
        pdfService,
        emailService,
    }) {
        this.whatsAppPort = whatsAppPort;
        this.sessionRepo = whatsAppSessionRepo;
        /** @type {import('./infrastructure/cross-tenant-whatsapp-session.repository.js').CrossTenantWhatsAppSessionRepository} */
        this.crossTenantSessionRepo = crossTenantSessionRepo;
        this.userRepo = userRepository;
        this.rolRepo = rolRepository;
        this.mcpService = mcpDomainService;
        this.llmService = llmDomainService;
        this.submissionRepo = submissionRepository;
        this.progressRepo = progressRepository;
        this.courseRepo = courseRepository;
        this.chatMessageRepo = chatMessageRepository;
        this.excelService = excelService;
        this.pdfService = pdfService || null;
        this.emailService = emailService || null;

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

    // ═══════════════════════════════════════════════════════════
    // OTP — envío de código de verificación
    // ═══════════════════════════════════════════════════════════

    /**
     * Despacha el OTP con el proveedor disponible.
     * Prioridad: YCloud template → YCloud texto → Meta.
     * @param {string} phoneNumber E.164
     * @param {string} otpCode 6 dígitos
     */
    async _sendOtp(phoneNumber, otpCode) {
        if (this._isYCloudEnabled()) {
            if (process.env.YCLOUD_OTP_TEMPLATE_NAME) {
                return this._sendViaYCloudTemplate(phoneNumber, otpCode);
            }
            const text = `🔐 Tu código de verificación CourseV es: *${otpCode}*\n\nEste código expira en 10 minutos.`;
            return this._sendViaYCloud(phoneNumber, text);
        }
        if (typeof this.whatsAppPort?.sendOtpMessage === 'function') {
            return this.whatsAppPort.sendOtpMessage(phoneNumber, otpCode);
        }
        const text = `🔐 Tu código de verificación CourseV es: *${otpCode}*\n\nEste código expira en 10 minutos.`;
        return this.whatsAppPort.sendTextMessage(phoneNumber, text);
    }

    /**
     * Mapea un error de envío OTP a un Result.fail con código semántico.
     * @param {Error} err
     * @returns {Result}
     */
    _mapOtpSendError(err) {
        const msg = String(err?.message || '');
        const code = String(err?.code || '');
        if (code === 'WHATSAPP_RECIPIENT_NOT_ALLOWED_TEST_MODE' || msg.includes('131030'))
            return Result.fail(new AppError('Este número no está permitido en modo prueba de Meta. Agrégalo como tester en WhatsApp Cloud API.', 400, true, 'WHATSAPP_RECIPIENT_NOT_ALLOWED_TEST_MODE'));
        if (code === 'WHATSAPP_ACCOUNT_NOT_REGISTERED' || msg.includes('133010'))
            return Result.fail(new AppError('El número no tiene una cuenta de WhatsApp activa.', 400, true, 'WHATSAPP_ACCOUNT_NOT_REGISTERED'));
        console.error('[WhatsApp] OTP send error:', msg);
        return Result.fail(new AppError('No se pudo enviar el código de verificación. Verifica el número e inténtalo nuevamente.', 502, true, 'WHATSAPP_OTP_SEND_FAILED'));
    }

    /**
     * Envía OTP usando template de YCloud (no requiere ventana de 24h).
     * Configura YCLOUD_OTP_TEMPLATE_NAME con el nombre de la plantilla aprobada.
     * @param {string} to E.164
     * @param {string} otpCode
     */
    async _sendViaYCloudTemplate(to, otpCode) {
        const from = process.env.YCLOUD_WHATSAPP_NUMBER || process.env.YCLOUD_PHONE;
        const baseUrl = (process.env.YCLOUD_BASE_URL || 'https://api.ycloud.com/v2').replace(/\/$/, '');
        return this._ycloudPost([{
            url: `${baseUrl}/whatsapp/messages`,
            payload: {
                from, to, type: 'template',
                template: {
                    name: process.env.YCLOUD_OTP_TEMPLATE_NAME,
                    language: { code: process.env.YCLOUD_OTP_TEMPLATE_LANGUAGE || 'es' },
                    components: [{ type: 'body', parameters: [{ type: 'text', text: otpCode }] }],
                },
            },
        }]);
    }

    /**
     * Envía texto libre vía YCloud HTTP API.
     * Solo funciona dentro de la ventana de 24h. Para mensajes proactivos usar _sendViaYCloudTemplate.
     * @param {string} to E.164
     * @param {string} text
     */
    async _sendViaYCloud(to, text) {
        const fromNumber = process.env.YCLOUD_WHATSAPP_NUMBER || process.env.YCLOUD_PHONE;
        const instanceId = process.env.YCLOUD_INSTANCE_ID || process.env.YCLOUD_ID;
        const baseUrl = (process.env.YCLOUD_BASE_URL || 'https://api.ycloud.com/v2').replace(/\/$/, '');

        const candidates = [];
        if (fromNumber) {
            candidates.push({
                url: `${baseUrl}/whatsapp/messages/sendDirectly`,
                payload: { from: fromNumber, to, type: 'text', text: { body: String(text) } },
            });
        }
        if (instanceId) {
            candidates.push({
                url: `${baseUrl}/instances/${instanceId}/messages`,
                payload: { to: to.replace(/^\+/, ''), type: 'text', text: { body: String(text) } },
            });
        }
        if (!candidates.length) throw new Error('YCloud: define YCLOUD_WHATSAPP_NUMBER o YCLOUD_INSTANCE_ID');

        return this._ycloudPost(candidates);
    }

    /**
     * Ejecuta POST a YCloud con reintentos y timeout.
     * @param {{ url: string, payload: object }[]} candidates — Endpoints a intentar en orden.
     * @param {number} [retries=3]
     */
    async _ycloudPost(candidates, retries = 3) {
        const apiKey = process.env.YCLOUD_API_KEY;
        if (!apiKey) throw new Error('YCLOUD_API_KEY no configurado');
        const timeoutMs = Number(process.env.YCLOUD_REQUEST_TIMEOUT_MS || 8000);
        let lastErr;

        for (let attempt = 1; attempt <= retries; attempt++) {
            for (const { url, payload } of candidates) {
                try {
                    const ctrl = new AbortController();
                    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
                        body: JSON.stringify(payload),
                        signal: ctrl.signal,
                    }).finally(() => clearTimeout(timer));
                    const data = await resp.json().catch(() => ({}));
                    if (!resp.ok) throw Object.assign(new Error(data?.error?.message || data?.message || `YCloud ${resp.status}`), { httpStatus: resp.status, meta: data });
                    return data;
                } catch (err) {
                    lastErr = err;
                    if (process.env.WHATSAPP_DEBUG === 'true') console.warn(`[WhatsApp] YCloud attempt=${attempt} ${url}:`, err?.message);
                }
            }
            if (attempt < retries) await new Promise(r => setTimeout(r, 200 * attempt));
        }
        throw Object.assign(new Error(`YCloud fetch failed: ${lastErr?.message}`), { cause: lastErr });
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

            // 4. Session lookup across ALL tenant databases.
            //    WebHook requests carry no JWT so TenantMiddleware sets the default
            //    tenant.  We must probe every tenant to find where this phone lives.
            let session = null;
            let sessionTenantId = 'qa-develop';

            // sessionIsMultiTenant = true only when this phone number genuinely
            // has sessions in MORE THAN ONE tenant.  A user linked to a single
            // institution should never see the institution-selection menu.
            let sessionIsMultiTenant = false;

            if (this.crossTenantSessionRepo) {
                const crossResult = await this.crossTenantSessionRepo.findByPhoneNumber(from);

                if (Array.isArray(crossResult)) {
                    // Phone exists in multiple tenant DBs.  Verify they belong to the
                    // same physical person by comparing cedula hashes before offering
                    // institution selection.
                    const activeCross = crossResult.filter(m => m.session.isActive);
                    const pool = activeCross.length ? activeCross : crossResult;

                    // Fetch cedula hashes for each match to verify identity
                    const cedulaHashes = await Promise.all(
                        pool.map(async (m) => {
                            try {
                                const userId = m.session.userId;
                                if (!userId || !m.client) return null;
                                const userRepo = new SupabaseUserRepository(m.client);
                                const user = await userRepo.findById(userId);
                                const personaId = user?.persona_id ?? user?.personas?.id ?? null;
                                if (!personaId) return null;
                                const personaRepo = new SupabasePersonaRepository(m.client);
                                const persona = await personaRepo.findById(personaId);
                                // Prefer numeric identificacion (actual cedula) over identificacion_original (legacy/hash)
                                const ident = persona?.identificacion;
                                if (ident && Number.isFinite(Number(ident)) && Number(ident) > 0) return String(ident);
                                return persona?.identificacion_original ?? null;
                            } catch { return null; }
                        }),
                    );

                    const validHashes = cedulaHashes.filter(Boolean);
                    const uniqueHashes = [...new Set(validHashes)];

                    // Only treat as multi-tenant if ALL matches have the same cedula
                    const isSamePerson = validHashes.length === pool.length && uniqueHashes.length === 1;

                    if (isSamePerson && pool.length > 1) {
                        sessionIsMultiTenant = true;
                    }

                    const primaryMatch = pool[0];
                    session = primaryMatch?.session ?? null;
                    sessionTenantId = primaryMatch?.tenantId ?? 'qa-develop';
                } else if (crossResult) {
                    session = crossResult.session;
                    sessionTenantId = crossResult.tenantId;
                }
            } else {
                // Fallback: single-tenant mode (crossTenantSessionRepo not wired)
                session = await this.sessionRepo.findByPhoneNumber(from);
            }

            console.log('[WhatsApp] cross-tenant session lookup:', !!session, session && { id: session.id, tenantId: sessionTenantId, isActive: session?.isActive });

            // Normalize phone number in session if it differs from incoming value
            if (session && session.phoneNumber && session.phoneNumber !== from) {
                try {
                    await this.sessionRepo.update(session.id, { phone_number: from });
                } catch (e) {
                    console.warn('[WhatsApp] phone normalize update failed:', e?.message);
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
                console.warn('[WhatsApp] Session not found or inactive for', from);
                await this._sendReply(from, MESSAGES.NOT_LINKED);
                return;
            }

            // ── Short-circuit: plain-text email requests don't need a DB query tenant ──
            // Personal emails (no Excel/PDF attachment) don't require any DB lookups,
            // so skip institution selection entirely and process in the session tenant.
            const isPlainEmailRequest = this._isEmailIntent(text) && !/\b(excel|pdf)\b/i.test(text);
            if (isPlainEmailRequest) {
                await runInTenantContext(sessionTenantId, () =>
                    this._processMessageWithTenant(from, text, messageBody, waMessageId, session, sessionTenantId, sessionTenantId, null),
                );
                return;
            }

            // ── Institution (tenant) selection ─────────────────────────────────────
            // Determine which tenant the LLM should query. This is the "query tenant"
            // and may differ from the "session tenant" when the user explicitly requests
            // a different institution or has accounts in multiple tenants.
            const queryTenantId = await runInTenantContext(sessionTenantId, async () => {
                return this._resolveQueryTenant(from, text, session, sessionTenantId, sessionIsMultiTenant);
            });

            // If _resolveQueryTenant sent a menu/reply and returned null, stop here.
            if (queryTenantId === null) return;

            // ── Wrap the rest of message processing in the resolved query tenant ──
            // All repository calls below (userRepo, courseRepo, progressRepo, mcpService…)
            // will transparently route to the selected institution's Supabase database.
            //
            // CROSS-TENANT USER RESOLUTION: When the query tenant differs from the
            // session tenant, user IDs are not portable (each DB has its own sequence).
            // Pre-fetch the user from the SESSION tenant so we can look them up by
            // username in the QUERY tenant inside _processMessageWithTenant.
            let sessionUser = null;
            if (queryTenantId !== sessionTenantId) {
                try {
                    sessionUser = await runInTenantContext(sessionTenantId, () =>
                        this.userRepo.findById(session.userId),
                    );
                } catch (e) {
                    console.warn('[WhatsApp] failed to pre-fetch sessionUser for cross-tenant lookup:', e?.message);
                }
            }

            await runInTenantContext(queryTenantId, () =>
                this._processMessageWithTenant(from, text, messageBody, waMessageId, session, sessionTenantId, queryTenantId, sessionUser),
            );
        } catch (error) {
            console.error('[WhatsAppDomainService] Error handling message:', error);
            await this._sendReply(from, MESSAGES.ERROR).catch((e) => {
                console.warn('[WhatsApp] failed to send error reply:', e && (e.message || e));
            });
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Institution (tenant) selection helpers
    // ═══════════════════════════════════════════════════════════

    /**
     * Resolves which tenant (institution) the user wants to query.
     *
     * Decision tree:
     *   1. User writes "consulta/cambia a <institution>" → switch and persist.
     *   2. Session context has an existing selection → honour it.
     *   3. Only 1 tenant is available → use it directly.
     *   4. Multiple tenants & pending selection → parse user's choice.
     *   5. Multiple tenants & no selection yet → send selection menu, return null.
     *
     * @param {string} from - E.164 phone number.
     * @param {string} text - Sanitized message text.
     * @param {WhatsAppSession} session - Current WhatsApp session.
     * @param {string} sessionTenantId - Tenant where the session is stored.
     * @returns {Promise<string|null>} tenantId, or null if a menu was sent.
     */
    async _resolveQueryTenant(from, text, session, sessionTenantId, isMultiTenant = false) {
        const availableTenants = TENANT_CONFIGS.map(t => ({ id: t.id, name: t.name }));

        // Allow user to explicitly request a different institution at any time
        const explicitTenant = this._detectExplicitTenantRequest(text, availableTenants);
        if (explicitTenant) {
            this._setSelectedTenantInContext(session, explicitTenant.id);
            await this.sessionRepo.update(session.id, { conversation_context: session.conversationContext });
            await this._sendReply(from, `✅ Perfecto, consultaré la información de *${explicitTenant.name}*.`);
            return explicitTenant.id;
        }

        // Check if session already has a stored selection
        const storedTenant = this._getSelectedTenantFromContext(session);
        if (storedTenant && TENANT_CONFIGS.some(t => t.id === storedTenant)) {
            return storedTenant;
        }

        // If the user's phone number exists in only ONE tenant, skip the
        // institution-selection menu entirely and use the session tenant directly.
        // `isMultiTenant` is true only when the cross-tenant lookup returned sessions
        // from more than one database for this phone number.
        if (!isMultiTenant || availableTenants.length <= 1) {
            return sessionTenantId;
        }

        // Multiple tenants: check if we are awaiting the user's selection
        const isPending = session.conversationContext.some(
            e => e.role === 'system' && e.content === PENDING_SEL_CONTENT,
        );

        if (isPending) {
            // Try to parse user reply as a selection
            const chosen = this._parseTenantSelection(text, availableTenants);
            if (chosen) {
                this._setSelectedTenantInContext(session, chosen.id);
                await this.sessionRepo.update(session.id, { conversation_context: session.conversationContext });
                await this._sendReply(from, `✅ Perfecto, consultaré la información de *${chosen.name}*.\n\n¿En qué puedo ayudarte?`);
                return chosen.id;
            }
            // Could not parse — show menu again
            await this._sendReply(from, '⚠️ No reconocí tu selección. Por favor responde con el número o el nombre de la institución.');
            await this._sendReply(from, this._formatInstitutionMenu(availableTenants));
            return null;
        }

        // Multi-tenant: check if we already sent the menu within the last 24 hours
        // to avoid spamming the user on every message.
        const lastAskEntry = session.conversationContext.find(
            e => e.role === 'system' && e.content?.startsWith(TENANT_ASK_TIMESTAMP_PREFIX),
        );
        const lastAskAt = lastAskEntry
            ? parseInt(lastAskEntry.content.slice(TENANT_ASK_TIMESTAMP_PREFIX.length), 10)
            : 0;
        if (lastAskEntry && (Date.now() - lastAskAt) < TWENTY_FOUR_HOURS_MS) {
            // Already asked recently — use session tenant as default without asking again.
            return sessionTenantId;
        }

        // Record the time we sent the menu so we don't resend for 24 hours.
        session.conversationContext = session.conversationContext.filter(
            e => !(e.role === 'system' && e.content?.startsWith(TENANT_ASK_TIMESTAMP_PREFIX)),
        );
        session.conversationContext.push({ role: 'system', content: `${TENANT_ASK_TIMESTAMP_PREFIX}${Date.now()}`, timestamp: Date.now() });
        session.conversationContext.push({ role: 'system', content: PENDING_SEL_CONTENT, timestamp: Date.now() });
        await this.sessionRepo.update(session.id, { conversation_context: session.conversationContext });
        await this._sendReply(from, this._formatInstitutionMenu(availableTenants));
        return null; // processing stops; we wait for the user to reply
    }

    /**
     * Formats a numbered institution selection menu for WhatsApp.
     * @param {{ id: string, name: string }[]} tenants
     * @returns {string}
     */
    _formatInstitutionMenu(tenants) {
        const lines = tenants.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
        return `🏫 *¿De qué institución deseas consultar los datos?*\n\n${lines}\n\nResponde con el número o el nombre de la institución.`;
    }

    /**
     * Detects if the message contains an explicit institution change request.
     * e.g. "consulta Incat", "obtén info de qa", "cambia a Politécnico"
     * @param {string} text
     * @param {{ id: string, name: string }[]} tenants
     * @returns {{ id: string, name: string } | null}
     */
    _detectExplicitTenantRequest(text, tenants) {
        // Match when user mentions an institution alongside query-intent keywords.
        // This covers both:
        //   a) explicit switch commands: "consulta INCAT", "cambia a Politécnico"
        //   b) inline institution reference: "cuántos usuarios hay en INCAT?"
        const queryKw = /\b(consulta|consultar|cambia|cambiar|quiero datos de|informaci[oó]n de|usa|usar|obt[eé]n info de|selecciona|seleccionar|usuarios|cursos|estudiantes|tareas|cu[aá]ntos|reporte|estad[ií]sticas|inscripciones|datos|base de datos|hay en|tiene la|de la instituci[oó]n)\b/i;
        if (!queryKw.test(text)) return null;
        return this._parseTenantSelection(text, tenants);
    }

    /**
     * Tries to match text against tenant list by number ("1","2") or name fragment.
     * @param {string} text
     * @param {{ id: string, name: string }[]} tenants
     * @returns {{ id: string, name: string } | null}
     */
    _parseTenantSelection(text, tenants) {
        const trimmed = text.trim();

        // Numeric selection ("1", "2", …)
        const numMatch = /^(\d+)$/.exec(trimmed);
        if (numMatch) {
            const idx = parseInt(numMatch[1], 10) - 1;
            return (idx >= 0 && idx < tenants.length) ? tenants[idx] : null;
        }

        // Name fragment match (case-insensitive)
        const lower = trimmed.toLowerCase();
        return tenants.find(t => lower.includes(t.id.toLowerCase()) || lower.includes(t.name.toLowerCase())) ?? null;
    }

    /** Reads the selected query tenant from conversationContext. */
    _getSelectedTenantFromContext(session) {
        for (let i = session.conversationContext.length - 1; i >= 0; i--) {
            const entry = session.conversationContext[i];
            if (entry.role === 'system' && entry.content?.startsWith(TENANT_SEL_PREFIX)) {
                return entry.content.slice(TENANT_SEL_PREFIX.length);
            }
        }
        return null;
    }

    /** Persists the selected query tenant into conversationContext (in-place). */
    _setSelectedTenantInContext(session, tenantId) {
        // Remove old pending and old selection entries
        session.conversationContext = session.conversationContext.filter(
            e => !(e.role === 'system' && (e.content === PENDING_SEL_CONTENT || e.content?.startsWith(TENANT_SEL_PREFIX))),
        );
        session.conversationContext.push({ role: 'system', content: `${TENANT_SEL_PREFIX}${tenantId}`, timestamp: Date.now() });
    }

    // ═══════════════════════════════════════════════════════════
    // MCP tenant-aware routing
    // ═══════════════════════════════════════════════════════════

    /**
     * Routes an MCP query to the correct MCP server based on the query tenant.
     * - If the tenant's MCP server URL matches MCP_SELF_URL (or no URL is configured),
     *   processes the query locally via this.mcpService.
     * - Otherwise forwards the request via HTTP to the remote MCP server.
     *
     * @param {string} query - Natural language or SQL query.
     * @param {string} tenantId - The resolved query tenant ID.
     * @param {{ userId?: number, username?: string, userRoles?: number[] }} userContext
     * @returns {Promise<string|object|null>}
     */
    async _callMcpForTenant(query, tenantId, userContext = {}) {
        const tenantMcpUrl = getTenantMcpServerUrl(tenantId);
        const selfUrl = (process.env.MCP_SELF_URL || '').replace(/\/$/, '');
        const normalizedTenantUrl = tenantMcpUrl ? tenantMcpUrl.replace(/\/$/, '') : null;

        // Use local service when: no URL configured for tenant, MCP_SELF_URL not set,
        // or the tenant's MCP server URL matches this server's own URL.
        const isLocal = !normalizedTenantUrl || !selfUrl || normalizedTenantUrl === selfUrl;

        if (isLocal) {
            if (!this.mcpService) return null;
            if (typeof this.mcpService.processQueryWithAgent === 'function') {
                return this.mcpService.processQueryWithAgent(query, userContext);
            } else if (typeof this.mcpService.processQueryToData === 'function') {
                return this.mcpService.processQueryToData(query, userContext.userId);
            } else if (typeof this.mcpService.processQuery === 'function') {
                return this.mcpService.processQuery(query, { ...userContext, includeSchema: true });
            }
            return null;
        }

        // ── Remote call to the tenant's dedicated MCP server ──────────────────
        console.log(`[WhatsApp] Tenant='${tenantId}' → routing MCP query to remote server: ${normalizedTenantUrl}`);
        const timeoutMs = Number(process.env.MCP_REMOTE_TIMEOUT_MS || 45000);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const resp = await fetch(`${normalizedTenantUrl}/tools/call`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.MCP_INTER_SERVER_KEY
                        ? { 'X-Inter-Server-Key': process.env.MCP_INTER_SERVER_KEY }
                        : {}),
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {
                        name: 'query_database',
                        arguments: {
                            query,
                            ...(userContext.userId != null ? { _userId: userContext.userId } : {}),
                            ...(userContext.userRoles?.length ? { _userRoles: userContext.userRoles } : {}),
                        },
                        meta: {
                            userId: userContext.userId ?? null,
                            username: userContext.username ?? null,
                            userRoles: userContext.userRoles ?? [],
                        },
                    },
                }),
                signal: ctrl.signal,
            });
            clearTimeout(timer);

            if (!resp.ok) {
                throw new Error(`Remote MCP server at ${normalizedTenantUrl} returned HTTP ${resp.status}`);
            }

            const data = await resp.json().catch(() => null);
            // JSON-RPC response: { result: { content: [{ type: 'text', text: '...' }] } }
            const text = data?.result?.content?.[0]?.text;
            if (text) return text;
            return data?.result ?? null;
        } catch (err) {
            clearTimeout(timer);
            throw err;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Message processing inside the resolved tenant context
    // ═══════════════════════════════════════════════════════════

    /**
     * Processes the incoming message once the query tenant is fully resolved.
     * All repository calls here transparently route to the selected tenant database
     * because this method is invoked inside runInTenantContext().
     */
    async _processMessageWithTenant(from, text, messageBody, waMessageId, session, sessionTenantId, queryTenantId, sessionUser = null) {
        // 5. Fetch user from the resolved query-tenant database.
        // CROSS-TENANT USER RESOLUTION:
        // When the query tenant differs from the session tenant, the user's ID in
        // session.userId belongs to the session DB — it may not match any row in the
        // query DB. Look up by username in the query tenant instead.
        let user;
        if (sessionUser && queryTenantId !== sessionTenantId) {
            user = typeof this.userRepo.findByUsername === 'function'
                ? await this.userRepo.findByUsername(sessionUser.username)
                : null;
            // Verify cedula: the user found in the query tenant must be the same
            // physical person as the session user (prevent username-collision).
            if (user) {
                try {
                    const sessionPersonaId = sessionUser.persona_id ?? sessionUser.personas?.id ?? sessionUser.persona?.id ?? null;
                    const queryPersonaId = user.persona_id ?? user.personas?.id ?? user.persona?.id ?? null;
                    if (sessionPersonaId && queryPersonaId) {
                        const sessionClient = getTenantClient(sessionTenantId);
                        const queryClient = getTenantClient(queryTenantId);
                        const sessionPersonaRepo = new SupabasePersonaRepository(sessionClient);
                        const queryPersonaRepo = new SupabasePersonaRepository(queryClient);
                        const [sessionPersona, queryPersona] = await Promise.all([
                            sessionPersonaRepo.findById(sessionPersonaId),
                            queryPersonaRepo.findById(queryPersonaId),
                        ]);
                        const sessionCedula = (() => {
                            const id = sessionPersona?.identificacion;
                            if (id && Number.isFinite(Number(id)) && Number(id) > 0) return String(id);
                            return sessionPersona?.identificacion_original ?? null;
                        })();
                        const queryCedula = (() => {
                            const id = queryPersona?.identificacion;
                            if (id && Number.isFinite(Number(id)) && Number(id) > 0) return String(id);
                            return queryPersona?.identificacion_original ?? null;
                        })();
                        if (sessionCedula && queryCedula && sessionCedula !== queryCedula) {
                            console.warn(`[WhatsApp] Cedula mismatch for '${sessionUser.username}' between ${sessionTenantId} and ${queryTenantId} — different people, using session user`);
                            user = sessionUser;
                        }
                    }
                } catch (e) {
                    console.warn(`[WhatsApp] Cedula verification failed: ${e.message}`);
                }
            }
            if (!user) {
                console.warn(`[WhatsApp] User '${sessionUser.username}' not found in queryTenant=${queryTenantId}; using sessionTenant user identity`);
                // Fall back to the session-tenant user so the conversation can continue.
                user = sessionUser;
            }
        } else {
            user = await this.userRepo.findById(session.userId);
        }
        if (!user) {
            await this._sendReply(from, MESSAGES.NOT_LINKED);
            return;
        }

        const userRoles = (user.roles || []).map(r => r.id || r.rol_id || r);

            // DIRECT MCP ROUTING: For queries coming from WhatsApp we should
            // prefer the MCP pipeline (same functions used by DatabaseQueryFragment.kt)
            // to ensure the DB schema persona and tool-calling behavior is used
            // instead of the generic LLM system prompt. This replicates the
            // client behaviour and avoids classifier LLM contamination.
            // The query is routed to the MCP server that corresponds to queryTenantId
            // (which may be a remote Railway instance for a different institution).
            try {
                const canUseMCP = Boolean(this.mcpService) || Boolean(getTenantMcpServerUrl(queryTenantId));
                const looksLikeDbQuery = this._isMCPIntent(text) || (this.mcpService && typeof this.mcpService.isBusinessIntent === 'function' && this.mcpService.isBusinessIntent(text));
                // Allow teachers (2) and admins (3) to use MCP queries from WhatsApp.
                const roleAllows = userRoles.includes(3) || userRoles.includes(4) || userRoles.includes(2);

                // If the user is asking for an Excel, PDF, or email, skip the direct MCP
                // shortcut entirely — let intent classification route the message
                // to _handleGeneralQuestion (which calls _maybeHandleExcel/_maybeHandlePdf first).
                const isExcelRequest = /\bexcel\b/i.test(text);
                const isPdfRequest   = /\bpdf\b/i.test(text);
                const isEmailRequest = this._isEmailIntent(text);

                if (canUseMCP && !isExcelRequest && !isPdfRequest && !isEmailRequest && (roleAllows || looksLikeDbQuery)) {
                    let mcpResult = null;
                    try {
                        mcpResult = await this._callMcpForTenant(
                            text,
                            queryTenantId,
                            { userId: user.id, username: user.username, userRoles },
                        );
                    } catch (mErr) {
                        console.error('[WhatsApp] MCP direct call failed:', mErr && (mErr.message || mErr));
                        // fall through to normal classification/LLM path below
                        mcpResult = null;
                    }

                    if (mcpResult) {
                        try {
                            const payload = mcpResult.data ?? mcpResult.rows ?? mcpResult;
                            let replyText = '';
                            if (Array.isArray(payload) && payload.length > 0) {
                                const stripIds = (row) => {
                                    if (typeof row !== 'object' || row === null) return row;
                                    const cleaned = {};
                                    for (const [k, v] of Object.entries(row)) {
                                        if (/^id$|_id$/i.test(k)) continue;
                                        cleaned[k] = v;
                                    }
                                    return Object.keys(cleaned).length > 0 ? cleaned : row;
                                };
                                const sample = payload.slice(0, 10).map(r => (typeof r === 'string' ? r : JSON.stringify(stripIds(r)))).join('\n');
                                replyText = `Resultados (muestra hasta 10 filas):\n${sample}`;
                            } else if (typeof payload === 'object') {
                                replyText = JSON.stringify(payload, null, 2);
                            } else {
                                replyText = String(payload || 'No se encontraron datos.');
                            }
                            const chunks = truncateResponse(markdownToWhatsApp(replyText));
                            for (const chunk of chunks) {
                                await this._sendReply(from, chunk);
                            }
                            // update session context and persistence
                            session.addToContext('user', text);
                            session.addToContext('assistant', replyText.substring(0, 500));
                            await this.sessionRepo.update(session.id, {
                                conversation_context: session.conversationContext,
                                last_message_at: new Date().toISOString(),
                            });
                            // Already handled — stop further processing
                            return;
                        } catch (e) {
                            console.error('[WhatsApp] failed formatting MCP result:', e && (e.message || e));
                            // continue to normal flow in case formatting fails
                        }
                    }
                }
            } catch (e) {
                console.warn('[WhatsApp] error in direct MCP routing check:', e && (e.message || e));
            }

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
                const currentRole = userRoles.includes(3) || userRoles.includes(4) ? 'Admin' : userRoles.includes(2) ? 'Docente' : 'Estudiante';
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
                    case 'SEND_EMAIL':
                        response = await this._handleEmailRequest(text, user, userRoles, from);
                        break;
                    // grading is disabled for WhatsApp, so we never route aquí. If
                    // the intent somehow is set to GRADE_TASK we fall through to the
                    // general question handler as a safety measure.
                    case 'STUDENT_PROGRESS':
                        response = await this._handleStudentProgress(text, user, userRoles);
                        break;
                    case 'MCP_QUERY':
                        response = await this._handleMCPQuery(text, user, userRoles);
                        break;
                    case 'MY_PROGRESS':
                        response = await this._handleMyProgress(user);
                        break;
                    case 'MY_INSTITUTIONS':
                        response = await this._handleMyInstitutions(user);
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

            // Sanitize LLM/handler output to WhatsApp-friendly formatting
            const safeResponse = this._sanitizeForWhatsApp(response);
            const chunks = truncateResponse(safeResponse);
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
        const canUseMCP = userRoleIds.includes(3) || userRoleIds.includes(4);

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

        // 7. Enviar OTP
        try {
            await this._sendOtp(normalized, otpCode);
            console.log('[WhatsApp] OTP enviado a', normalized);
        } catch (err) {
            return this._mapOtpSendError(err);
        }

        return Result.ok({
            sessionId: session?.id,
            phoneNumber: normalized,
            message: 'Código de verificación enviado a WhatsApp',
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
        const canUseMCPAfterVerify = updatedRoleIds.includes(3) || updatedRoleIds.includes(4);

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
        const sessionsBeforeDelete = typeof this.sessionRepo.findAllByUserId === 'function'
            ? await this.sessionRepo.findAllByUserId(userId)
            : [await this.sessionRepo.findByUserId(userId)].filter(Boolean);
        const session = sessionsBeforeDelete[0] || null;

        // Enviar mensaje de despedida en fire-and-forget para no bloquear la respuesta.
        // Los errores de envío son ignorados — la eliminación procede igual.
        if (session?.phoneNumber && session.isActive) {
            if (this._isYCloudEnabled()) {
                this._sendViaYCloud(session.phoneNumber, MESSAGES.UNLINKED)
                    .then(resp => console.log('[WhatsApp] Sent unlink message via YCloud:', resp && (resp.messageId || resp)))
                    .catch(e => console.warn('[WhatsApp] Unlink via YCloud failed (fire-and-forget):', e && (e.message || e)));
            } else if (this.whatsAppPort) {
                this.whatsAppPort.sendTextMessage(session.phoneNumber, MESSAGES.UNLINKED)
                    .then(r => console.log('[WhatsApp] Sent unlink via Meta:', r && r.messageId))
                    .catch(e => console.warn('[WhatsApp] Unlink via Meta failed (fire-and-forget):', e && (e.message || e)));
            }
        }

        // Eliminar la sesión del usuario (hard delete).
        // deleteByUserId intenta primero el RPC SECURITY DEFINER (bypasses RLS)
        // y cae al cliente JS si el RPC no está disponible.
        let deletedCount = 0;
        try {
            deletedCount = await this.sessionRepo.deleteByUserId(userId);
            console.log(`[WhatsApp] unlinkAccount: deleteByUserId returned deletedCount=${deletedCount} for userId=${userId}`);
        } catch (err) {
            console.error('[WhatsApp] unlinkAccount: failed to delete session for userId:', userId, err && err.message);
            return Result.fail(new Error('No se pudo desvincular WhatsApp. Intenta de nuevo.'));
        }

        // Verificar que la sesión realmente se eliminó.
        // Si deleteByUserId retornó 0 filas pero la sesión todavía existe y está
        // activa, intentar desactivación como fallback de último recurso.
        const sessionsAfterDelete = typeof this.sessionRepo.findAllByUserId === 'function'
            ? await this.sessionRepo.findAllByUserId(userId)
            : [await this.sessionRepo.findByUserId(userId)].filter(Boolean);
        const hasActiveSessionsAfterDelete = sessionsAfterDelete.some((item) => item?.isActive);

        if (!hasActiveSessionsAfterDelete) {
            return Result.ok({ message: 'WhatsApp desvinculado correctamente' });
        }

        // La sesión sigue activa — el hard-delete falló (posible problema de
        // permisos/RLS). Intentar soft-delete como último recurso.
        console.warn(`[WhatsApp] unlinkAccount: session still active after delete for userId=${userId} (deletedCount=${deletedCount}) — trying deactivate fallback`);
        try {
            await this.sessionRepo.deactivate(userId);
        } catch (deactivateErr) {
            console.error('[WhatsApp] unlinkAccount: deactivate fallback failed:', deactivateErr && deactivateErr.message);
            return Result.fail(new Error('No se pudo desvincular WhatsApp. Intenta de nuevo.'));
        }

        const sessionsFinal = typeof this.sessionRepo.findAllByUserId === 'function'
            ? await this.sessionRepo.findAllByUserId(userId)
            : [await this.sessionRepo.findByUserId(userId)].filter(Boolean);
        const hasActiveSessionsFinal = sessionsFinal.some((item) => item?.isActive);
        if (hasActiveSessionsFinal) {
            console.error('[WhatsApp] unlinkAccount: session STILL active after deactivate for userId:', userId, '— RLS/permission issue persists');
            return Result.fail(new Error('No se pudo desvincular WhatsApp. Verifica permisos o contacta al soporte.'));
        }

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
        if (text.startsWith('/pdf')) return { intent: 'GENERAL_QUESTION', requiresRole: 'teacher' };
        if (text.startsWith('/mi_progreso')) return { intent: 'MY_PROGRESS', requiresRole: null };
        if (text.startsWith('/mis_instituciones')) return { intent: 'MY_INSTITUTIONS', requiresRole: null };

        // 1b. Heuristic: email send request
        if (this._isEmailIntent(text)) return { intent: 'SEND_EMAIL', requiresRole: null };

        // 1c. Heuristic: institution lookup question
        if (this._isInstitutionLookupIntent(text)) return { intent: 'MY_INSTITUTIONS', requiresRole: null };

        // 2. Detección explícita de intención de calificar — en casos ambiguos
        // consultamos al LLM para evitar falsos positivos.  Palabras que indican
        // posibilidad de intento de asignar nota.
        const gradingIndicators = ['calificar', 'califica', 'calificado', 'calificó', 'califico', 'asignar nota', 'dar nota', 'poner nota'];
        const hasGradingIndicator = gradingIndicators.some(k => text.includes(k));

        if (hasGradingIndicator && this.llmService && typeof this.llmService.processPrompt === 'function') {
            try {
                const prompt = `Eres un clasificador de intención. Has recibido el siguiente mensaje de WhatsApp: "${message.trim()}"\n\nResponde SOLO con una de estas etiquetas exactas:\n- ASSIGN_GRADE (si la intención es asignar o modificar una nota a un estudiante)\n- QUERY_ABOUT_GRADES (si la intención es preguntar sobre conteos, estadísticas o historiales de calificaciones)\n- OTHER (ninguna de las anteriores).`;
                const result = await this.llmService.processPrompt({ prompt, userId: null, fastMode: true });
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
                    if (userRoles.includes(2) || userRoles.includes(3) || userRoles.includes(4)) {
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
            if (userRoles.includes(2) || userRoles.includes(3) || userRoles.includes(4)) {
                return { intent: 'STUDENT_PROGRESS', requiresRole: 'teacher' };
            }
            return { intent: 'MY_PROGRESS', requiresRole: null };
        }

        // 4. Consulta MCP (solo admin)
        if (this._isMCPIntent(text) && (userRoles.includes(3) || userRoles.includes(4))) {
            return { intent: 'MCP_QUERY', requiresRole: 'admin' };
        }

        // 5. Fallback: pregunta general al LLM
        return { intent: 'GENERAL_QUESTION', requiresRole: null };
    }



    _isProgressIntent(text) {
        const keywords = ['progreso', 'avance', 'cómo van', 'como van', 'mi progreso'];
        return keywords.some(kw => text.includes(kw));
    }

    /**
     * Detects if the message is a request to send an email to someone.
     * Matches patterns like:
     *   "envíale a X@y.com un correo con..."
     *   "manda un correo a X@y.com con un excel..."
     *   "envía un email/gmail a X@y.com..."
     */
    _isEmailIntent(text) {
        const hasEmailKeyword = /\b(correo|email|gmail|mail)\b/i.test(text);
        const hasEmailAddress = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/.test(text);
        const hasSendVerb = /\b(env[ií]a(?:le)?|manda(?:le)?|remite|enviar|mandar)\b/i.test(text);
        return (hasSendVerb && hasEmailKeyword) || (hasSendVerb && hasEmailAddress) || (hasEmailAddress && hasEmailKeyword);
    }

    /**
     * Parses an email request from natural language text.
     * Extracts recipient address, attachment type, and content description.
     * @param {string} text
     * @returns {{ recipientEmail: string|null, attachmentType: 'excel'|'pdf'|null, contentDescription: string }}
     */
    _parseEmailRequest(text) {
        const emailMatch = text.match(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/);
        const recipientEmail = emailMatch ? emailMatch[1] : null;

        const wantsExcel = /\bexcel\b/i.test(text);
        const wantsPdf   = /\bpdf\b/i.test(text);
        const attachmentType = wantsExcel ? 'excel' : wantsPdf ? 'pdf' : null;

        // Strip routing/send parts to get the core content description
        let contentDescription = text
            .replace(/env[ií]a(?:le)?(?:\s+a)?\s+[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/gi, '')
            .replace(/manda(?:le)?(?:\s+a)?\s+[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/gi, '')
            .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '')
            .replace(/\bpor\s+(?:correo|email|gmail|mail)\b/gi, '')
            .replace(/\bun\s+(?:correo|email|gmail|mail)\s+con\b/gi, '')
            .replace(/\bun\s+excel\b/gi, '')
            .replace(/\bun\s+pdf\b/gi, '')
            .replace(/\bun\s+archivo\b/gi, '')
            .replace(/\benv[ií]a(?:le)?\b/gi, '')
            .replace(/\bmanda(?:le)?\b/gi, '')
            .replace(/\bdile?\s+(?:a\s+)?/gi, '')
            .replace(/\benv[ií]ale\s+(?:a\s+)?/gi, '')
            .replace(/^[\s,]+|[\s,]+$/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();

        return { recipientEmail, attachmentType, contentDescription };
    }

    /**
     * Builds a branded HTML email body.
     * @param {string} senderName
     * @param {string|null} title
     * @param {string} body  — May be raw text or an HTML snippet.
     * @returns {string}
     */
    _buildEmailHtml(senderName, title, body) {
        const escapedTitle = title ? String(title).replace(/</g, '&lt;').replace(/>/g, '&gt;') : null;
        const bodyContent  = String(body || '').trim();
        const dateStr = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
        return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background:linear-gradient(135deg,#7C3AED 0%,#4F46E5 100%);padding:28px 40px;">
          <span style="color:#fff;font-size:20px;font-weight:700;">CourseV</span>
        </td></tr>
        ${escapedTitle ? `<tr><td style="padding:24px 40px 0;"><span style="font-size:18px;font-weight:700;color:#111827;">${escapedTitle}</span></td></tr>` : ''}
        <tr><td style="padding:20px 40px;color:#374151;font-size:15px;line-height:1.7;">${bodyContent}</td></tr>
        <tr><td style="padding:16px 40px;border-top:1px solid #E5E7EB;font-size:12px;color:#9CA3AF;">
          Enviado por ${String(senderName).replace(/</g, '&lt;')} vía CourseV Platform · ${dateStr} COT
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
    }

    /**
     * Handler: envío de correo electrónico con contenido opcional (Excel, PDF, texto).
     * Triggered when the user asks to send an email to someone from WhatsApp.
     * @param {string}   text       Sanitized incoming message text.
     * @param {object}   user       Resolved user.
     * @param {number[]} userRoles  User role IDs.
     * @param {string|null} from   Sender phone (E.164), used for PDF generation.
     * @returns {Promise<string>}
     */
    async _handleEmailRequest(text, user, userRoles = [], from = null) {
        if (!this.emailService) {
            return '❌ Servicio de correo no configurado en el servidor.';
        }

        const { recipientEmail, attachmentType, contentDescription } = this._parseEmailRequest(text);

        if (!recipientEmail) {
            return '❌ No encontré una dirección de correo válida.\nEjemplo: _"envíale a usuario@dominio.com un correo con un excel del top 10 de docentes"_';
        }

        // Validate email format (defense-in-depth; SMTP rejects invalid ones anyway)
        if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(recipientEmail)) {
            return `❌ La dirección *${recipientEmail}* no parece válida.`;
        }

        const senderName = user?.username || 'Usuario CourseV';
        const attachments = [];
        let bodyHtml = '';
        let subject  = `Reporte CourseV — ${new Date().toLocaleDateString('es-CO')}`;
        let confirmMsg = '';

        try {
            if (attachmentType === 'excel') {
                if (!this._hasPermission(userRoles, 'teacher')) {
                    return '❌ Solo docentes y administradores pueden generar archivos Excel.';
                }
                if (!this.excelService) {
                    return '❌ Servicio de Excel no disponible.';
                }
                const q = contentDescription || text;
                console.log(`[WhatsApp] email+Excel request — query: "${q}" → to: ${recipientEmail}`);

                // Try LLM pipeline first; fall back to MCP (same as _maybeHandleExcel)
                let resolvedData = null;
                const { rawData } = await this._fetchReportData(q, user, userRoles);
                if (rawData && rawData.length > 0) {
                    resolvedData = rawData;
                } else {
                    console.warn('[WhatsApp] email+Excel: LLM did not return rawQueryData, falling back to MCP generateFromQuery');
                    const gen = await this.excelService.generateFromQuery({ query: q, userId: user.id, username: user?.username, userRoles });
                    if (gen && gen.isOk && gen.isOk()) {
                        const v = gen.getValue();
                        if (v.data && v.data.length > 0) resolvedData = v.data;
                    }
                }

                if (!resolvedData || resolvedData.length === 0) {
                    return '❌ No se encontraron datos para generar el Excel. Intenta con una consulta más específica.';
                }

                const buffer = await this.excelService.buildBuffer(resolvedData, q, senderName);
                attachments.push({
                    filename: `reporte_${Date.now()}.xlsx`,
                    content: buffer,
                    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                });
                subject   = `Reporte Excel CourseV — ${q.slice(0, 60)}`;
                bodyHtml  = this._buildEmailHtml(
                    senderName,
                    'Reporte Excel adjunto',
                    `<p>Se adjunta el archivo Excel con <strong>${resolvedData.length} registros</strong> correspondientes a la consulta:</p><p style="background:#F5F3FF;padding:12px 16px;border-radius:8px;font-style:italic;">${q}</p>`,
                );
                confirmMsg = `✅ Correo enviado a *${recipientEmail}* con el Excel de ${resolvedData.length} registros.`;

            } else if (attachmentType === 'pdf') {
                if (!this._hasPermission(userRoles, 'teacher')) {
                    return '❌ Solo docentes y administradores pueden generar archivos PDF.';
                }
                if (!this.pdfService) {
                    return '❌ Servicio de generación de PDF no disponible.';
                }
                const q = contentDescription || text;
                console.log(`[WhatsApp] email+PDF request — query: "${q}" → to: ${recipientEmail}`);

                // Generate PDF using same pipeline as _maybeHandlePdf but WITHOUT
                // sending chart images to the WhatsApp chat (email flow, not chat flow).
                const { rawData } = await this._fetchReportData(q, user, userRoles);
                let pdfResult;
                if (rawData && rawData.length > 0) {
                    const isAnalysis = this._isAnalysisRequest(q);
                    if (isAnalysis) {
                        const analysisText = await this._generateAnalysisText(q, rawData, user, userRoles);
                        pdfResult = await this.pdfService.buildAnalyticalReport({
                            data: rawData, query: q, analysisText: analysisText || '',
                            userId: user.id, username: user.username,
                        });
                    } else {
                        pdfResult = await this.pdfService.buildFromRawData({
                            data: rawData, userId: user.id, username: user.username, query: q,
                        });
                    }
                } else {
                    pdfResult = await this.pdfService.generateFromQuery({
                        query: q, userId: user.id, username: user?.username, userRoles,
                    });
                }

                if (!pdfResult || !pdfResult.isOk || !pdfResult.isOk()) {
                    const err = pdfResult?.getError?.();
                    const msg = err?.message || (typeof err === 'string' ? err : 'No se pudo generar el PDF.');
                    return `❌ ${msg}`;
                }

                const { url: pdfUrl, rows: pdfRows } = pdfResult.getValue();

                // Fetch the PDF buffer from the uploaded URL to send as a real attachment.
                // Falls back to a URL link if the fetch fails (e.g. network timeout).
                let pdfBuffer = null;
                try {
                    const fetchTimeoutMs = Number(process.env.PDF_FETCH_TIMEOUT_MS || 20000);
                    const pdfCtrl = new AbortController();
                    const pdfTimer = setTimeout(() => pdfCtrl.abort(), fetchTimeoutMs);
                    const pdfResp = await fetch(pdfUrl, { signal: pdfCtrl.signal });
                    clearTimeout(pdfTimer);
                    if (pdfResp.ok) {
                        const arrayBuf = await pdfResp.arrayBuffer();
                        pdfBuffer = Buffer.from(arrayBuf);
                    }
                } catch (fetchErr) {
                    console.warn('[WhatsApp] email+PDF: could not fetch buffer for attachment:', fetchErr.message);
                }

                subject = `Reporte PDF CourseV — ${q.slice(0, 60)}`;
                if (pdfBuffer) {
                    attachments.push({
                        filename: `reporte_${Date.now()}.pdf`,
                        content: pdfBuffer,
                        contentType: 'application/pdf',
                    });
                    bodyHtml = this._buildEmailHtml(
                        senderName,
                        'Reporte PDF adjunto',
                        `<p>Se adjunta el reporte PDF con <strong>${pdfRows} registros</strong> correspondientes a la consulta:</p>`
                        + `<p style="background:#F5F3FF;padding:12px 16px;border-radius:8px;font-style:italic;">${q}</p>`
                        + `<p>También disponible en línea: <a href="${pdfUrl}" style="color:#7C3AED;">${pdfUrl}</a></p>`,
                    );
                    confirmMsg = `✅ Correo enviado a *${recipientEmail}* con el PDF adjunto (${pdfRows} registros).`;
                } else {
                    // Buffer fetch failed — send URL link as fallback
                    bodyHtml = this._buildEmailHtml(
                        senderName,
                        'Reporte PDF',
                        `<p>Tu reporte PDF con <strong>${pdfRows} registros</strong> está disponible en:</p>`
                        + `<p><a href="${pdfUrl}" style="color:#7C3AED;">${pdfUrl}</a></p>`
                        + `<p style="background:#F5F3FF;padding:12px 16px;border-radius:8px;font-style:italic;">Consulta: ${q}</p>`,
                    );
                    confirmMsg = `✅ Correo enviado a *${recipientEmail}* con el enlace al PDF (${pdfRows} registros).`;
                }

            } else {
                // Plain text / general email — compose body via LLM when available
                let composedBody = contentDescription || text;
                if (this.llmService && typeof this.llmService.processPrompt === 'function') {
                    try {
                        // Pass the FULL original text so the LLM can faithfully reproduce
                        // the user's exact request without losing context during stripping.
                        const userRequest = (contentDescription && contentDescription.length > 15)
                            ? contentDescription
                            : text;
                        const prompt = `El usuario de WhatsApp te pidió exactamente esto: "${userRequest}". Tu tarea es redactar el cuerpo de ese correo fielmente a lo que pidió, de parte de ${senderName} (plataforma CourseV), dirigido a ${recipientEmail}. Sé fiel y específico al pedido. Responde ÚNICAMENTE con el cuerpo del correo en HTML bien formateado. No incluyas el asunto, encabezados tipo "Asunto:", ni explicaciones. Máximo 300 palabras.`;
                        const llmResult = await this.llmService.processPrompt({ prompt, userId: null, fastMode: true });
                        if (llmResult?.isOk?.()) {
                            const val = llmResult.getValue();
                            const llmText = typeof val === 'string' ? val : (val?.response || val?.text || '');
                            if (llmText && llmText.trim().length > 20) composedBody = llmText.trim();
                        }
                    } catch (e) {
                        console.warn('[WhatsApp] LLM email compose failed:', e.message);
                    }
                }
                subject   = `Mensaje de CourseV — ${senderName}`;
                bodyHtml  = this._buildEmailHtml(senderName, null, composedBody);
                confirmMsg = `✅ Correo enviado a *${recipientEmail}*.`;
            }

            const result = await this.emailService.sendEmail({ to: recipientEmail, subject, html: bodyHtml, attachments });
            if (!result.success) {
                console.error('[WhatsApp] email send failed:', result.error);
                return `❌ No se pudo enviar el correo: ${result.error || 'error desconocido'}.`;
            }
            return confirmMsg;

        } catch (e) {
            console.error('[WhatsApp] _handleEmailRequest error:', e.message || e);
            return '❌ Ocurrió un error al enviar el correo. Inténtalo de nuevo.';
        }
    }

    _isInstitutionLookupIntent(text) {
        return /\b(cu[aá]ntas?\s+instituciones|en\s+qu[eé]\s+instituciones|mis\s+instituciones|instituciones\s+pertenezco|instituciones\s+estoy|a\s+qu[eé]\s+instituciones|pertenezco\s+a\s+(?:cu[aá]ntas?|qu[eé])\s+instituciones)\b/i.test(text);
    }

    _isMCPIntent(text) {
        const keywords = ['cuántos', 'cuantos', 'listar', 'mostrar', 'select', 'consultar bd', 'base de datos'];
        return keywords.some(kw => text.includes(kw));
    }

    _hasPermission(userRoles, required) {
        if (required === 'admin') return userRoles.includes(3) || userRoles.includes(4);
        if (required === 'teacher') return userRoles.includes(2) || userRoles.includes(3) || userRoles.includes(4);
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
    // string if the user asked for an Excel file (roles 2 and 3) or `null` when the
    // message does not refer to Excel and normal handling should continue.
    /**
     * Fetches report data once via the BI LLM pipeline (or MCP fallback).
     * This is the SINGLE source of truth for all report formats (Excel, PDF, etc.),
     * ensuring every format receives the exact same rows from the exact same SQL query.
     *
     * @param {string}   q         Clean business query (format keywords already stripped).
     * @param {object}   user      Resolved user.
     * @param {number[]} userRoles Role IDs.
     * @returns {Promise<{ rawData: object[]|null, source: 'llm'|'mcp' }>}
     */
    async _fetchReportData(q, user, userRoles) {
        // ── Step 1: LLM BI pipeline — same prompt used by the normal chat flow ──
        if (this.llmService) {
            const username = user?.username || 'usuario';
            const biPrompt = `CONSULTA DE BUSINESS INTELIGENCIA: ${q}\n\nINSTRUCCIONES:\nEres un experto en Business Intelligence y Marketing. Tu objetivo es analizar la base de datos y dar recomendaciones estratégicas.\n\n1. El esquema de la base de datos YA ESTÁ en tu contexto. NO llames a 'get_database_schema' (salvo que necesites confirmar la estructura de tablas).\n2. 📌 OBLIGATORIO: usa la herramienta 'query_database' para obtener métricas reales (usuarios, cursos, ventas, etc.). No inventes datos.\n   - Para invocarla, responde primero con un bloque JSON EXACTO:\n` +
                "```json\n" +
                "{\"tool\":\"query_database\",\"arguments\":{\"query\":\"<tu SQL aquí>\"}}\n" +
                "```\n" +
                `   Debes esperar a que el backend ejecute ese SQL y componer tu reporte utilizando la respuesta.\n\nIMPORTANTE: Basa tus respuestas en DATOS REALES de la base de datos. Si necesitas información real, llama a la herramienta "query_database" del agente MCP y espera su respuesta antes de concluir.\n\nREGLA DE PRESENTACIÓN — NUNCA MOSTRAR IDs NUMÉRICOS:\n- NUNCA muestres IDs numéricos (user_id, course_id, id, student_id, creator_user_id, topic_id, task_id, etc.).\n- NUNCA incluyas columnas de IDs en el SELECT de tus consultas SQL.\n- Para personas: muestra username o nombre (first_name, last_name). Haz JOIN con usuarios.\n- Para cursos: muestra título (title). Haz JOIN con courses.\n- Para temas: muestra nombre (name). Para tareas: muestra título (title).\n- Si una columna es FK (ej: creator_user_id, student_id, subscriber_id), haz JOIN con la tabla correspondiente y selecciona el campo legible.\n\n🎯 ¡Bienvenido/a, ${username}!`;

            const currentTenantId = getCurrentTenantId();
            const currentTenantCfg = currentTenantId ? TENANT_CONFIGS.find(t => t.id === currentTenantId) : null;
            const preferredModel = process.env.DEEPSEEK_MODEL || process.env.CHAT_MODEL || undefined;

            try {
                const llmResult = await this.llmService.processPrompt({
                    prompt: biPrompt,
                    model: preferredModel,
                    userId: user.id,
                    username: user.username,
                    userRoles,
                    fromWhatsApp: true,
                    forceMCPTools: true,
                    tenantId: currentTenantId,
                    institutionName: currentTenantCfg?.name || null,
                    fastMode: true,
                });

                if (llmResult && llmResult.isOk && llmResult.isOk()) {
                    const rawData = llmResult.getValue()?.rawQueryData;
                    if (Array.isArray(rawData) && rawData.length > 0) {
                        console.log(`[WhatsApp] _fetchReportData: LLM returned ${rawData.length} rows`);
                        return { rawData, source: 'llm' };
                    }
                }
                console.warn('[WhatsApp] _fetchReportData: LLM did not return rawQueryData, falling back to MCP');
            } catch (e) {
                console.warn('[WhatsApp] _fetchReportData: LLM call failed, falling back to MCP:', e.message);
            }
        }

        // ── Step 2: MCP fallback ───────────────────────────────────────────────
        return { rawData: null, source: 'mcp' };
    }

    async _maybeHandleExcel(text, user, userRoles = []) {
        if (!/\bexcel\b/i.test(text)) return null;

        if (!this._hasPermission(userRoles, 'teacher')) {
            return '❌ Solo docentes y administradores pueden generar archivos Excel.';
        }
        if (!this.excelService) {
            return '❌ Servicio de generación de Excel no disponible.';
        }

        let q = text.replace(/^\/excel\s*/i, '');
        q = q.replace(/\bexcel\b/gi, '').trim();
        q = q.replace(/dame un\s+excel/gi, '').trim();
        if (!q) {
            return '❌ Debes indicar qué datos quieres en el Excel. Ejemplo: "/excel usuarios activos"';
        }
        console.log('[WhatsApp] Excel query sanitized to:', q);

        try {
            const { rawData, source } = await this._fetchReportData(q, user, userRoles);

            if (rawData) {
                console.log(`[WhatsApp] Excel: using ${rawData.length} rows from ${source}`);
                const gen = await this.excelService.buildFromRawData({
                    data: rawData,
                    userId: user.id,
                    username: user.username,
                    query: q,
                });
                if (gen && gen.isOk && gen.isOk()) {
                    const v = gen.getValue();
                    return `✅ Excel generado: ${v.url} (filas: ${v.rows})`;
                }
            }

            // MCP fallback: no rawData from LLM
            const gen = await this.excelService.generateFromQuery({ query: q, userId: user.id, username: user?.username, userRoles });
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

            // early exit for pdf requests
            const pdfResp = await this._maybeHandlePdf(text, user, userRoles, session.phoneNumber || null);
            if (pdfResp !== null) return pdfResp;

            // early exit for excel requests
            const excelResp = await this._maybeHandleExcel(text, user, userRoles);
            if (excelResp !== null) return excelResp;

            // Decide whether the Business‑Intelligence persona should be used.
            // Admins always get the BI persona now (see requirement), non-admins get
            // generic chat.
            const isAdmin = Array.isArray(userRoles) && (userRoles.includes(3) || userRoles.includes(4));
            const context = session.conversationContext || [];

            let promptToSend = text;
            let forceTools = false;

            // Always instruct the model not to grade tasks when queries come from
            // WhatsApp. This channel is for open-ended Q&A only.
            const usernameTag = user?.username ? `[Usuario: ${user.username}] ` : '';
            promptToSend = `${usernameTag}Por favor responde como un asistente general. NO califiques tareas ni asumas el rol de evaluador.\n\n${promptToSend}`;

            // For administrators we always engage the Business Intelligence persona
            // that mirrors the behaviour of DatabaseQueryFragment.kt.  This means every
            // message is sent to the LLM with instructions to use `query_database` when
            // appropriate and to format results as a BI report.
            // Teachers (role 2) also get the BI persona so they can query their students'
            // progress, grades, and reinforcement practice — scoped to their collaborator subjects.
            const isTeacher = Array.isArray(userRoles) && userRoles.includes(2);
            if (isAdmin || isTeacher) {
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
                    `\n\n## Acción inmediata\n[Acción concreta]\n\nIMPORTANTE: Basa tus respuestas en DATOS REALES de la base de datos. Si necesitas información real, llama a la herramienta \"query_database\" del agente MCP y espera su respuesta antes de concluir.\n\nREGLA DE PRESENTACIÓN — NUNCA MOSTRAR IDs NUMÉRICOS:\n- NUNCA muestres IDs numéricos (user_id, course_id, id, student_id, creator_user_id, topic_id, task_id, etc.).\n- NUNCA incluyas columnas de IDs en el SELECT de tus consultas SQL.\n- Para personas: muestra username o nombre (first_name, last_name). Haz JOIN con usuarios.\n- Para cursos: muestra título (title). Haz JOIN con courses.\n- Para temas: muestra nombre (name). Para tareas: muestra título (title).\n- Si una columna es FK (ej: creator_user_id, student_id, subscriber_id), haz JOIN con la tabla correspondiente y selecciona el campo legible.\n- Ejemplo PROHIBIDO: \"Usuario 42\" o SELECT user_id FROM ...\n- Ejemplo CORRECTO: \"juanperez\" o SELECT u.username FROM ... JOIN usuarios u ON ...\n\n🎯 ¡Bienvenido/a, ${username}!`;
                promptToSend = biPrompt;
            }

            // Prefer DeepSeek model when configured (LLMDomainService will forward this to the infra adapter)
            const preferredModel = process.env.DEEPSEEK_MODEL || process.env.CHAT_MODEL || undefined;

            // Resolve institution context from the current AsyncLocalStorage tenant.
            const currentTenantId = getCurrentTenantId();
            const currentTenantCfg = currentTenantId ? TENANT_CONFIGS.find(t => t.id === currentTenantId) : null;
            const currentInstitutionName = currentTenantCfg?.name || null;

            const result = await this.llmService.processPrompt({
                prompt: promptToSend,
                model: preferredModel,
                conversationHistory: context.map(c => ({ role: c.role, content: c.content })),
                userId: user.id,
                username: user.username,
                userRoles,
                fromWhatsApp: true,
                // admins get BI tools via forceTools; all other WhatsApp users get scoped MCP access
                forceMCPTools: forceTools || !!user.id,
                // Institution context so the LLM knows which DB it is querying
                tenantId: currentTenantId,
                institutionName: currentInstitutionName,
                fastMode: true,
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
                                    const stripIds = (row) => {
                                        if (typeof row !== 'object' || row === null) return row;
                                        const cleaned = {};
                                        for (const [k, v] of Object.entries(row)) {
                                            if (/^id$|_id$/i.test(k)) continue;
                                            cleaned[k] = v;
                                        }
                                        return Object.keys(cleaned).length > 0 ? cleaned : row;
                                    };
                                    const sample = payload.slice(0, 10).map(r => JSON.stringify(stripIds(r))).join('\n');
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
            const courses = await this.courseRepo.findByCreatorUserId(userId);
            if (!courses || courses.length === 0) return false;

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
    async _handleStudentProgress(text, user, userRoles = []) {
        try {
            const pdfResp = await this._maybeHandlePdf(text, user, userRoles, null);
            if (pdfResp !== null) return pdfResp;

            const excelResp = await this._maybeHandleExcel(text, user, userRoles);
            if (excelResp !== null) return excelResp;

            if (!this.progressRepo || !this.courseRepo) {
                return 'El servicio de progreso no está disponible.';
            }

            const courses = await this.courseRepo.findByCreatorUserId(user.id);
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
     * Handler: ¿En cuántas instituciones estoy?
     * Searches the user's username across ALL tenant databases.
     */
    async _handleMyInstitutions(user) {
        try {
            const username = user?.username;
            if (!username) return '❌ No se pudo determinar tu nombre de usuario.';

            const entries = getAllTenantEntries();
            // Fetch matches + cedula hash to filter by same physical person
            const results = await Promise.allSettled(
                entries.map(async (entry) => {
                    if (!entry.client) return null;
                    const repo = new SupabaseUserRepository(entry.client);
                    const found = await repo.findByUsername(username);
                    if (!found) return null;
                    // Fetch persona cedula hash for identity verification
                    let cedulaHash = null;
                    try {
                        const personaId = found.persona_id ?? found.personas?.id ?? found.persona?.id ?? null;
                        if (personaId) {
                            const personaRepo = new SupabasePersonaRepository(entry.client);
                            const persona = await personaRepo.findById(personaId);
                            cedulaHash = persona?.identificacion_original ?? null;
                        }
                    } catch { /* ignore */ }
                    return {
                        tenantName: entry.name,
                        roles: (found.roles || []).map(r => r.nombre || r.name || r.id || r),
                        cedulaHash,
                    };
                }),
            );
            const allFound = results
                .filter(r => r.status === 'fulfilled' && r.value !== null)
                .map(r => r.value);

            // Filter: only include tenants where the cedula matches the current user's persona
            let currentCedula = null;
            try {
                const personaId = user.persona_id ?? user.personas?.id ?? user.persona?.id ?? null;
                if (personaId) {
                    const personaRepo = new SupabasePersonaRepository(getTenantClient(getCurrentTenantId()));
                    const persona = await personaRepo.findById(personaId);
                    currentCedula = persona?.identificacion_original ?? null;
                }
            } catch { /* ignore */ }
            const found = currentCedula
                ? allFound.filter(f => !f.cedulaHash || f.cedulaHash === currentCedula)
                : allFound;

            if (found.length === 0) {
                return `No se encontró el usuario *${username}* en ninguna institución registrada.`;
            }
            const list = found.map((f, i) =>
                `${i + 1}. *${f.tenantName}* — Roles: ${Array.isArray(f.roles) && f.roles.length > 0 ? f.roles.join(', ') : 'Sin roles'}`,
            ).join('\n');
            return `🏛️ El usuario *${username}* está registrado en *${found.length}* institución(es):\n\n${list}`;
        } catch (error) {
            console.error('[WhatsApp] Error in institution lookup:', error.message);
            return '❌ Error al buscar instituciones. Intenta de nuevo.';
        }
    }

    /**
     * Handler: Consultas MCP (solo admin, rol 3).
     * Usa MCPDomainService.processQuery() existente, enrutando al servidor
     * MCP que corresponde a la institución del usuario (getCurrentTenantId).
     */
    async _handleMCPQuery(text, user, userRoles = []) {
        try {
            const tenantId = getCurrentTenantId() || 'qa-develop';
            const hasMcpCapability = Boolean(this.mcpService) || Boolean(getTenantMcpServerUrl(tenantId));
            if (!hasMcpCapability) return 'El servicio MCP no está disponible.';

            // check that caller has admin role just in case (intent logic should
            // have already enforced this).
            if (!this._hasPermission(userRoles, 'admin')) {
                return '❌ Solo administradores pueden usar consultas MCP o generar Excel.';
            }

            // Check for Excel requests BEFORE running the MCP query.
            const excelResp = await this._maybeHandleExcel(text, user, userRoles);
            if (excelResp !== null) return excelResp;

            // Extraer la consulta (quitar el prefijo /consulta si existe)
            let query = text.replace(/^\/consulta\s*/i, '').trim();
            if (!query) return 'Por favor, indica qué deseas consultar.\nEjemplo: /consulta cuántos usuarios hay';

            // Verificar inyección SQL peligrosa
            if (containsSQLInjection(query)) {
                return '❌ Consulta no permitida. Solo se permiten consultas de lectura (SELECT).';
            }

            let result;
            try {
                result = await this._callMcpForTenant(
                    query,
                    tenantId,
                    { userId: user.id, username: user.username, userRoles },
                );
            } catch (e) {
                console.error('[WhatsApp] MCP processQuery failed:', e && (e.message || e));
                return '❌ Error al ejecutar la consulta. Intenta con otra formulación.';
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

    // ═══════════════════════════════════════════════════════════
    // PDF — solicitud de reporte con gráfica
    // ═══════════════════════════════════════════════════════════

    /**
     * Detecta si el texto es una solicitud de ANÁLISIS (no solo descarga de datos).
     * Ejemplo: "análisis de los cursos comprados", "informe de ventas"
     */
    _isAnalysisRequest(text) {
        return /\b(an[áa]lisis|analiza(?:r)?|informe|análisis\s+de|analiza\s+la|reporte\s+de\s+an[áa]lisis)\b/i.test(text);
    }

    /**
     * Llama al LLM para generar texto de análisis ejecutivo a partir de datos ya obtenidos.
     * No hace consultas a la BD — recibe los datos como parámetro.
     * @returns {Promise<string|null>} Texto en Markdown o null si falla.
     */
    async _generateAnalysisText(q, data, user, userRoles) {
        if (!this.llmService) return null;
        try {
            const sample = JSON.stringify(data.slice(0, 50), null, 2);
            const analysisPrompt =
                `Eres un experto en Business Intelligence y análisis de datos educativos.\n` +
                `Se te proporcionan los siguientes datos reales de la consulta: "${q}"\n\n` +
                `DATOS:\n${sample}\n\n` +
                `Escribe un análisis ejecutivo completo en español. El análisis debe:\n` +
                `1. Ser argumentado y profundo, no solo una lista de hechos.\n` +
                `2. Incluir porcentajes y números específicos de los datos.\n` +
                `3. Identificar tendencias, patrones y anomalías.\n` +
                `4. Proporcionar recomendaciones estratégicas concretas.\n\n` +
                `Usa EXACTAMENTE este formato con estas secciones:\n\n` +
                `## Resumen ejecutivo\n[Descripción breve de los hallazgos más importantes]\n\n` +
                `## Hallazgos principales\n- [Hallazgo con número concreto]\n- [Hallazgo con número concreto]\n\n` +
                `## Análisis detallado\n[Análisis profundo de patrones y tendencias]\n\n` +
                `## Recomendaciones estratégicas\n1. [Recomendación concreta]\n2. [Recomendación concreta]\n\n` +
                `## Conclusiones\n[Síntesis del análisis y el impacto esperado]\n\n` +
                `IMPORTANTE: Basa el análisis ÚNICAMENTE en los datos proporcionados. No inventes cifras.`;

            const preferredModel = process.env.DEEPSEEK_MODEL || process.env.CHAT_MODEL || undefined;
            const result = await this.llmService.processPrompt({
                prompt: analysisPrompt,
                model: preferredModel,
                userId: user.id,
                username: user.username,
                userRoles,
                fromWhatsApp: true,
                forceMCPTools: false,
                fastMode: false,
            });

            if (result && result.isOk && result.isOk()) {
                const answer = result.getValue();
                return typeof answer === 'string'
                    ? answer
                    : (answer?.response || answer?.text || null);
            }
            return null;
        } catch (e) {
            console.warn('[WhatsApp] _generateAnalysisText failed:', e.message);
            return null;
        }
    }

    /**
     * Handles PDF report requests from WhatsApp.
     * Detects /pdf or messages containing "pdf" keyword.
     * Generates:
     *   1. A chart PNG image (via QuickChart.io) → sent directly as image in WhatsApp
     *   2. A styled PDF with data table + embedded chart → URL sent as text message
     *
     * Returns a string message (PDF URL) for the caller to forward, or null when the
     * message is not a PDF request.
     *
     * @param {string}   text       Sanitized incoming message text.
     * @param {object}   user       Resolved user object.
     * @param {number[]} userRoles  User role IDs.
     * @param {string|null} from   Sender phone (E.164). Used to send chart image inline.
     * @returns {Promise<string|null>}
     */
    async _maybeHandlePdf(text, user, userRoles = [], from = null) {
        if (!/\bpdf\b/i.test(text)) return null;

        if (!this._hasPermission(userRoles, 'teacher')) {
            return '❌ Solo docentes y administradores pueden generar reportes PDF.';
        }
        if (!this.pdfService) {
            return '❌ Servicio de generación de PDF no disponible.';
        }

        let q = text.replace(/^\/pdf\s*/i, '');
        q = q.replace(/\bpdf\b/gi, '').trim();
        q = q.replace(/dame un\s+pdf/gi, '').trim();
        q = q.replace(/genera(?:r)?\s+(?:un\s+)?reporte\s*/gi, '').trim();
        if (!q) {
            return '❌ Debes indicar qué datos quieres en el PDF. Ejemplo: "/pdf usuarios activos"';
        }
        console.log('[WhatsApp] PDF query sanitized to:', q);

        const isAnalysis = this._isAnalysisRequest(q);
        try {
            // Use the shared data-fetching pipeline — SAME query and SAME prompt as Excel
            // so both formats always produce identical row counts.
            const { rawData, source } = await this._fetchReportData(q, user, userRoles);

            let pdfResult;
            if (rawData) {
                console.log(`[WhatsApp] PDF: using ${rawData.length} rows from ${source}, isAnalysis=${isAnalysis}`);

                if (isAnalysis) {
                    // Generate LLM narrative analysis text, then build analytical PDF
                    const analysisText = await this._generateAnalysisText(q, rawData, user, userRoles);
                    pdfResult = await this.pdfService.buildAnalyticalReport({
                        data: rawData,
                        query: q,
                        analysisText: analysisText || '',
                        userId: user.id,
                        username: user.username,
                    });
                } else {
                    pdfResult = await this.pdfService.buildFromRawData({
                        data: rawData,
                        userId: user.id,
                        username: user.username,
                        query: q,
                    });
                }
            } else {
                // MCP fallback
                pdfResult = await this.pdfService.generateFromQuery({
                    query: q,
                    userId: user.id,
                    username: user?.username,
                    userRoles,
                });
            }

            if (!pdfResult || !pdfResult.isOk || !pdfResult.isOk()) {
                const err = pdfResult?.getError?.();
                const msg = err?.message || (typeof err === 'string' ? err : 'No se pudo generar el PDF.');
                return `❌ ${msg}`;
            }

            const val = pdfResult.getValue();
            const { url: pdfUrl, rows } = val;
            // buildAnalyticalReport returns chartUrls[], buildFromRawData returns chartUrl
            const chartUrls = val.chartUrls || (val.chartUrl ? [val.chartUrl] : []);

            // Send first chart image inline in WhatsApp
            if (chartUrls.length > 0 && from) {
                try {
                    await this._sendImage(from, chartUrls[0], `📊 Gráfica del reporte (${rows} registros)`);
                } catch (imgErr) {
                    console.warn('[WhatsApp] PDF: could not send chart image:', imgErr.message);
                }
            }

            const label = isAnalysis ? '📊 *Análisis PDF generado*' : '📄 *Reporte PDF generado*';
            return `${label} (${rows} registros):\n${pdfUrl}`;
        } catch (e) {
            console.error('[WhatsApp] PDF generation failed:', e);
            return '❌ Error generando PDF. Intenta de nuevo más tarde.';
        }
    }

    /**
     * Sends an image via WhatsApp (YCloud or Meta adapter).
     * @param {string} to      — E.164 number.
     * @param {string} url     — Public image URL.
     * @param {string} caption — Optional caption.
     */
    async _sendImage(to, url, caption = '') {
        // YCloud
        if (this._isYCloudEnabled()) {
            const fromNumber = process.env.YCLOUD_WHATSAPP_NUMBER || process.env.YCLOUD_PHONE;
            const instanceId = process.env.YCLOUD_INSTANCE_ID || process.env.YCLOUD_ID;
            const baseUrl    = (process.env.YCLOUD_BASE_URL || 'https://api.ycloud.com/v2').replace(/\/$/, '');
            const candidates = [];
            if (fromNumber) {
                candidates.push({
                    url: `${baseUrl}/whatsapp/messages/sendDirectly`,
                    payload: { from: fromNumber, to, type: 'image', image: { link: url, caption } },
                });
            }
            if (instanceId) {
                candidates.push({
                    url: `${baseUrl}/instances/${instanceId}/messages`,
                    payload: { to: to.replace(/^\+/, ''), type: 'image', image: { link: url, caption } },
                });
            }
            if (candidates.length) {
                try { return await this._ycloudPost(candidates); } catch {/* fall through */}
            }
        }
        // Meta adapter
        if (this.whatsAppPort && typeof this.whatsAppPort.sendImageMessage === 'function') {
            return this.whatsAppPort.sendImageMessage(to, url, caption);
        }
        // Fallback: send URL as text
        return this._sendReply(to, `${caption}\n${url}`.trim());
    }

    /**
     * Sends a document (PDF) via WhatsApp (YCloud or Meta adapter).
     * @param {string} to       — E.164 number.
     * @param {string} url      — Public document URL.
     * @param {string} filename — Displayed filename.
     * @param {string} caption  — Optional caption.
     */
    async _sendDocument(to, url, filename = 'reporte.pdf', caption = '') {
        // YCloud
        if (this._isYCloudEnabled()) {
            const fromNumber = process.env.YCLOUD_WHATSAPP_NUMBER || process.env.YCLOUD_PHONE;
            const instanceId = process.env.YCLOUD_INSTANCE_ID || process.env.YCLOUD_ID;
            const baseUrl    = (process.env.YCLOUD_BASE_URL || 'https://api.ycloud.com/v2').replace(/\/$/, '');
            const candidates = [];
            if (fromNumber) {
                candidates.push({
                    url: `${baseUrl}/whatsapp/messages/sendDirectly`,
                    payload: { from: fromNumber, to, type: 'document', document: { link: url, filename, caption } },
                });
            }
            if (instanceId) {
                candidates.push({
                    url: `${baseUrl}/instances/${instanceId}/messages`,
                    payload: { to: to.replace(/^\+/, ''), type: 'document', document: { link: url, filename, caption } },
                });
            }
            if (candidates.length) {
                try { return await this._ycloudPost(candidates); } catch {/* fall through */}
            }
        }
        // Meta adapter
        if (this.whatsAppPort && typeof this.whatsAppPort.sendDocumentMessage === 'function') {
            return this.whatsAppPort.sendDocumentMessage(to, url, filename, caption);
        }
        // Fallback: send URL as text
        return this._sendReply(to, `${caption}\n${url}`.trim());
    }

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

    /**
     * Sanitize LLM output for WhatsApp:
     * - Convert markdown bold **text** to WhatsApp bold *text*
     * - Convert markdown headings (# ...) to WhatsApp bold
     * - Remove any '#file:...' file tags the LLM may include
     * - Collapse excessive newlines
     */
    _sanitizeForWhatsApp(text) {
        if (!text) return text;
        let out = String(text);

        // Replace **bold** with *bold* (WhatsApp uses single asterisks)
        out = out.replace(/\*\*(.+?)\*\*/gs, '*$1*');

        // Convert markdown headings (# Heading) to bold: *Heading*
        out = out.replace(/^\s*#{1,6}\s*(.+)$/gm, '*$1*');

        // Remove any file tags like #file:WhatsAppDomainService.js or # file:...
        out = out.replace(/#\s*file:[^\s\n]+/gi, '');

        // Remove stray '#' characters used as inline markdown markers
        out = out.replace(/(^|\s)#(\S+)/g, '$1$2');

        // Collapse more than 2 consecutive newlines to 2
        out = out.replace(/\n{3,}/g, '\n\n');

        return out.trim();
    }
}

export default WhatsAppDomainService;

