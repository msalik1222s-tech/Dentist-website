require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const chat = require("./chat");

const ROOT = path.join(__dirname, "..");
const DATA_FILE = path.join(__dirname, "data", "appointments.json");
const PORT = process.env.PORT || 5500;
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const app = express();
app.use(express.json());
app.use(express.static(ROOT, { extensions: ["html"] }));

// ---------- storage ----------
function loadAppointments() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveAppointments(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

// ---------- mailer (optional) ----------
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

async function notifyClinic(entry) {
  if (!transporter || !process.env.CLINIC_EMAIL) return;
  try {
    await transporter.sendMail({
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: process.env.CLINIC_EMAIL,
      replyTo: undefined,
      subject: `New appointment request — ${entry.name}`,
      text: [
        `Name: ${entry.name}`,
        `Phone: ${entry.phone}`,
        `Preferred date: ${entry.date}`,
        `Service: ${entry.service || "-"}`,
        `Message: ${entry.message || "-"}`,
        `Submitted: ${entry.createdAt}`,
      ].join("\n"),
    });
  } catch (err) {
    console.error("Email notification failed:", err.message);
  }
}

// ---------- simple in-memory rate limiting ----------
function makeRateLimiter(windowMs, maxPerWindow) {
  const hits = new Map();
  return function isRateLimited(ip) {
    const now = Date.now();
    const timestamps = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    timestamps.push(now);
    hits.set(ip, timestamps);
    return timestamps.length > maxPerWindow;
  };
}

const isRateLimited = makeRateLimiter(10 * 60 * 1000, 5);
const isChatRateLimited = makeRateLimiter(60 * 1000, 15);

function getClientIp(req) {
  return req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
}

// ---------- validation ----------
function validate(body) {
  const errors = [];
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const date = String(body.date || "").trim();
  const service = String(body.service || "").trim();
  const message = String(body.message || "").trim();

  if (!name || name.length > 100) errors.push("Please provide a valid name.");
  if (!phone || phone.replace(/[^0-9+]/g, "").length < 7 || phone.length > 30) {
    errors.push("Please provide a valid phone number.");
  }
  if (!date || Number.isNaN(Date.parse(date))) {
    errors.push("Please provide a valid preferred date.");
  }
  if (service.length > 100) errors.push("Service value is too long.");
  if (message.length > 1000) errors.push("Message is too long (max 1000 characters).");

  return { errors, clean: { name, phone, date, service, message } };
}

// ---------- routes ----------
app.post("/api/appointments", async (req, res) => {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ ok: false, error: "Too many requests. Please try again later." });
  }

  const { errors, clean } = validate(req.body || {});
  if (errors.length) {
    return res.status(400).json({ ok: false, error: errors[0] });
  }

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    ...clean,
    createdAt: new Date().toISOString(),
  };

  const list = loadAppointments();
  list.push(entry);
  saveAppointments(list);

  notifyClinic(entry);

  res.status(201).json({ ok: true, message: `Thanks ${clean.name.split(" ")[0]}! Your request is noted — we'll call you shortly to confirm.` });
});

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }
  next();
}

app.get("/api/appointments", requireAdmin, (req, res) => {
  const list = loadAppointments().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ ok: true, appointments: list });
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

app.listen(PORT, () => {
  console.log("BrightSmile backend running at http://localhost:" + PORT);
  if (!transporter) console.log("Email notifications disabled (set SMTP_HOST in .env to enable).");
  if (!ADMIN_KEY) console.log("WARNING: ADMIN_KEY not set — /api/appointments admin view is locked out.");
  if (!process.env.ANTHROPIC_API_KEY) console.log("WARNING: ANTHROPIC_API_KEY not set — the chat assistant is disabled.");
});
