// Provider registry — the seam that keeps the agent independent of any one LLM.
//
// Nothing above this directory imports a vendor SDK or knows a vendor's message
// shape. Swapping models is a change to AI_PROVIDER, and supporting a new
// vendor means adding one file here that satisfies the contract below.
//
// ---------------------------------------------------------------------------
// THE CONTRACT
// ---------------------------------------------------------------------------
//
// A provider is an object:
//
//   {
//     id: string,                 // "anthropic", "openai", ...
//     model: string,
//     isConfigured(): boolean,    // false when the API key is missing
//     complete(request): Promise<Completion>
//   }
//
// request:
//   {
//     system: string,             // system prompt
//     messages: Message[],        // normalised conversation, oldest first
//     tools: ToolDefinition[],    // may be empty
//     maxTokens: number,
//     temperature: number,
//     timeoutMs: number
//   }
//
// Message — one of:
//   { role: "user",      content: string }
//   { role: "assistant", content: string, toolCalls?: ToolCall[] }
//   { role: "tool",      toolResults: ToolResult[] }
//
// ToolCall:    { id: string, name: string, input: object }
// ToolResult:  { id: string, name: string, content: string, isError?: boolean }
//
// ToolDefinition:
//   { name: string, description: string, parameters: JSONSchema }
//
// Completion:
//   {
//     text: string,               // "" when the model only asked for tools
//     toolCalls: ToolCall[],      // empty when it produced a final answer
//     stopReason: string,
//     usage: { inputTokens, outputTokens }
//   }
//
// Adapters must not throw vendor error objects: wrap failures in
// errors.PROVIDER_FAILED so nothing vendor-shaped leaks into a response.

const config = require("../config");
const errors = require("../errors");

const FACTORIES = {
  anthropic: () => require("./anthropic"),
  openai: () => require("./openai"),
  google: () => require("./google"),
  mock: () => require("./mock"),
};

const instances = new Map();

// Providers are cached per process so an SDK client and its keep-alive sockets
// survive across requests on a warm serverless instance.
function getProvider(name) {
  const id = String(name || config.provider).toLowerCase();
  const factory = FACTORIES[id];
  if (!factory) {
    throw new errors.AgentError("UNKNOWN_PROVIDER", `Unknown AI provider: ${id}`, {
      status: 500,
      safeMessage: "The chat assistant isn't set up correctly. Please call the clinic.",
    });
  }
  if (!instances.has(id)) instances.set(id, factory().create(config.providers[id] || {}));
  return instances.get(id);
}

function isConfigured(name) {
  try {
    return getProvider(name).isConfigured();
  } catch {
    return false;
  }
}

function listProviders() {
  return Object.keys(FACTORIES);
}

module.exports = { getProvider, isConfigured, listProviders };
