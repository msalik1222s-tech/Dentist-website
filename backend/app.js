// Builds the Express app — the composition root.
//
// It wires routers together and owns nothing else: no business rules, no SQL,
// no prompt text. Kept free of `listen` and of any assumption about the process
// outliving a request, so the same routes serve both the local dev server
// (backend/server.js) and the Vercel function (api/index.js).

const path = require("path");
const express = require("express");

const { createAppointmentRouter } = require("./routes/appointment-routes");
const { createChatRouter } = require("./routes/chat-routes");
const { createCatalogRouter } = require("./routes/catalog-routes");
const { createAdminRouter } = require("./routes/admin-routes");
const { createWhatsappRouter } = require("./routes/whatsapp-routes");

// WhatsApp signatures are computed over the exact bytes the platform sent.
// Re-serialising the parsed body produces different bytes and a signature that
// never matches, so the raw buffer is kept for those routes only — holding it
// for every request would double the memory of a large upload for nothing.
function captureRawBody(req, res, buf) {
  if (req.originalUrl && req.originalUrl.includes("/whatsapp/")) req.rawBody = buf;
}

function buildApiRouter() {
  const api = express.Router();

  api.use(createCatalogRouter());
  api.use(createAppointmentRouter());
  api.use(createChatRouter());
  api.use(createAdminRouter());
  api.use(createWhatsappRouter());

  return api;
}

// `serveStatic` is on locally (one process serves the whole site) and off on
// Vercel, where the CDN serves index.html/admin.html/img before the function
// is ever reached.
function createApp({ serveStatic = true, mountAtRoot = false } = {}) {
  const app = express();
  app.disable("x-powered-by");

  app.use(express.json({ limit: "100kb", verify: captureRawBody }));
  // Twilio posts form-encoded webhooks.
  app.use(express.urlencoded({ extended: false, limit: "100kb", verify: captureRawBody }));

  const api = buildApiRouter();
  app.use("/api", api);
  // Vercel rewrites /api/* onto this function; mounting the router at the root
  // too keeps the routes reachable whether or not the /api prefix survives.
  if (mountAtRoot) app.use("/", api);

  if (serveStatic) {
    app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));
  }

  app.use((req, res) => res.status(404).json({ ok: false, error: "Not found." }));

  app.use((err, req, res, _next) => {
    console.error("Unhandled error:", err);
    if (res.headersSent) return;
    res.status(500).json({ ok: false, error: "Something went wrong. Please try again." });
  });

  return app;
}

module.exports = { createApp };
