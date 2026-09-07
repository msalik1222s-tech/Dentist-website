// Builds the Express app. Kept free of `listen` and of any assumption about
// the process outliving a request, so the same routes serve both the local
// dev server (backend/server.js) and the Vercel function (api/index.js).

const path = require("path");
const express = require("express");

const chat = require("./chat");
const store = require("./store");

const ADMIN_KEY = process.env.ADMIN_KEY || "";

// req.ip honours the "trust proxy" setting applied in createApp(). With it
// off (the default) X-Forwarded-For is ignored entirely, so a client cannot
// mint a fresh rate-limit identity by sending a random value per request.
function getClientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

const LIMITS = {
  appointments: { windowMs: 10 * 60 * 1000, max: 5 },
  chat: { windowMs: 60 * 1000, max: 15 },
  availability: { windowMs: 60 * 1000, max: 30 },
  // ADMIN_KEY is a single static secret with no lockout behind it, so an
  // unthrottled admin route is a password an attacker may guess forever.
  // Twenty attempts per ten minutes is far more than a human clicking
  // "Load" needs, and slow enough that guessing the key is hopeless.
  admin: { windowMs: 10 * 60 * 1000, max: 20 },
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

// Header only. The key used to be accepted as ?key=... too, which put the
// clinic's admin secret into places nobody thinks of as secret: server and CDN
// access logs, browser history, and the Referer header of anything the page
// later links to. admin.html has always sent the header, so nothing that
// legitimately worked before stops working here.
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }
  next();
}

// What the clinic may do to a booking. Anything else is a 400 rather than a
// guess: an action this endpoint does not understand must never be read as a
// near-miss for one it does.
const ADMIN_ACTIONS = new Set(["confirm", "cancel", "reschedule"]);

function sanitizeChatMessages(input) {
  if (!Array.isArray(input)) return null;
  const cleaned = input
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
    .slice(-20);
  if (!cleaned.length || cleaned[cleaned.length - 1].role !== "user") return null;
  return cleaned;
}

const CHAT_UNAVAILABLE = "The chat assistant is temporarily unavailable — please call the clinic directly.";

// The adapters tag failures with a code and log the real provider error.
// What reaches the patient stays generic — an API key or billing problem is
// the operator's business, not theirs.
const CHAT_FAILURES = {
  CHAT_NOT_CONFIGURED: { status: 503, message: "The chat assistant isn't set up yet — please call the clinic directly." },
  CHAT_AUTH_FAILED: { status: 503, message: CHAT_UNAVAILABLE },
  CHAT_QUOTA_EXCEEDED: { status: 503, message: CHAT_UNAVAILABLE },
  CHAT_MODEL_UNAVAILABLE: { status: 503, message: CHAT_UNAVAILABLE },
  CHAT_UPSTREAM_ERROR: { status: 503, message: CHAT_UNAVAILABLE },
  CHAT_RATE_LIMITED: { status: 429, message: "The assistant is busy right now — please try again in a moment." },
};

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
      // store.js tags patient-facing problems with a status; anything 500 or
      // above is ours, so it goes to the error handler and stays generic.
      if (!err.status || err.status >= 500) return next(err);
      return res.status(err.status).json({ ok: false, error: err.message });
    }

    // The clinic notification is sent inside store.createAppointment, which
    // also swallows mail failures so they cannot fail an already-saved
    // booking. `entry` here is a publicView — it still carries the reference.
    res.status(201).json({
      ok: true,
      reference: entry.ref,
      message:
        `Thanks ${clean.name.split(" ")[0]}! Your request is noted — we'll call you shortly to confirm. ` +
        `Your booking reference is ${entry.ref} — keep it, you'll need it to change or cancel this appointment.`,
    });
  });

  // The limiter runs before the auth check on purpose: it is wrong guesses
  // that need throttling, and a 401 that costs nothing is a free guess.
  api.get("/appointments", limiter("admin"), requireAdmin, async (req, res, next) => {
    try {
      res.json({ ok: true, appointments: await store.loadAppointments() });
    } catch (err) {
      next(err);
    }
  });

  // The clinic's side of an appointment: confirm it, cancel it, or move it.
  // One endpoint rather than three, because all three are the same operation
  // as far as authentication, lookup and error handling are concerned — and
  // one route is one thing to keep guarded rather than three.
  //
  // The reference in the path is the only identifier accepted. Internal row
  // ids are neither read from the request nor returned in the response.
  api.patch("/appointments/:ref", limiter("admin"), requireAdmin, async (req, res, next) => {
    const body = req.body || {};
    const action = String(body.action || "").trim().toLowerCase();
    if (!ADMIN_ACTIONS.has(action)) {
      return res
        .status(400)
        .json({ ok: false, error: "Unknown action. Use confirm, cancel or reschedule." });
    }

    try {
      let result;
      if (action === "confirm") {
        result = await store.adminConfirmAppointment(req.params.ref);
      } else if (action === "cancel") {
        result = await store.adminCancelAppointment(req.params.ref);
      } else {
        result = await store.adminRescheduleAppointment({
          ref: req.params.ref,
          newDate: String(body.date || "").trim(),
          newTime: String(body.time || "").trim(),
        });
      }
      res.json({
        ok: true,
        action,
        // False when the appointment was already in the requested state, so
        // a second click reads as "nothing to do" instead of a fresh change.
        changed: result.changed,
        appointment: result.appointment,
      });
    } catch (err) {
      // Same split as the booking route: store.js tags what staff may safely
      // read (404 unknown reference, 409 taken slot, 400 bad date) with a
      // status. Anything else is a storage failure and stays generic.
      if (err.code) return next(err);
      if (!err.status || err.status >= 500) return next(err);
      res.status(err.status).json({ ok: false, error: err.message });
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
      const failure = CHAT_FAILURES[err.code];
      if (failure) {
        return res.status(failure.status).json({ ok: false, error: failure.message });
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

  // Behind a reverse proxy (nginx, Cloudflare, a PaaS), set TRUST_PROXY to the
  // number of proxies in front of this app — or a specific IP/subnet — so
  // req.ip is the real client. Default false: X-Forwarded-For is IGNORED.
  // Trusting that header blindly let anyone reset their own rate limit by
  // sending a different random value on every request, which made the chat
  // endpoint (and the API bill behind it) effectively unlimited.
  const TRUST_PROXY = process.env.TRUST_PROXY;
  app.set(
    "trust proxy",
    TRUST_PROXY ? (/^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY) : false
  );

  app.use(express.json({ limit: "100kb" }));

  const api = buildApiRouter();
  app.use("/api", api);
  // Vercel rewrites /api/* onto this function; mounting the router at the root
  // too keeps the routes reachable whether or not the /api prefix survives.
  if (mountAtRoot) app.use("/", api);

  if (serveStatic) {
    app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));
  }

  // Anything not matched above — including every path under /backend and
  // /.git, which are outside public/ and so were never servable — gets a 404.
  // API paths answer in JSON; page requests get plain text, as before.
  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ ok: false, error: "Not found." });
    }
    res.status(404).type("text/plain").send("Not found");
  });

  app.use((err, req, res, _next) => {
    console.error("Unhandled error:", err);
    if (res.headersSent) return;
    res.status(500).json({ ok: false, error: "Something went wrong. Please try again." });
  });

  return app;
}

module.exports = { createApp };
