const nodemailer = require("nodemailer");

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta env: ${name}`);
  return v;
}

const transporter = nodemailer.createTransport({
  host: must("SMTP_HOST"),
  port: Number(must("SMTP_PORT")),
  secure: String(process.env.SMTP_SECURE).toLowerCase() === "true", // false para 587
  auth: {
    user: must("SMTP_USER"),
    pass: must("SMTP_PASS"),
  },
  tls: {
    ciphers: "TLSv1.2",
  },
});

// ✅ Correo a tu equipo (nuevo ticket)
async function sendNewTicketEmail({
  ticket_no,
  full_name,
  email,
  company,
  request_type,
  service,
  description,
}) {
  const to = must("SUPPORT_INBOX");
  const from = must("SMTP_USER");

  const text = `
Hola Altiora 👋,

Tienes un ticket nuevo.

🎫 Ticket: ${ticket_no}

Usuario: ${full_name}
Correo: ${email}
Empresa: ${company || "-"}
Tipo: ${request_type}
Servicio: ${service}

Descripción:
${description}

— Sistema de Tickets Altiora
`.trim();

  await transporter.sendMail({
    from: `"Altiora Tickets" <${from}>`,
    to,
    subject: `🎫 Nuevo ticket ${ticket_no} - ${service} (${request_type})`,
    text,
  });
}

// ✅ Correo al cliente (actualizaciones/respuestas)
async function sendTicketUpdateToCustomer({ to, ticket_no, subject, message }) {
  const from = must("SMTP_USER");

  const text = `
Hola 👋,

Tenemos una actualización en tu ticket ${ticket_no}.

${message}

— Altiora Tickets
`.trim();

  await transporter.sendMail({
    from: `"Altiora Tickets" <${from}>`,
    to,
    subject: subject || `Actualización de tu ticket ${ticket_no}`,
    text,
  });
}

module.exports = { sendNewTicketEmail, sendTicketUpdateToCustomer };
