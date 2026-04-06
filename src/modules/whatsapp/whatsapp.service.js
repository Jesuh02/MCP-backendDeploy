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
import { getAllTenantEntries, TENANT_CONFIGS, runInTenantContext, getTenantClient, getCurrentTenantId } from '../../config/tenantRegistry.js';
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
            try {
                const canUseMCP = Boolean(this.mcpService);
                const looksLikeDbQuery = this._isMCPIntent(text) || (this.mcpService && typeof this.mcpService.isBusinessIntent === 'function' && this.mcpService.isBusinessIntent(text));
                // Allow teachers (2) and admins (3) to use MCP queries from WhatsApp.
                const roleAllows = userRoles.includes(3) || userRoles.includes(2);

                // If the user is asking for an Excel file, skip the direct MCP
                // shortcut entirely — let intent classification route the message
                // to _handleGeneralQuestion (which calls _maybeHandleExcel first).
                const isExcelRequest = /\bexcel\b/i.test(text);

                if (canUseMCP && !isExcelRequest && (roleAllows || looksLikeDbQuery)) {
                    let mcpResult = null;
                    try {
                        if (typeof this.mcpService.processQueryWithAgent === 'function') {
                            mcpResult = await this.mcpService.processQueryWithAgent(text, { userId: user.id, username: user.username });
                        } else if (typeof this.mcpService.processQueryToData === 'function') {
                            mcpResult = await this.mcpService.processQueryToData(text, user.id);
                        } else if (typeof this.mcpService.processQuery === 'function') {
                            mcpResult = await this.mcpService.processQuery(text, { userId: user.id, username: user.username, includeSchema: true });
                        }
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
        if (text.startsWith('/mi_progreso')) return { intent: 'MY_PROGRESS', requiresRole: null };
        if (text.startsWith('/mis_instituciones')) return { intent: 'MY_INSTITUTIONS', requiresRole: null };

        // 1b. Heuristic: institution lookup question
        if (this._isInstitutionLookupIntent(text)) return { intent: 'MY_INSTITUTIONS', requiresRole: null };

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

    _isInstitutionLookupIntent(text) {
        return /\b(cu[aá]ntas?\s+instituciones|en\s+qu[eé]\s+instituciones|mis\s+instituciones|instituciones\s+pertenezco|instituciones\s+estoy|a\s+qu[eé]\s+instituciones|pertenezco\s+a\s+(?:cu[aá]ntas?|qu[eé])\s+instituciones)\b/i.test(text);
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
    // string if the user asked for an Excel file (roles 2 and 3) or `null` when the
    // message does not refer to Excel and normal handling should continue.
    async _maybeHandleExcel(text, user, userRoles = []) {
        if (!/\bexcel\b/i.test(text)) return null;

        if (!this._hasPermission(userRoles, 'teacher')) {
            return '❌ Solo docentes y administradores pueden generar archivos Excel.';
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

