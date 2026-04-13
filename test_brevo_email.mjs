/**
 * test_brevo_email.mjs
 * Prueba de envío de email via Brevo SMTP (fallback de cuota de Resend).
 *   Resend free: 100 emails/día · 3 000 emails/mes
 *   Brevo free:  300 emails/día · sin límite mensual
 *
 * Uso: node test_brevo_email.mjs [to_email]
 * Vars de entorno: BREVO_SMTP_USER, BREVO_SMTP_PASSWORD, EMAIL_FROM
 */

import nodemailer from 'nodemailer';

// cert TLS de Brevo sigue siendo smtp-relay.sendinblue.com
const BREVO_HOST = 'smtp-relay.sendinblue.com';
const BREVO_PORT = 587;
const BREVO_USER = process.env.BREVO_SMTP_USER;
const BREVO_PASS = process.env.BREVO_SMTP_PASSWORD;
const FROM       = process.env.EMAIL_FROM || 'CourseV@yisuscompany.com';
const TO         = process.argv[2]        || 'jdavidherazo@uniguajira.edu.co';

if (!BREVO_USER || !BREVO_PASS) {
    console.error('❌ Faltan BREVO_SMTP_USER o BREVO_SMTP_PASSWORD. Configúralos como variables de entorno.');
    process.exit(1);
}

const transporter = nodemailer.createTransport({
    host: BREVO_HOST,
    port: BREVO_PORT,
    secure: false,
    auth: { user: BREVO_USER, pass: BREVO_PASS },
});

function buildHtml(now) {
    return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- HEADER -->
        <tr>
          <td style="background:linear-gradient(135deg,#7C3AED 0%,#4F46E5 100%);padding:36px 40px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">CourseV</span>
                  <span style="color:rgba(255,255,255,0.6);font-size:13px;margin-left:8px;">Platform</span>
                </td>
                <td align="right">
                  <span style="background:rgba(255,255,255,0.15);color:#fff;font-size:11px;padding:4px 10px;border-radius:20px;">Sistema de notificaciones</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- BADGE -->
        <tr>
          <td style="padding:32px 40px 0;">
            <span style="display:inline-block;background:#EDE9FE;color:#6D28D9;font-size:12px;font-weight:600;padding:5px 14px;border-radius:20px;letter-spacing:0.3px;">✅ Email de prueba</span>
          </td>
        </tr>

        <!-- TITLE -->
        <tr>
          <td style="padding:20px 40px 0;">
            <h1 style="margin:0;font-size:26px;font-weight:700;color:#111827;line-height:1.3;">
              Brevo SMTP configurado correctamente
            </h1>
          </td>
        </tr>

        <!-- BODY -->
        <tr>
          <td style="padding:20px 40px 0;color:#374151;font-size:15px;line-height:1.7;">
            <p style="margin:0 0 16px;">
              Este correo confirma que <strong>Brevo SMTP</strong> está activo como proveedor
              de respaldo para CourseV. El sistema cambia automáticamente a Brevo en los
              siguientes casos:
            </p>

            <!-- INFO BOX -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F3FF;border-left:4px solid #7C3AED;border-radius:0 8px 8px 0;margin-bottom:20px;">
              <tr>
                <td style="padding:16px 20px;">
                  <p style="margin:0 0 8px;font-size:14px;color:#5B21B6;font-weight:600;">Reglas de fallback activas</p>
                  <table cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding:3px 0;font-size:13px;color:#4C1D95;">
                        📊 &nbsp;Resend supera <strong>100 emails/día</strong>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:3px 0;font-size:13px;color:#4C1D95;">
                        📅 &nbsp;Resend supera <strong>3 000 emails/mes</strong>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:3px 0;font-size:13px;color:#4C1D95;">
                        ⚡ &nbsp;Resend devuelve error <strong>HTTP 429</strong>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:3px 0;font-size:13px;color:#4C1D95;">
                        🔴 &nbsp;Cualquier error de Resend con Brevo disponible
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <p style="margin:0 0 16px;">
              Brevo dispone de <strong>300 emails/día</strong> en el plan free, suficiente para
              cubrir la sobre-cuota de Resend sin interrupciones en la plataforma.
            </p>
          </td>
        </tr>

        <!-- DIVIDER -->
        <tr><td style="padding:24px 40px 0;"><hr style="border:none;border-top:1px solid #E5E7EB;margin:0;"/></td></tr>

        <!-- META -->
        <tr>
          <td style="padding:20px 40px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:12px;color:#9CA3AF;">
                  Enviado el ${new Date(now).toLocaleString('es-CO', { timeZone: 'America/Bogota' })} COT<br/>
                  Remitente: ${FROM}<br/>
                  Proveedor: Brevo SMTP · smtp-relay.sendinblue.com:587
                </td>
                <td align="right" style="font-size:12px;color:#9CA3AF;">
                  CourseV · yisuscompany.com
                </td>
              </tr>
            </table>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function run() {
    console.log(`\n📧 FROM: ${FROM}   →   TO: ${TO}`);
    console.log(`🔌 Verificando conexión SMTP (${BREVO_HOST}:${BREVO_PORT})…`);
    await transporter.verify();
    console.log('✅ Conexión SMTP verificada\n');

    const now = new Date().toISOString();
    const info = await transporter.sendMail({
        from: `"CourseV" <${FROM}>`,
        to: TO,
        subject: `CourseV — Sistema de notificaciones activo (Brevo SMTP)`,
        text: `CourseV — Brevo SMTP configurado correctamente.\n\nFallback activo cuando Resend supera 100 emails/día o 3 000 emails/mes.\nProveedor: Brevo SMTP (300 emails/día free).\n\nEnviado: ${now}`,
        html: buildHtml(now),
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