const axios = require('axios');

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

async function sendAuthEmail({ to, kind, actionUrl }) {
  if (!isConfigured()) throw new Error('RESEND_API_KEY is not configured');

  const isVerification = kind === 'verify';
  const subject = isVerification ? 'Verifica tu correo en corta.la' : 'Restablece tu contraseña de corta.la';
  const action = isVerification ? 'Verificar correo' : 'Crear nueva contraseña';
  const explanation = isVerification
    ? 'Confirma que esta dirección te pertenece para activar tu cuenta.'
    : 'Recibimos una solicitud para cambiar la contraseña de tu cuenta.';
  const expires = isVerification ? 'El enlace vence en 24 horas.' : 'El enlace vence en una hora.';
  const safeActionUrl = actionUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#17231f"><h1 style="color:#18734f">corta.la</h1><p>${explanation}</p><p><a href="${safeActionUrl}" style="display:inline-block;background:#18734f;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">${action}</a></p><p>${expires}</p><p style="color:#66736d;font-size:13px">Si no solicitaste esto, puedes ignorar este mensaje.</p></div>`;
  const text = `${explanation}\n\n${action}: ${actionUrl}\n\n${expires}\nSi no solicitaste esto, puedes ignorar este mensaje.`;
  const fragment = new URL(actionUrl).hash.slice(1);
  const tokenParameter = kind === 'verify' ? 'verify' : 'reset';
  const token = new URLSearchParams(fragment).get(tokenParameter) || '';
  const idempotencyKey = `${kind}/${token}`;

  const response = await axios.post('https://api.resend.com/emails', {
    from: process.env.EMAIL_FROM || 'corta.la <noreply@corta.la>',
    to: [to],
    subject,
    html,
    text,
  }, {
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Idempotency-Key': idempotencyKey,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });
  return response.data;
}

module.exports = { isConfigured, sendAuthEmail };
