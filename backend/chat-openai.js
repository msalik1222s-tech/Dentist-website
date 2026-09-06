// OpenAI adapter for the clinic assistant.
//
// Talks to the Chat Completions endpoint with function calling, translating
// the provider-neutral definitions in chat-tools.js into OpenAI's wire format
// and back. The API key lives only in this process — see backend/.env.example.

const { OpenAI } = require("openai");
const { buildSystemPrompt, TOOLS, runTool, MAX_TURNS, FALLBACK_REPLY } = require("./chat-tools");

// gpt-4o-mini is the default because it is cheap, fast, reliable at function
// calling, and available on every billed account. Override with OPENAI_MODEL.
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Optional: point at an OpenAI-compatible gateway (Azure OpenAI proxy, a local
// mock, LiteLLM...). Unset means api.openai.com.
const BASE_URL = process.env.OPENAI_BASE_URL || undefined;

// OpenAI wants each tool wrapped in a `function` envelope; the JSON Schema in
// `parameters` passes through untouched.
const OPENAI_TOOLS = TOOLS.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

let client = null;

function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

function getClient() {
  if (!isConfigured()) return null;
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: BASE_URL,
      // The Vercel function is capped at 60s, so a request must give up well
      // before that or the patient just sees a gateway timeout.
      timeout: 45000,
      maxRetries: 2,
    });
  }
  return client;
}

// Turns an OpenAI SDK error into a stable code that app.js can map to a
// patient-facing message, while logging the real cause for the operator.
function classifyError(err) {
  const status = err && err.status;
  const apiCode = (err && err.code) || (err && err.error && err.error.code) || "";

  let code = "CHAT_UPSTREAM_ERROR";
  if (status === 401 || apiCode === "invalid_api_key") code = "CHAT_AUTH_FAILED";
  else if (apiCode === "insufficient_quota" || apiCode === "billing_hard_limit_reached") code = "CHAT_QUOTA_EXCEEDED";
  else if (status === 429) code = "CHAT_RATE_LIMITED";
  else if (status === 404 || apiCode === "model_not_found") code = "CHAT_MODEL_UNAVAILABLE";

  console.error(
    `OpenAI request failed [${code}] model=${MODEL} status=${status || "n/a"} code=${apiCode || "n/a"}: ${err && err.message}`
  );
  return Object.assign(new Error(code), { code, cause: err });
}

// Models occasionally emit malformed JSON for arguments. Treat that as an
// empty call and let the tool's own validation answer, rather than throwing
// and killing the whole conversation.
function parseToolArguments(rawArguments, toolName) {
  if (!rawArguments) return {};
  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    console.error(`OpenAI returned unparseable arguments for ${toolName}: ${String(rawArguments).slice(0, 200)}`);
    return {};
  }
}

async function respond(clientMessages) {
  const openai = getClient();
  if (!openai) throw Object.assign(new Error("CHAT_NOT_CONFIGURED"), { code: "CHAT_NOT_CONFIGURED" });

  // The system prompt is rebuilt per request so the date, time and live clinic
  // data in it are never stale on a warm serverless instance.
  const prompt = buildSystemPrompt();
  const messages = [
    // Static clinic data first, the per-minute clock last: OpenAI caches a
    // stable prompt prefix automatically, and putting the clock earlier
    // would invalidate that prefix every minute.
    { role: "system", content: `${prompt.cached}
${prompt.volatile}` },
    ...clientMessages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: MODEL,
        messages,
        tools: OPENAI_TOOLS,
        tool_choice: "auto",
        // `max_completion_tokens` rather than the deprecated `max_tokens`, so
        // switching OPENAI_MODEL to a reasoning model keeps working.
        max_completion_tokens: 1024,
      });
    } catch (err) {
      throw classifyError(err);
    }

    const choice = completion.choices && completion.choices[0];
    if (!choice || !choice.message) {
      console.error("OpenAI returned no choices:", JSON.stringify(completion).slice(0, 500));
      return FALLBACK_REPLY;
    }

    const message = choice.message;
    const toolCalls = message.tool_calls || [];

    if (!toolCalls.length) {
      const text = (message.content || "").trim();
      return text || FALLBACK_REPLY;
    }

    // The assistant turn holding the tool calls must be replayed verbatim, and
    // every call it made needs a matching `tool` message or the next request
    // is rejected as malformed.
    messages.push(message);

    const results = await Promise.all(
      toolCalls.map(async (call) => {
        const fn = call.function || {};
        const output = await runTool(fn.name, parseToolArguments(fn.arguments, fn.name));
        return {
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(output),
        };
      })
    );

    messages.push(...results);
  }

  console.error(`OpenAI conversation hit the ${MAX_TURNS}-turn limit without a final answer.`);
  return FALLBACK_REPLY;
}

module.exports = { respond, isConfigured, model: MODEL };
