const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const chat = require("./chat");
const store = require("./store");
const mailer = require("./mailer");

const ROOT = path.join(__dirname, "..");
const PORT = process.env.PORT || 5500;
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const app = express();

// Behind a reverse proxy (nginx, Cloudflare, a PaaS), set TRUST_PROXY in .env
// to the number of proxies in front of this app — or a specific IP/subnet — so
// req.ip is the real client. Default false: X-Forwarded-For is IGNORED.
// Trusting that header blindly let anyone reset their own rate limit by
// sending a different random value on every request, which made the chat
// endpoint (and the API bill behind it) effectively unlimited.
const TRUST_PROXY = process.env.TRUST_PROXY;
app.set(
  "trust proxy",
  TRUST_PROXY ? (/^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY) : false
);

app.use(express.json());

// ---------- static files ----------
// The project root also holds backend/ (source code, .env and
// data/appointments.json with real patient names and phone numbers) plus
// .git/. Serving the whole root with express.static made all of that
// publicly downloadable — /backend/data/appointments.json returned every
// appointment with no admin key at all. So nothing is served by default:
// only the pages and asset folders listed here are public.
// Adding a new page? Add a line to PAGES. A new asset folder? Add another
// express.static mount below — never one pointed at ROOT.
const PAGES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/admin": "admin.html",
  "/admin.html": "admin.html",
};

app.use("/img", express.static(path.join(ROOT, "img"), { dotfiles: "deny", maxAge: "7d" }));

app.get(Object.keys(PAGES), (req, res) => {
  res.sendFile(path.join(ROOT, PAGES[req.path]));
});

// ---------- simple in-memory rate limiting ----------
function makeRateLimiter(windowMs, maxPerWindow) {
  const hits = new Map();
  let lastSweep = Date.now();

  return function isRateLimited(ip) {
    const now = Date.now();

    // Drop entries that have aged out. Without this the map kept one array
    // per IP for the lifetime of the process — a slow memory leak.
    if (now - lastSweep > windowMs) {
      for (const [key, times] of hits) {
        if (!times.some((t) => now - t < windowMs)) hits.delete(key);
      }
      lastSweep = now;
    }

    const timestamps = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    timestamps.push(now);
    hits.set(ip, timestamps);
    return timestamps.length > maxPerWindow;
  };
}

const isRateLimited = makeRateLimiter(10 * 60 * 1000, 5);
const isChatRateLimited = makeRateLimiter(60 * 1000, 15);
const isAvailabilityRateLimited = makeRateLimiter(60 * 1000, 30);

// req.ip honours the "trust proxy" setting above: it is the socket address
// unless a proxy this app has been told to trust set X-Forwarded-For.
function getClientIp(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
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

// ---------- routes ----------
app.get("/api/availability", (req, res, next) => {
  if (isAvailabilityRateLimited(getClientIp(req))) {
    return res.status(429).json({ ok: false, error: "Too many requests. Please try again shortly." });
  }
  const date = String(req.query.date || "").trim();
  if (!store.isValidDate(date)) {
    return res.status(400).json({ ok: false, error: "Please provide a valid date (YYYY-MM-DD)." });
  }
  try {
    res.json({ ok: true, date, slots: store.getAvailableSlots(date) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/appointments", async (req, res) => {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ ok: false, error: "Too many requests. Please try again later." });
  }

  const { errors, clean } = validate(req.body || {});
  if (errors.length) {
    return res.status(400).json({ ok: false, error: errors[0] });
  }

  let entry;
  try {
    entry = store.createAppointment({ ...clean, source: "form", status: "pending" });
  } catch (err) {
    // Storage-level failures (err.status === 500) carry internal detail —
    // log them, but never show them to a patient.
    if (err.status === 500) {
      console.error("Failed to save appointment:", err);
      return res.status(500).json({
        ok: false,
        error: "We couldn't save your request right now — please call the clinic.",
      });
    }
    return res.status(err.status || 409).json({ ok: false, error: err.message });
  }

  mailer.notifyNewAppointment(entry);

  res.status(201).json({
    ok: true,
    reference: entry.ref,
    message:
      `Thanks ${clean.name.split(" ")[0]}! Your request is noted — we'll call you shortly to confirm. ` +
      `Your booking reference is ${entry.ref} — keep it, you'll need it to change or cancel this appointment.`,
  });
});

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }
  next();
}

app.get("/api/appointments", requireAdmin, (req, res, next) => {
  try {
    const list = store.loadAppointments().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ ok: true, appointments: list });
  } catch (err) {
    next(err);
  }
});

function sanitizeChatMessages(input) {
  if (!Array.isArray(input)) return null;
  const cleaned = input
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
    .slice(-20);
  if (!cleaned.length || cleaned[cleaned.length - 1].role !== "user") return null;
  return cleaned;
}

app.post("/api/chat", async (req, res) => {
  const ip = getClientIp(req);
  if (isChatRateLimited(ip)) {
    return res.status(429).json({ ok: false, error: "Too many messages. Please slow down a little." });
  }

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

// ---------- fallbacks ----------
// Anything not matched above — including every path under /backend and
// /.git — gets a plain 404 instead of a file.
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ ok: false, error: "Not found." });
  }
  res.status(404).type("text/plain").send("Not found");
});

// JSON error handler, so a thrown error never returns an HTML stack trace.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: "Something went wrong. Please try again or call the clinic." });
});

app.listen(PORT, () => {
  console.log("BrightSmile backend running at http://localhost:" + PORT);
  if (!mailer.isEnabled()) console.log("Email notifications disabled (set SMTP_HOST in .env to enable).");
  if (!ADMIN_KEY) console.log("WARNING: ADMIN_KEY not set — /api/appointments admin view is locked out.");
  if (!process.env.ANTHROPIC_API_KEY) console.log("WARNING: ANTHROPIC_API_KEY not set — the chat assistant is disabled.");
});
