/**
 * YCloudWhatsAppAdapter — Minimal adapter for YCloud-like WhatsApp provider.
 *
 * This adapter provides the small subset of methods used by the domain service:
 *  - sendTextMessage(phoneNumber, text)
 *  - sendTemplateMessage(...)
 *  - sendOtpMessage(phoneNumber, otpCode)
 *  - markAsRead(waMessageId)
 *  - isAvailable()
 *
 * Configure via env:
 *  - YCLOUD_API_KEY
 *  - YCLOUD_ACCOUNT_ID
 *  - YCLOUD_PHONE_NUMBER_ID (optional)
 *  - YCLOUD_API_BASE (optional, defaults to https://api.ycloud.com/v1)
 */

const DEFAULT_BASE = 'https://api.ycloud.com/v1';

export class YCloudWhatsAppAdapter {
    constructor({ apiKey, accountId, phoneNumberId = null }) {
        if (!apiKey) throw new Error('YCLOUD_API_KEY is required');
        if (!accountId) throw new Error('YCLOUD_ACCOUNT_ID is required');
        this.apiKey = apiKey;
        this.accountId = accountId;
        this.phoneId = phoneNumberId || null;
        this.base = process.env.YCLOUD_API_BASE || DEFAULT_BASE;
        this.messagesUrl = `${this.base}/accounts/${this.accountId}/messages`;
    }

    setPhoneNumberId(phoneNumberId) {
        if (!phoneNumberId) return;
        this.phoneId = phoneNumberId;
    }

    async sendTextMessage(phoneNumber, text) {
        const to = phoneNumber.replace(/^\+/, '');
        const body = {
            to,
            type: 'text',
            text: { body: String(text).substring(0, 4096) },
            from: this.phoneId,
        };
        return this._post(this.messagesUrl, body);
    }

    async sendTemplateMessage(phoneNumber, templateName, languageCode = 'en_US', components = []) {
        // Many providers accept a template-like payload; fall back to text if unsupported
        const to = phoneNumber.replace(/^\+/, '');
        const body = {
            to,
            type: 'template',
            template: { name: templateName, language: { code: languageCode }, components },
            from: this.phoneId,
        };
        return this._post(this.messagesUrl, body);
    }

    async sendOtpMessage(phoneNumber, otpCode) {
            // Default to template if available, otherwise text
        try {
            return await this.sendTemplateMessage(phoneNumber, 'otp', 'en_US', [{ type: 'body', parameters: [{ type: 'text', text: otpCode }] }]);
        } catch (e) {
            return await this.sendTextMessage(phoneNumber, `Tu código OTP es: ${otpCode}`);
        }
    }

    async markAsRead(waMessageId) {
        // Optional in many providers — best-effort no-op
        try {
            const url = `${this.base}/accounts/${this.accountId}/messages/${waMessageId}/status`;
            await this._post(url, { status: 'read' }).catch(() => {});
        } catch (_) {}
    }

    async isAvailable() {
        try {
            const url = `${this.base}/accounts/${this.accountId}`;
            const resp = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' } });
            return resp.ok;
        } catch (_) {
            return false;
        }
    }

    verifySignature() {
        // YCloud webhook verification not implemented here — return true to not block
        return true;
    }

    async getProviderInfo() {
        return {
            provider: 'ycloud',
            name: process.env.YCLOUD_PROVIDER_NAME || null,
            accountId: this.accountId,
            phoneNumber: this.phoneId,
            connected: await this.isAvailable(),
        };
    }

    async _post(url, body) {
        const options = { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' } };
        options.body = JSON.stringify(body);
        const res = await fetch(url, options);
        const json = await res.json();
        if (!res.ok) {
            const msg = json?.error?.message || json?.message || `YCloud API error: ${res.status}`;
            const err = new Error(msg);
            err.meta = json?.error || null;
            err.httpStatus = res.status;
            throw err;
        }
        return json;
    }
}

export default YCloudWhatsAppAdapter;
