/**
 * EmailAdapter — Implementa IEmailPort.
 * Proveedor principal: Resend API (100 emails/día, 3 000 emails/mes en free tier).
 * Fallback automático a Brevo SMTP cuando:
 *   - Se alcanzan 100 envíos diarios con Resend
 *   - Se alcanzan 3 000 envíos mensuales con Resend
 *   - Resend devuelve HTTP 429 (rate limit)
 *   - Cualquier error de Resend y Brevo está configurado
 * Brevo free: 300 emails/día.
 */
import nodemailer from 'nodemailer';

// Límites del plan free de Resend
const RESEND_DAILY_LIMIT   = 100;
const RESEND_MONTHLY_LIMIT = 3000;

export class EmailAdapter {
    constructor() {
        this.provider = null;
        // Contadores de cuota Resend (en memoria; se resetean con el proceso)
        this._quota = { day: 0, month: 0, dayKey: '', monthKey: '' };
        this._init();
    }

    // ── Helpers de cuota ────────────────────────────────────────────────────
    _todayKey()  { return new Date().toISOString().slice(0, 10); } // 'YYYY-MM-DD'
    _monthKey()  { return new Date().toISOString().slice(0, 7);  } // 'YYYY-MM'

    _syncQuotaKeys() {
        const today = this._todayKey();
        const month = this._monthKey();
        if (this._quota.dayKey   !== today) { this._quota.day   = 0; this._quota.dayKey   = today; }
        if (this._quota.monthKey !== month) { this._quota.month = 0; this._quota.monthKey = month; }
    }

    _resendOverQuota() {
        this._syncQuotaKeys();
        return this._quota.day >= RESEND_DAILY_LIMIT || this._quota.month >= RESEND_MONTHLY_LIMIT;
    }

    _tickResend() {
        this._syncQuotaKeys();
        this._quota.day++;
        this._quota.month++;
        console.log(`📊 Resend quota → día: ${this._quota.day}/${RESEND_DAILY_LIMIT}, mes: ${this._quota.month}/${RESEND_MONTHLY_LIMIT}`);
    }
    // ────────────────────────────────────────────────────────────────────────

    _init() {
        if (process.env.RESEND_API_KEY) {
            this.provider = 'resend';
            console.log('✅ EmailAdapter: Resend (principal) + Brevo (fallback de cuota)');
        } else if (process.env.BREVO_SMTP_USER && process.env.BREVO_SMTP_PASSWORD) {
            this.provider = 'brevo';
            console.log('✅ EmailAdapter: Brevo SMTP (principal)');
        } else {
            console.warn('⚠️ EmailAdapter: No email provider configured');
        }

        // Inicializar transporter Brevo siempre que existan credenciales
        if (process.env.BREVO_SMTP_USER && process.env.BREVO_SMTP_PASSWORD) {
            this._brevoTransporter = nodemailer.createTransport({
                host: 'smtp-relay.sendinblue.com', // cert TLS aún usa dominio Sendinblue
                port: 587,
                secure: false,
                auth: { user: process.env.BREVO_SMTP_USER, pass: process.env.BREVO_SMTP_PASSWORD },
            });
        }
    }

    async sendEmail({ to, subject, html, text }) {
        switch (this.provider) {
            case 'resend':
                return this._sendViaResend({ to, subject, html, text });
            case 'brevo':
                return this._sendViaBrevo({ to, subject, html, text });
            default:
                console.warn('EmailAdapter: No provider — email not sent');
                return { success: false, error: 'No email provider configured' };
        }
    }

    async _sendViaResend({ to, subject, html, text }) {
        // Ceder a Brevo si se supera la cuota del plan free
        if (this._resendOverQuota()) {
            console.warn(`⚠️  Resend cuota alcanzada (día=${this._quota.day}, mes=${this._quota.month}) → Brevo fallback`);
            return this._sendViaBrevo({ to, subject, html, text });
        }
        try {
            const { default: axios } = await import('axios');
            const from = process.env.EMAIL_FROM || 'CourseV@yisuscompany.com';
            const response = await axios.post(
                'https://api.resend.com/emails',
                { from, to: Array.isArray(to) ? to : [to], subject, html, text },
                { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' } },
            );
            this._tickResend();
            return { success: true, messageId: response.data?.id };
        } catch (err) {
            const status = err.response?.status;
            console.error('EmailAdapter Resend error:', err.response?.data || err.message);
            // 429 = cuota agotada en Resend → Brevo fallback
            if (status === 429 || err.response?.data?.statusCode === 429) {
                console.warn('⚠️  Resend HTTP 429 → Brevo fallback');
                return this._sendViaBrevo({ to, subject, html, text });
            }
            if (this._brevoTransporter) return this._sendViaBrevo({ to, subject, html, text });
            return { success: false, error: err.message };
        }
    }

    /**
     * Brevo SMTP — fallback automático de cuota/error de Resend.
     * Límites Brevo free: 300 emails/día.
     */
    async _sendViaBrevo({ to, subject, html, text }) {
        try {
            const from = process.env.EMAIL_FROM || 'CourseV@yisuscompany.com';
            if (!this._brevoTransporter) {
                return { success: false, error: 'Brevo not configured (missing BREVO_SMTP_USER / BREVO_SMTP_PASSWORD)' };
            }
            const info = await this._brevoTransporter.sendMail({
                from: `"CourseV" <${from}>`,
                to: Array.isArray(to) ? to.join(', ') : to,
                subject,
                html,
                text,
            });
            return { success: true, messageId: info.messageId };
        } catch (err) {
            console.error('EmailAdapter Brevo error:', err.message);
            return { success: false, error: err.message };
        }
    }

    isAvailable() {
        return !!this.provider;
    }
}

export default EmailAdapter;