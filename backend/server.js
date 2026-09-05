// Local development entry point. On Vercel the app is served by api/index.js
// instead — this file is never run there.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { createApp } = require("./app");
const mailer = require("./mailer");
const db = require("./db");
const agent = require("./ai/agent");
const whatsapp = require("./ai/channels/whatsapp");

const PORT = process.env.PORT || 5500;

const app = createApp({ serveStatic: true });

app.listen(PORT, () => {
  const status = agent.status();

  console.log("BrightSmile backend running at http://localhost:" + PORT);
  console.log(
    db.isPostgres
      ? "Storage: Postgres (DATABASE_URL)"
      : "Storage: backend/data/*.json (set DATABASE_URL to use Postgres)"
  );
  console.log(
    status.enabled
      ? `AI assistant: enabled (provider: ${status.provider})`
      : `AI assistant: DISABLED — no API key for provider "${status.provider}"`
  );
  console.log(
    whatsapp.isEnabled()
      ? "WhatsApp: enabled"
      : "WhatsApp: disabled (set WHATSAPP_* variables to enable)"
  );

  if (!mailer.isEnabled()) console.log("Email notifications disabled (set SMTP_HOST in .env to enable).");
  if (!process.env.ADMIN_KEY) console.log("WARNING: ADMIN_KEY not set — /admin.html is locked out.");
});
