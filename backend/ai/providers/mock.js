// Scripted provider — see ./index.js for the contract.
//
// Exists so the agent loop, the guardrails, the tools and the memory manager
// can be tested end to end without an API key or a network call. The queue is
// module-level, not per-instance, because the registry caches one instance per
// process and tests need to reach it.
//
// Never selected implicitly: a deployment gets it only by setting
// AI_PROVIDER=mock.

const queue = [];
const calls = [];

// Each entry is a partial Completion; anything omitted gets a sensible default.
function setScript(responses) {
  queue.length = 0;
  for (const r of responses) queue.push(r);
  calls.length = 0;
}

function getCalls() {
  return calls.slice();
}

function create() {
  return {
    id: "mock",
    model: "mock-1",

    isConfigured() {
      return true;
    },

    async complete(request) {
      calls.push(request);
      const next = queue.shift() || {
        text: "This is a scripted reply from the mock provider.",
      };
      if (typeof next === "function") return normalise(next(request));
      return normalise(next);
    },
  };
}

function normalise(response) {
  const toolCalls = (response.toolCalls || []).map((c, i) => ({
    id: c.id || `mock_call_${i}`,
    name: c.name,
    input: c.input || {},
  }));
  return {
    text: response.text || "",
    toolCalls,
    stopReason: response.stopReason || (toolCalls.length ? "tool_use" : "end_turn"),
    usage: response.usage || { inputTokens: 0, outputTokens: 0 },
  };
}

module.exports = { create, setScript, getCalls };
