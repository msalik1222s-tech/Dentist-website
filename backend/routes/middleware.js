// Cross-cutting request middleware, shared by every router.

const store = require("../store");

const ADMIN_KEY = process.env.ADMIN_KEY || "";

// Vercel puts the real client address at the front of x-forwarded-for; the
// rest of the list is proxy hops and must not be treated as the identity.
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "unknown";
}

// Counters live in the database so the limits hold across serverless
// instances rather than resetting whenever a new one starts.
const LIMITS = {
  appointments: { windowMs: 10 * 60 * 1000, max: 5 },
  chat: { windowMs: 60 * 1000, max: 15 },
  availability: { windowMs: 60 * 1000, max: 30 },
  catalog: { windowMs: 60 * 1000, max: 60 },
};

const MESSAGES = {
  chat: "Too many messages. Please slow down a little.",
};

function limiter(bucket) {
  const { windowMs, max } = LIMITS[bucket];
  return async function checkRateLimit(req, res, next) {
    if (await store.isRateLimited(bucket, getClientIp(req), windowMs, max)) {
      return res.status(429).json({ ok: false, error: MESSAGES[bucket] || "Too many requests. Please try again later." });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }
  next();
}

module.exports = { getClientIp, limiter, requireAdmin, LIMITS, ADMIN_KEY };
