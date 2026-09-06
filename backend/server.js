// Local development entry point. On Vercel the app is served by api/index.js
// instead — this file is never run there.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

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
      : "Storage: backend/data/appointments.json (set DATABASE_URL to use Postgres)"
  );
  if (!mailer.isEnabled()) console.log("Email notifications disabled (set SMTP_HOST in .env to enable).");
  if (!process.env.ADMIN_KEY) console.log("WARNING: ADMIN_KEY not set — /api/appointments admin view is locked out.");
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
