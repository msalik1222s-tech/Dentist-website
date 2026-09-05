// Google Gemini adapter — see ./index.js for the contract.
//
// REST over global fetch, for the same reason as the OpenAI adapter.

const errors = require("../errors");
const { fetchJson } = require("./http");

// Gemini differs from the others in three ways this function absorbs:
//   * the assistant role is called "model";
//   * tool calls and their results are `parts` inside a normal turn, not a
//     separate role — results go back as a "user" turn of functionResponse;
//   * the system prompt is a top-level systemInstruction, not a message.
function toGeminiContents(messages) {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "user",
        parts: (m.toolResults || []).map((r) => ({
          functionResponse: {
            name: r.name,
            response: { result: r.content },
          },
        })),
      };
    }

    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length) {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.input || {} } });
      }
      return { role: "model", parts };
    }

    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content || "" }],
    };
  });
}

// Gemini rejects JSON Schema keywords it doesn't implement, so the schema is
// reduced to the subset it accepts.
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const out = { type: schema.type || "object" };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.type === "array" && schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = toGeminiSchema(value);
    }
  }
  if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required;
  // An object with no properties is invalid in Gemini's schema dialect.
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

// Gemini has no id for a function call, but the rest of the agent keys tool
// results by id — so one is synthesised per call.
function callId(name, index) {
  return `${name}_${index}`;
}

function create(settings) {
  return {
    id: "google",
    model: settings.model,

    isConfigured() {
      return !!settings.apiKey;
    },

    async complete({ system, messages, tools, maxTokens, temperature, timeoutMs }) {
      if (!settings.apiKey) throw errors.NOT_CONFIGURED();

      const payload = {
        systemInstruction: { parts: [{ text: system }] },
        contents: toGeminiContents(messages),
        generationConfig: { maxOutputTokens: maxTokens, temperature },
      };
      if (tools && tools.length) {
        payload.tools = [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: toGeminiSchema(t.parameters),
            })),
          },
        ];
      }

      const url =
        settings.baseUrl.replace(/\/$/, "") +
        "/models/" +
        encodeURIComponent(settings.model) +
        ":generateContent";

      const data = await fetchJson(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": settings.apiKey,
          },
          body: JSON.stringify(payload),
        },
        timeoutMs
      );

      const candidate = (data.candidates && data.candidates[0]) || {};
      const parts = (candidate.content && candidate.content.parts) || [];

      const toolCalls = [];
      const textParts = [];
      parts.forEach((part, i) => {
        if (part.functionCall) {
          toolCalls.push({
            id: callId(part.functionCall.name, i),
            name: part.functionCall.name,
            input: part.functionCall.args || {},
          });
        } else if (typeof part.text === "string") {
          textParts.push(part.text);
        }
      });

      const usage = data.usageMetadata || {};
      return {
        text: textParts.join("\n").trim(),
        toolCalls,
        stopReason: toolCalls.length ? "tool_use" : candidate.finishReason || "STOP",
        usage: {
          inputTokens: usage.promptTokenCount || 0,
          outputTokens: usage.candidatesTokenCount || 0,
        },
      };
    },
  };
}

module.exports = { create };
