// Local development entry point. On Vercel the app is served by api/index.js
// instead — this file is never run there.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { createApp } = require("./app");
const mailer = require("./mailer");
const db = require("./db");

const PORT = process.env.PORT || 5500;

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
  if (!process.env.ANTHROPIC_API_KEY) console.log("WARNING: ANTHROPIC_API_KEY not set — the chat assistant is disabled.");
});
