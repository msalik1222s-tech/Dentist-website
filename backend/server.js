// Local development entry point. On Vercel the app is served by api/index.js
// instead — this file is never run there.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Before anything makes an outbound HTTPS call. On a machine whose antivirus
// or proxy inspects TLS, Node otherwise rejects every certificate and the AI
// assistant fails with a bare "Connection error". Local entry point only —
// the Vercel function does not do this.
const { trustSystemCAs } = require("./system-ca");
const caResult = trustSystemCAs();

const { createApp } = require("./app");
const mailer = require("./mailer");
const db = require("./db");
const chat = require("./chat");

const PORT = process.env.PORT || 5500;

// Everything that used to live here — routes, validation, rate limiting, the
// TRUST_PROXY policy, static files, the 404 fallback and the JSON error
// handler — is now in app.js, so this process and the Vercel function serve
// exactly the same behaviour. Nothing is defined twice.
//
// Static files come from public/ only. backend/ (source, .env and
// data/appointments.json) and .git/ sit outside that directory and so cannot
// be reached at any URL.
const app = createApp({ serveStatic: true });

app.listen(PORT, () => {
  console.log("BrightSmile backend running at http://localhost:" + PORT);
  console.log(
    db.isPostgres
      ? "Storage: Postgres (DATABASE_URL)"
      : `Storage: ${db.dataFile} (set DATABASE_URL to use Postgres)`
  );
  if (!db.isPostgres && process.env.APPOINTMENTS_FILE) {
    console.log("APPOINTMENTS_FILE is set — the usual backend/data/appointments.json is NOT being touched.");
  }
  const missingMail = mailer.missingConfig();
  if (missingMail.length) {
    console.log(`Email notifications disabled — set ${missingMail.join(" and ")} in backend/.env to enable.`);
  } else {
    console.log("Email notifications: on (clinic address from CLINIC_EMAIL).");
  }
  if (!process.env.ADMIN_KEY) console.log("WARNING: ADMIN_KEY not set — /api/appointments admin view is locked out.");
  if (caResult.applied) {
    console.log(`TLS: trusting ${caResult.added} additional certificate(s) from the system store.`);
  }
  const ai = chat.status();
  if (ai.enabled) {
    console.log(`AI chat assistant: ${ai.provider} (${ai.model})`);
  } else {
    console.log("WARNING: OPENAI_API_KEY not set — the chat assistant is disabled.");
  }
  if (!process.env.TRUST_PROXY) {
    console.log(
      "Proxy trust disabled — X-Forwarded-For is ignored and rate limits key on the socket address. " +
        "Set TRUST_PROXY in .env when running behind a proxy."
    );
  }
});
