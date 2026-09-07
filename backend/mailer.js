// Clinic notification email: the clinic is told whenever an appointment is
// booked, rescheduled or cancelled, whether it came from the website form or
// the AI assistant.
//
// Every credential is read from the environment. Nothing in this file is a
// secret and nothing here may ever be hardcoded — an SMTP password committed
// to the repository is a password published to everyone who can read it.

const nodemailer = require("nodemailer");

// What must be present before a message can be sent at all. SMTP_USER and
// SMTP_PASS are deliberately not in this list: every hosted provider needs
// them, but an unauthenticated relay on localhost does not.
const REQUIRED_VARS = ["SMTP_HOST", "CLINIC_EMAIL"];

// Names only, never values — this string ends up in server logs.
function missingConfig() {
  return REQUIRED_VARS.filter((name) => !String(process.env[name] || "").trim());
}

function isEnabled() {
  return missingConfig().length === 0;
}

// Built on first send rather than at module load. The old version read
// process.env while this file was being required, which only worked because
// both entry points happen to call dotenv before requiring the app — reorder
// those two lines and every notification would silently stop. Resolving the
// environment at send time removes that trap.
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const port = Number(process.env.SMTP_PORT) || 587;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS from the first byte; 587 opens in the clear and is
    // upgraded by STARTTLS, which nodemailer does automatically.
    secure: port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
    // nodemailer's own timeouts are measured in minutes. This send is awaited
    // on the booking request path, so an SMTP host that accepts the connection
    // and then stalls would hold the patient's response open until the
    // serverless function itself was killed. Fail fast instead: the booking is
    // already committed to the database either way.
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 12000,
  });
  return transporter;
}

// A half-configured mailer used to fail in perfect silence: send() returned
// early and logged nothing, so a clinic could wait weeks for bookings that
// were being saved but never announced. Say so once, loudly, instead.
let warnedAboutConfig = false;

async function send(subject, lines) {
  const missing = missingConfig();
  if (missing.length) {
    if (!warnedAboutConfig) {
      warnedAboutConfig = true;
      console.error(
        `Appointment emails are OFF: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set. ` +
          "Appointments are still being saved — the clinic just isn't being notified."
      );
    }
    return;
  }

  try {
    await getTransporter().sendMail({
      // Gmail rewrites this to the authenticated account regardless, so the
      // fallback to SMTP_USER is always a valid sender.
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: process.env.CLINIC_EMAIL,
      subject,
      text: lines.join("\n"),
    });
  } catch (err) {
    // Swallowed on purpose: a broken mail server must never undo an
    // appointment that is already in the database.
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

module.exports = { isEnabled, missingConfig, notifyNewAppointment, notifyAppointmentChange };
