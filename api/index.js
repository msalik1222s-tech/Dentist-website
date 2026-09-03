// Vercel serverless entry point. Every /api/* request is rewritten onto this
// function by vercel.json; the static site in public/ is served by the CDN and
// never reaches here.
//
// Loading .env first matters: backend/app.js reads ADMIN_KEY and backend/db.js
// reads DATABASE_URL at module load. On Vercel the platform has already put
// the real values in process.env and this call is a harmless no-op; it exists
// so `vercel dev` picks up a local backend/.env.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "backend", ".env") });

const { createApp } = require("../backend/app");

// The CDN already serves public/, and those files aren't in the function
// bundle anyway. mountAtRoot keeps the routes reachable whether or not the
// /api prefix survives the rewrite.
const app = createApp({ serveStatic: false, mountAtRoot: true });

module.exports = app;
