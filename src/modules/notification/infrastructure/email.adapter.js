/**
 * EmailAdapter — Implementa IEmailPort.
 * Cascada: Resend API → SendGrid → Gmail SMTP → Brevo SMTP.
 * Brevo actúa como fallback cuando se supera la cuota del proveedor principal
 * (100 emails/día o 3 000 emails/mes en Resend free tier).
 */
import nodemailer from 'nodemailer';

export class EmailAdapter {
    constructor() {
        this.provider = null;
        this._init();
    }

    _init() {
        if (process.env.RESEND_API_KEY) {
            this.provider = 'resend';
            console.log('✅ EmailAdapter: Using Resend');
        } else if (process.env.SENDGRID_API_KEY) {
            this.provider = 'sendgrid';
            console.log('✅ EmailAdapter: Using SendGrid');
        } else if (process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
            this.provider = 'smtp';
            this.transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
            });
            console.log('✅ EmailAdapter: Using Gmail SMTP');
        } else if (process.env.BREVO_SMTP_USER && process.env.BREVO_SMTP_PASSWORD) {
            this.provider = 'brevo';
            this.transporter = nodemailer.createTransport({
                host: 'smtp-relay.sendinblue.com', // cert TLS aún usa dominio Sendinblue
                port: 587,
                secure: false,
                auth: { user: process.env.BREVO_SMTP_USER, pass: process.env.BREVO_SMTP_PASSWORD },
            });
            console.log('✅ EmailAdapter: Using Brevo SMTP');
        } else {
            console.warn('⚠️ EmailAdapter: No email provider configured');
        }

        // Inicializar transporter de Brevo para fallback de cuota
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
            case 'sendgrid':
                return this._sendViaSendGrid({ to, subject, html, text });
            case 'smtp':
                return this._sendViaSMTP({ to, subject, html, text });
            case 'brevo':
                return this._sendViaBrevo({ to, subject, html, text });
            default:
                console.warn('EmailAdapter: No provider — email not sent');
                return { success: false, error: 'No email provider configured' };
        }
    }

    async _sendViaResend({ to, subject, html, text }) {
        try {
            const { default: axios } = await
            import ('axios');
            const from = process.env.EMAIL_FROM || 'coursev@yisuscompany.com';
            const response = await axios.post(
                'https://api.resend.com/emails', { from, to: Array.isArray(to) ? to : [to], subject, html, text }, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' } },
            );
            return { success: true, messageId: response.data?.id };
        } catch (err) {
            console.error('EmailAdapter Resend error:', err.response?.data || err.message);
            // Cascada: SendGrid → Gmail SMTP → Brevo
            if (process.env.SENDGRID_API_KEY) return this._sendViaSendGrid({ to, subject, html, text });
            if (this.transporter) return this._sendViaSMTP({ to, subject, html, text });
            if (this._brevoTransporter) return this._sendViaBrevo({ to, subject, html, text });
            return { success: false, error: err.message };
        }
    }

    async _sendViaSendGrid({ to, subject, html, text }) {
        try {
            const { default: axios } = await
            import ('axios');
            const from = process.env.EMAIL_FROM || 'coursev@yisuscompany.com';
            const personalizations = [{ to: (Array.isArray(to) ? to : [to]).map(email => ({ email })) }];
            const payload = {
                personalizations,
                from: { email: from },
                subject,
                content: [],
            };
            if (text) payload.content.push({ type: 'text/plain', value: text });
            if (html) payload.content.push({ type: 'text/html', value: html });
            if (payload.content.length === 0) payload.content.push({ type: 'text/plain', value: '' });

            await axios.post('https://api.sendgrid.com/v3/mail/send', payload, {
                headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
            });
            return { success: true };
        } catch (err) {
            console.error('EmailAdapter SendGrid error:', err.response?.data || err.message);
            if (this.transporter) return this._sendViaSMTP({ to, subject, html, text });
            if (this._brevoTransporter) return this._sendViaBrevo({ to, subject, html, text });
            return { success: false, error: err.message };
        }
    }

    async _sendViaSMTP({ to, subject, html, text }) {
        try {
            const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;
            const info = await this.transporter.sendMail({
                from,
                to: Array.isArray(to) ? to.join(', ') : to,
                subject,
                html,
                text,
            });
            return { success: true, messageId: info.messageId };
        } catch (err) {
            console.error('EmailAdapter SMTP error:', err.message);
            if (this._brevoTransporter) return this._sendViaBrevo({ to, subject, html, text });
            return { success: false, error: err.message };
        }
    }

    /**
     * Brevo SMTP — fallback cuando se agota la cuota del proveedor principal.
     * Límites Brevo free: 300 emails/día, sin límite mensual estricto.
     */
    async _sendViaBrevo({ to, subject, html, text }) {
        try {
            const from = process.env.EMAIL_FROM || 'coursev@yisuscompany.com';
            const transporter = this._brevoTransporter || nodemailer.createTransport({
                host: 'smtp-relay.sendinblue.com', // cert TLS aún usa dominio Sendinblue
                port: 587,
                secure: false,
                auth: {
                    user: process.env.BREVO_SMTP_USER,
                    pass: process.env.BREVO_SMTP_PASSWORD,
                },
            });
            const info = await transporter.sendMail({
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

