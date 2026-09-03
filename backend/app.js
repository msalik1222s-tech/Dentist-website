// Builds the Express app. Kept free of `listen` and of any assumption about
// the process outliving a request, so the same routes serve both the local
// dev server (backend/server.js) and the Vercel function (api/index.js).

const path = require("path");
const express = require("express");

const chat = require("./chat");
const store = require("./store");
const mailer = require("./mailer");

const ADMIN_KEY = process.env.ADMIN_KEY || "";

// Vercel puts the real client address at the front of x-forwarded-for; the
// rest of the list is proxy hops and must not be treated as the identity.
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "unknown";
}

const LIMITS = {
  appointments: { windowMs: 10 * 60 * 1000, max: 5 },
  chat: { windowMs: 60 * 1000, max: 15 },
  availability: { windowMs: 60 * 1000, max: 30 },
};

function limiter(bucket) {
  const { windowMs, max } = LIMITS[bucket];
  return async function checkRateLimit(req, res, next) {
    if (await store.isRateLimited(bucket, getClientIp(req), windowMs, max)) {
      const message =
        bucket === "chat"
          ? "Too many messages. Please slow down a little."
          : "Too many requests. Please try again later.";
      return res.status(429).json({ ok: false, error: message });
    }
    next();
  };
}

// ---------- validation ----------
function validate(body) {
  const errors = [];
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const date = String(body.date || "").trim();
  const time = String(body.time || "").trim();
  const service = String(body.service || "").trim();
  const message = String(body.message || "").trim();

  if (!name || name.length > 100) errors.push("Please provide a valid name.");
  if (!phone || phone.replace(/[^0-9+]/g, "").length < 7 || phone.length > 30) {
    errors.push("Please provide a valid phone number.");
  }
  if (!date || !store.isValidDate(date)) {
    errors.push("Please provide a valid preferred date.");
  } else if (date < store.getClinicNow().dateStr) {
    errors.push("Preferred date can't be in the past.");
  }
  if (!time || !store.isValidTime(time)) {
    errors.push("Please choose an available appointment time.");
  }
  if (service.length > 100) errors.push("Service value is too long.");
  if (message.length > 1000) errors.push("Message is too long (max 1000 characters).");

  return { errors, clean: { name, phone, date, time, service, message } };
}

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }
  next();
}

function sanitizeChatMessages(input) {
  if (!Array.isArray(input)) return null;
  const cleaned = input
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
    .slice(-20);
  if (!cleaned.length || cleaned[cleaned.length - 1].role !== "user") return null;
  return cleaned;
}

function buildApiRouter() {
  const api = express.Router();

  api.get("/availability", limiter("availability"), async (req, res, next) => {
    try {
      const date = String(req.query.date || "").trim();
      if (!store.isValidDate(date)) {
        return res.status(400).json({ ok: false, error: "Please provide a valid date (YYYY-MM-DD)." });
      }
      res.json({ ok: true, date, slots: await store.getAvailableSlots(date) });
    } catch (err) {
      next(err);
    }
  });

  api.post("/appointments", limiter("appointments"), async (req, res, next) => {
    const { errors, clean } = validate(req.body || {});
    if (errors.length) {
      return res.status(400).json({ ok: false, error: errors[0] });
    }

    let entry;
    try {
      entry = await store.createAppointment({ ...clean, source: "form", status: "pending" });
    } catch (err) {
      if (err.code) return next(err); // a database failure, not a booking conflict
      return res.status(409).json({ ok: false, error: err.message });
    }

    try {
      await mailer.notifyNewAppointment(entry);
    } catch (err) {
      // The booking is already saved — a failed notification must not fail it.
      console.error("Email notification failed:", err.message);
    }

    res.status(201).json({
      ok: true,
      message: `Thanks ${clean.name.split(" ")[0]}! Your request is noted — we'll call you shortly to confirm.`,
    });
  });

  api.get("/appointments", requireAdmin, async (req, res, next) => {
    try {
      res.json({ ok: true, appointments: await store.loadAppointments() });
    } catch (err) {
      next(err);
    }
  });

  api.post("/chat", limiter("chat"), async (req, res) => {
    const messages = sanitizeChatMessages(req.body && req.body.messages);
    if (!messages) {
      return res.status(400).json({ ok: false, error: "Please provide a valid message." });
    }

    try {
      const reply = await chat.respond(messages);
      res.json({ ok: true, reply });
    } catch (err) {
      if (err.message === "CHAT_NOT_CONFIGURED") {
        return res.status(503).json({
          ok: false,
          error: "The chat assistant isn't set up yet — please call the clinic directly.",
        });
      }
      console.error("Chat error:", err);
      res.status(500).json({ ok: false, error: "Something went wrong. Please try again or call the clinic." });
    }
  });

  return api;
}

// `serveStatic` is on locally (one process serves the whole site) and off on
// Vercel, where the CDN serves index.html/admin.html/img before the function
// is ever reached.
function createApp({ serveStatic = true, mountAtRoot = false } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

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
