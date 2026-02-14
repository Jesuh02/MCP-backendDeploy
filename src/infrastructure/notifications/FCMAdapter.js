/**
 * FCMAdapter — Implementa IPushNotificationPort.
 * Envía push notifications via Firebase Cloud Messaging.
 */
import { createRequire } from 'module';

const require = createRequire(
    import.meta.url);

export class FCMAdapter {
    constructor() {
        this.admin = null;
        this._initialize();
    }

    _initialize() {
        try {
            this.admin = require('firebase-admin');

            if (this.admin.apps && this.admin.apps.length > 0) {
                console.log('✅ FCMAdapter: Firebase Admin already initialized');
                return;
            }

            if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
                let privateKey = process.env.FIREBASE_PRIVATE_KEY;
                if (privateKey.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');

                this.admin.initializeApp({
                    credential: this.admin.credential.cert({
                        type: 'service_account',
                        project_id: process.env.FIREBASE_PROJECT_ID,
                        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
                        private_key: privateKey,
                        client_email: process.env.FIREBASE_CLIENT_EMAIL,
                        client_id: process.env.FIREBASE_CLIENT_ID || '',
                        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
                        token_uri: 'https://oauth2.googleapis.com/token',
                        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
                        client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL || '',
                    }),
                });
                console.log('✅ FCMAdapter: Firebase Admin initialized');
            } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
                let sa;
                try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\\"/g, '"')); }
                if (sa.private_key ?.includes('\\n')) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
                this.admin.initializeApp({ credential: this.admin.credential.cert(sa) });
                console.log('✅ FCMAdapter: Firebase Admin initialized from JSON');
            } else {
                console.warn('⚠️ FCMAdapter: Firebase not configured — push disabled');
            }
        } catch (err) {
            console.warn('⚠️ FCMAdapter: Firebase init failed:', err.message);
        }
    }

    // ----------------------------------------------------------
    // IPushNotificationPort
    // ----------------------------------------------------------

    /**
     * Envía notificaciones push a una lista de tokens FCM.
     * @param {string[]} tokens
     * @param {string} title
     * @param {string} body
     * @param {Object} data
     * @returns {Promise<{success: number, failure: number, invalidTokens: string[]}>}
     */
    async sendToTokens(tokens, title, body, data = {}) {
        if (!this.isAvailable() || !tokens || tokens.length === 0) {
            return { success: 0, failure: 0, invalidTokens: [] };
        }

        const baseMessage = {
            notification: { title, body },
            data,
            android: { priority: 'high', notification: { channelId: 'deepseek_updates' } },
        };

        const invalidTokens = [];
        let success = 0;
        let failure = 0;

        for (const token of tokens) {
            try {
                await this.admin.messaging().send({...baseMessage, token });
                success++;
            } catch (err) {
                failure++;
                const code = err.code || '';
                if (code.includes('invalid-registration') || code.includes('not-registered') || code.includes('unregistered')) {
                    invalidTokens.push(token);
                }
            }
        }

        return { success, failure, invalidTokens };
    }

    isAvailable() {
        return !!(this.admin && this.admin.apps && this.admin.apps.length > 0);
    }
}

export default FCMAdapter;

