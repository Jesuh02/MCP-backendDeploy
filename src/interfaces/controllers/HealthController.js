export class HealthController {
    constructor({ fileStoragePort, pushNotificationPort, emailPort, paymentGatewayPort }) {
        this.storage = fileStoragePort;
        this.push = pushNotificationPort;
        this.email = emailPort;
        this.payment = paymentGatewayPort;
    }

    health = async(req, res) => {
        res.json({
            success: true,
            data: {
                status: 'ok',
                timestamp: new Date().toISOString(),
                version: '2.0.0',
                services: {
                    storage: this.storage?.isAvailable() || false,
                    push: this.push?.isAvailable() || false,
                    email: this.email?.isAvailable() || false,
                    payment: this.payment?.isAvailable() || false,
                },
            },
        });
    };

    ping = async(req, res) => {
        res.json({ pong: true, timestamp: Date.now() });
    };
}
export default HealthController;

