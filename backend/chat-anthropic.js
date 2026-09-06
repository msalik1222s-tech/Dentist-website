// Anthropic adapter for the clinic assistant.
//
// Kept as an alternative provider: set ANTHROPIC_API_KEY (and no
// OPENAI_API_KEY, or CHAT_PROVIDER=anthropic) to run the assistant on Claude
// instead of OpenAI. The tool catalogue and system prompt are shared with the
// OpenAI path via chat-tools.js.

const Anthropic = require("@anthropic-ai/sdk");
const { buildSystemPrompt, TOOLS, runTool, MAX_TURNS, FALLBACK_REPLY } = require("./chat-tools");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

// Anthropic calls the JSON Schema `input_schema`; otherwise the shared tool
// definitions carry over unchanged.
const ANTHROPIC_TOOLS = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters,
}));

let client = null;

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function getClient() {
  if (!isConfigured()) return null;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function classifyError(err) {
  const status = err && err.status;
  const apiType = (err && err.error && err.error.error && err.error.error.type) || "";

  let code = "CHAT_UPSTREAM_ERROR";
  if (status === 401 || apiType === "authentication_error") code = "CHAT_AUTH_FAILED";
  else if (status === 429) code = "CHAT_RATE_LIMITED";
  else if (status === 404 || apiType === "not_found_error") code = "CHAT_MODEL_UNAVAILABLE";

  console.error(
    `Anthropic request failed [${code}] model=${MODEL} status=${status || "n/a"}: ${err && err.message}`
  );
  return Object.assign(new Error(code), { code, cause: err });
}

async function respond(clientMessages) {
  const anthropic = getClient();
  if (!anthropic) throw Object.assign(new Error("CHAT_NOT_CONFIGURED"), { code: "CHAT_NOT_CONFIGURED" });

  const messages = clientMessages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  // Two blocks with the breakpoint after the static half, exactly as before:
  // the clock changes every minute and must stay outside the cached prefix.
  const prompt = buildSystemPrompt();
  const system = [
    { type: "text", text: prompt.cached, cache_control: { type: "ephemeral" } },
    { type: "text", text: prompt.volatile },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let resp;
    try {
      resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system,
        tools: ANTHROPIC_TOOLS,
        messages,
      });
    } catch (err) {
      throw classifyError(err);
    }

    if (resp.stop_reason !== "tool_use") {
      const text = resp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return text || FALLBACK_REPLY;
    }

    messages.push({ role: "assistant", content: resp.content });

    const toolResults = await Promise.all(
      resp.content
        .filter((b) => b.type === "tool_use")
        .map(async (block) => ({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(await runTool(block.name, block.input || {})),
        }))
    );

    messages.push({ role: "user", content: toolResults });
  }

  console.error(`Anthropic conversation hit the ${MAX_TURNS}-turn limit without a final answer.`);
  return FALLBACK_REPLY;
}

module.exports = { respond, isConfigured, model: MODEL };
