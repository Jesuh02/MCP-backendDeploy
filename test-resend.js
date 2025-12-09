/**
 * Test de envío de email con Resend
 * Ejecutar: node test-resend.js
 */

require('dotenv').config();
const nodemailer = require('nodemailer');

async function testResendEmail() {
    console.log('🧪 Probando envío de email con Resend...\n');

    if (!process.env.RESEND_API_KEY) {
        console.error('❌ Error: RESEND_API_KEY no está configurado en .env');
        process.exit(1);
    }

    try {
        // Configurar transporter de Resend
        const transporter = nodemailer.createTransport({
            host: 'smtp.resend.com',
            port: 465,
            secure: true,
            auth: {
                user: 'resend',
                pass: process.env.RESEND_API_KEY
            }
        });

        console.log('📧 Configuración:');
        console.log(`   API Key: ${process.env.RESEND_API_KEY.substring(0, 10)}...`);
        console.log(`   From: ${process.env.RESEND_FROM_EMAIL}`);
        console.log(`   To: jenisus401@gmail.com\n`);

        // Enviar email de prueba
        const info = await transporter.sendMail({
            from: `"TareaMov AI Test" <${process.env.RESEND_FROM_EMAIL}>`,
            to: 'jenisus401@gmail.com',
            subject: '✅ Test de Resend - TareaMov',
            text: 'Este es un email de prueba desde Resend.\n\nSi recibes este mensaje, la configuración está correcta! 🎉',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2 style="color: #4a90e2;">✅ Email de Prueba - Resend</h2>
                    <p style="font-size: 16px;">
                        Este es un email de prueba desde <strong>Resend</strong>.
                    </p>
                    <p style="font-size: 16px;">
                        Si recibes este mensaje, <strong>la configuración está correcta! 🎉</strong>
                    </p>
                    <hr style="border: 1px solid #eee; margin: 20px 0;">
                    <p style="font-size: 12px; color: #888;">
                        Enviado desde: ${process.env.RESEND_FROM_EMAIL}<br>
                        Dominio: coursev.yisuscompany.com<br>
                        Servidor: Railway
                    </p>
                </div>
            `
        });

        console.log('✅ Email enviado exitosamente!');
        console.log(`   Message ID: ${info.messageId}`);
        console.log(`   Respuesta: ${info.response}\n`);
        console.log('📬 Revisa tu bandeja de entrada en jenisus401@gmail.com');

    } catch (error) {
        console.error('❌ Error enviando email:', error.message);
        console.error('\n💡 Posibles causas:');
        console.error('   1. API Key incorrecta');
        console.error('   2. Dominio no verificado en Resend');
        console.error('   3. DNS records no configurados correctamente');
        process.exit(1);
    }
}

testResendEmail();
