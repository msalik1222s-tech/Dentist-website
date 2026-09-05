// OpenAI (Chat Completions) adapter — see ./index.js for the contract.
//
// Talks to the REST API over global fetch rather than pulling in the SDK: the
// surface used here is small, and an unused dependency in every serverless
// bundle is a cost with no return. Any OpenAI-compatible gateway works by
// pointing OPENAI_BASE_URL at it.

const errors = require("../errors");
const { fetchJson } = require("./http");

function toOpenAIMessages(system, messages) {
  const out = [{ role: "system", content: system }];

  for (const m of messages) {
    if (m.role === "tool") {
      // OpenAI wants one message per tool result, keyed by tool_call_id.
      for (const r of m.toolResults || []) {
        out.push({ role: "tool", tool_call_id: r.id, content: r.content });
      }
      continue;
    }

    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
        })),
      });
      continue;
    }

    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content || "" });
  }

  return out;
}

function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// Arguments arrive as a JSON string and a model can emit a malformed one.
// A bad parse becomes an empty object, which the tool layer then rejects with
// a validation error the model can read and retry — better than a 500.
function parseArguments(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function create(settings) {
  return {
    id: "openai",
    model: settings.model,

    isConfigured() {
      return !!settings.apiKey;
    },

    async complete({ system, messages, tools, maxTokens, temperature, timeoutMs }) {
      if (!settings.apiKey) throw errors.NOT_CONFIGURED();

      const payload = {
        model: settings.model,
        max_completion_tokens: maxTokens,
        temperature,
        messages: toOpenAIMessages(system, messages),
      };
      if (tools && tools.length) {
        payload.tools = toOpenAITools(tools);
        payload.tool_choice = "auto";
      }

      const data = await fetchJson(
        settings.baseUrl.replace(/\/$/, "") + "/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + settings.apiKey,
          },
          body: JSON.stringify(payload),
        },
        timeoutMs
      );

      const choice = (data.choices && data.choices[0]) || {};
      const message = choice.message || {};

      return {
        text: (message.content || "").trim(),
        toolCalls: (message.tool_calls || [])
          .filter((c) => c.function)
          .map((c) => ({ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) })),
        stopReason: choice.finish_reason || "stop",
        usage: {
          inputTokens: (data.usage && data.usage.prompt_tokens) || 0,
          outputTokens: (data.usage && data.usage.completion_tokens) || 0,
        },
      };
    },
  };
}

module.exports = { create };
