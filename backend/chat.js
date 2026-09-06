// Entry point for the AI chat assistant.
//
// Picks an LLM provider and hands the conversation to its adapter. OpenAI is
// the default; Anthropic remains supported so the site keeps working if you
// switch keys. The API key is read from the environment here in the backend
// and is never sent to the browser — public/index.html only ever talks to
// POST /api/chat.
//
// Selection order:
//   1. CHAT_PROVIDER=openai|anthropic, if set (explicit wins)
//   2. whichever of OPENAI_API_KEY / ANTHROPIC_API_KEY is present
//   3. both present and no CHAT_PROVIDER -> OpenAI

const openai = require("./chat-openai");
const anthropic = require("./chat-anthropic");

const PROVIDERS = { openai, anthropic };

function selectProvider() {
  const requested = String(process.env.CHAT_PROVIDER || "").trim().toLowerCase();
  if (requested) {
    const provider = PROVIDERS[requested];
    if (!provider) {
      console.error(`Unknown CHAT_PROVIDER "${requested}" — expected "openai" or "anthropic".`);
      return null;
    }
    if (!provider.isConfigured()) {
      console.error(`CHAT_PROVIDER is "${requested}" but its API key is not set — the chat assistant is disabled.`);
      return null;
    }
    return { name: requested, provider };
  }

  if (openai.isConfigured()) return { name: "openai", provider: openai };
  if (anthropic.isConfigured()) return { name: "anthropic", provider: anthropic };
  return null;
}

// Resolved per call rather than at module load so a key added to the
// environment is picked up without editing code, and so tests can swap it.
function getActiveProvider() {
  return selectProvider();
}

// Reported at startup by server.js; also handy for a health check.
function status() {
  const active = selectProvider();
  return {
    enabled: !!active,
    provider: active ? active.name : null,
    model: active ? active.provider.model : null,
  };
}

async function respond(clientMessages) {
  const active = getActiveProvider();
  if (!active) throw Object.assign(new Error("CHAT_NOT_CONFIGURED"), { code: "CHAT_NOT_CONFIGURED" });
  return active.provider.respond(clientMessages);
}

module.exports = { respond, status };
