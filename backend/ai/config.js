// Every knob the AI agent has, read from the environment in one place.
//
// Read at module load, like the rest of the backend: on Vercel the values are
// baked in at deploy time, so re-reading process.env per request would buy
// nothing.

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

// Which provider to use. Explicit AI_PROVIDER wins; otherwise the first
// provider with a key configured, so an existing deployment that only has
// ANTHROPIC_API_KEY set keeps working untouched.
function detectProvider() {
  const explicit = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
  if (explicit) return explicit;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) return "google";
  return "anthropic";
}

const config = {
  provider: detectProvider(),

  // Per-provider settings. A provider only reads its own block.
  providers: {
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || "",
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
      baseUrl: process.env.ANTHROPIC_BASE_URL || "",
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    },
    google: {
      apiKey: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "",
      model: process.env.GOOGLE_MODEL || "gemini-2.0-flash",
      baseUrl: process.env.GOOGLE_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
    },
    mock: {},
  },

  // Generation
  maxTokens: num(process.env.AI_MAX_TOKENS, 1024),
  temperature: Number(process.env.AI_TEMPERATURE) >= 0 ? Number(process.env.AI_TEMPERATURE) : 0.3,
  requestTimeoutMs: num(process.env.AI_TIMEOUT_MS, 45000),
  maxToolTurns: num(process.env.AI_MAX_TOOL_TURNS, 6),

  // Memory
  memoryWindow: num(process.env.AI_MEMORY_WINDOW, 16),
  summaryTriggerAt: num(process.env.AI_SUMMARY_TRIGGER, 24),
  summaryMaxChars: num(process.env.AI_SUMMARY_MAX_CHARS, 1200),
  maxMessageChars: num(process.env.AI_MAX_MESSAGE_CHARS, 2000),

  // Guardrails
  strictPriceGuard: bool(process.env.AI_STRICT_PRICE_GUARD, false),
  maxSessionMessages: num(process.env.AI_MAX_SESSION_MESSAGES, 300),

  // WhatsApp
  whatsapp: {
    enabled: bool(process.env.WHATSAPP_ENABLED, !!process.env.WHATSAPP_TOKEN || !!process.env.TWILIO_AUTH_TOKEN),
    provider: String(process.env.WHATSAPP_PROVIDER || "meta").toLowerCase(),
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
    appSecret: process.env.WHATSAPP_APP_SECRET || "",
    token: process.env.WHATSAPP_TOKEN || "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION || "v21.0",
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
    twilioFrom: process.env.TWILIO_WHATSAPP_FROM || "",
    publicUrl: process.env.PUBLIC_BASE_URL || "",
    // Patient-facing number shown when the agent points someone at WhatsApp.
    contactNumber: process.env.WHATSAPP_CONTACT_NUMBER || "",
  },
};

module.exports = config;
