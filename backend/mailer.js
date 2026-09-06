const nodemailer = require("nodemailer");

let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

function isEnabled() {
  return !!transporter;
}

async function send(subject, lines) {
  if (!transporter || !process.env.CLINIC_EMAIL) return;
  try {
    await transporter.sendMail({
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: process.env.CLINIC_EMAIL,
      subject,
      text: lines.join("\n"),
    });
  } catch (err) {
    console.error("Email notification failed:", err.message);
  }
}

function sourceLabel(entry) {
  return entry.source === "chat" ? "AI chat assistant" : "Website form";
}

function notifyNewAppointment(entry) {
  return send(`New appointment — ${entry.name} (${entry.ref})`, [
    `Reference: ${entry.ref}`,
    `Name: ${entry.name}`,
    `Phone: ${entry.phone}`,
    `Date: ${entry.date}`,
    `Time: ${entry.time || "-"}`,
    `Service: ${entry.service || "-"}`,
    `Booked via: ${sourceLabel(entry)}`,
    `Message: ${entry.message || "-"}`,
    `Submitted: ${entry.createdAt}`,
  ]);
}

function notifyAppointmentChange(action, entry) {
  return send(`Appointment ${action} — ${entry.name} (${entry.ref})`, [
    `Reference: ${entry.ref}`,
    `Name: ${entry.name}`,
    `Phone: ${entry.phone}`,
    `Date: ${entry.date}`,
    `Time: ${entry.time || "-"}`,
    `Service: ${entry.service || "-"}`,
    `Action: ${action} (via AI chat assistant)`,
  ]);
}

module.exports = { isEnabled, notifyNewAppointment, notifyAppointmentChange };
