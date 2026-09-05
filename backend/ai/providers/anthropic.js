// Anthropic (Claude) adapter — see ./index.js for the contract.
//
// Uses the official SDK, which is already a dependency. The SDK is required
// lazily so a deployment running a different provider never loads it.

const errors = require("../errors");

// Normalised message -> Anthropic content blocks.
//
// The one shape worth calling out: Anthropic carries tool results in a *user*
// message made of tool_result blocks, not a dedicated role. Our "tool" role
// maps onto that.
function toAnthropicMessages(messages) {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "user",
        content: (m.toolResults || []).map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
          is_error: !!r.isError,
        })),
      };
    }

    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input || {} });
      }
      return { role: "assistant", content: blocks };
    }

    return { role: m.role === "assistant" ? "assistant" : "user", content: m.content || "" };
  });
}

function toAnthropicTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

function create(settings) {
  let client = null;

  function getClient() {
    if (!settings.apiKey) return null;
    if (!client) {
      const Anthropic = require("@anthropic-ai/sdk");
      client = new Anthropic({
        apiKey: settings.apiKey,
        ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
      });
    }
    return client;
  }

  return {
    id: "anthropic",
    model: settings.model,

    isConfigured() {
      return !!settings.apiKey;
    },

    async complete({ system, messages, tools, maxTokens, temperature, timeoutMs }) {
      const anthropic = getClient();
      if (!anthropic) throw errors.NOT_CONFIGURED();

      let response;
      try {
        response = await anthropic.messages.create(
          {
            model: settings.model,
            max_tokens: maxTokens,
            temperature,
            system,
            ...(tools && tools.length ? { tools: toAnthropicTools(tools) } : {}),
            messages: toAnthropicMessages(messages),
          },
          { timeout: timeoutMs }
        );
      } catch (err) {
        throw errors.PROVIDER_FAILED(err.message);
      }

      const blocks = response.content || [];
      return {
        text: blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim(),
        toolCalls: blocks
          .filter((b) => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
        stopReason: response.stop_reason || "end_turn",
        usage: {
          inputTokens: (response.usage && response.usage.input_tokens) || 0,
          outputTokens: (response.usage && response.usage.output_tokens) || 0,
        },
      };
    },
  };
}

module.exports = { create };
