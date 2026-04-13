/**
 * test_brevo_email.mjs
 * Prueba de envío de email via Brevo SMTP.
 * Usar como fallback cuando se agote la cuota de Resend (100/día, 3000/mes).
 *
 * Uso: node test_brevo_email.mjs [to_email]
 * Vars de entorno opcionales: BREVO_SMTP_USER, BREVO_SMTP_PASSWORD, EMAIL_FROM
 *
 * IMPORTANTE — DNS requeridos en yisuscompany.com para entregabilidad:
 *   SPF:  TXT @ "v=spf1 include:spf.sendinblue.com include:amazonses.com ~all"
 *   DKIM: obtener en Brevo → Senders > Domains > yisuscompany.com > Generate DKIM
 */

import nodemailer from 'nodemailer';

// Brevo renombró Sendinblue pero el certificado TLS sigue siendo smtp-relay.sendinblue.com
const BREVO_HOST = 'smtp-relay.sendinblue.com';
const BREVO_PORT = 587;
const BREVO_USER = process.env.BREVO_SMTP_USER   || '9db704001@smtp-brevo.com';
const BREVO_PASS = process.env.BREVO_SMTP_PASSWORD || 'J5h6WKVQAENIk8jp';
// FROM debe ser un remitente verificado en Brevo.
// Opciones:
//   A) Verificar un sender en app.brevo.com → Senders & IP → Senders → Add a sender
//   B) Autenticar dominio yisuscompany.com en Brevo → Senders & IP → Domains
// Mientras tanto, usa el email de la cuenta SMTP (ya válido en Brevo) para pruebas:
const FROM       = process.env.EMAIL_FROM         || '9db704001@smtp-brevo.com';
// Destinatario: pasa como argumento o usa el default
const TO         = process.argv[2]                || 'jdavidherazo@uniguajira.edu.co';

const transporter = nodemailer.createTransport({
    host: BREVO_HOST,
    port: BREVO_PORT,
    secure: false, // STARTTLS en 587
    auth: { user: BREVO_USER, pass: BREVO_PASS },
});

async function run() {
    console.log(`📧 FROM: ${FROM}   TO: ${TO}`);
    console.log(`📧 Verificando conexión SMTP con Brevo (${BREVO_HOST}:${BREVO_PORT})…`);
    await transporter.verify();
    console.log('✅ Conexión SMTP verificada');

    const now = new Date().toISOString();
    const info = await transporter.sendMail({
        from: `"CourseV" <${FROM}>`,
        to: TO,
        subject: `✅ Prueba Brevo SMTP — CourseV [${now}]`,
        text: `Este correo confirma que Brevo SMTP está configurado correctamente como proveedor de respaldo para CourseV.\n\nEnviado: ${now}`,
        html: `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
                <h2 style="color:#7C3AED">CourseV — Prueba de email (Brevo)</h2>
                <p>Este correo confirma que <strong>Brevo SMTP</strong> está funcionando como proveedor de respaldo.</p>
                <p style="color:#6B7280;font-size:0.9em">
                    Se activa automáticamente cuando se supera la cuota diaria (100 emails/día)
                    o mensual (3 000 emails/mes) del proveedor principal.
                </p>
                <p style="color:#6B7280;font-size:0.8em">Enviado: ${now}</p>
                <hr style="border-color:#E5E7EB"/>
                <p style="color:#9CA3AF;font-size:0.8em">CourseV · yisuscompany.com</p>
            </div>
        `,
    });

    console.log(`✅ Aceptado por Brevo → ${TO}`);
    console.log(`   Message-ID : ${info.messageId}`);
    console.log(`   Respuesta  : ${info.response}`);
    console.log('');
    console.log('⚠️  Si no llega, revisa:');
    console.log('   1. Spam / Correo no deseado en el destino');
    console.log('   2. DNS de yisuscompany.com incluye SPF de Brevo:');
    console.log('      TXT @ "v=spf1 include:spf.sendinblue.com include:amazonses.com ~all"');
    console.log('   3. DKIM de Brevo activo: Brevo → Senders > Domains > yisuscompany.com');
    console.log('   4. Prueba con otro destino: node test_brevo_email.mjs tu@gmail.com');
}

run().catch(err => {
    console.error('❌ Error al enviar email:', err.message);
    process.exit(1);
});