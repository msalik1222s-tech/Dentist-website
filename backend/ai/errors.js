// Typed errors so the route layer can pick an HTTP status and a patient-safe
// message without string-matching on err.message.

class AgentError extends Error {
  constructor(code, message, { status = 500, safeMessage } = {}) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.status = status;
    // What the patient is allowed to see. Never the raw message: that can
    // carry provider responses, SQL text or connection strings.
    this.safeMessage = safeMessage || "Something went wrong. Please try again or call the clinic.";
  }
}

const NOT_CONFIGURED = () =>
  new AgentError("NOT_CONFIGURED", "No AI provider is configured", {
    status: 503,
    safeMessage: "The chat assistant isn't set up yet — please call the clinic directly.",
  });

const PROVIDER_FAILED = (detail) =>
  new AgentError("PROVIDER_FAILED", "AI provider request failed: " + detail, {
    status: 502,
    safeMessage:
      "I'm having trouble reaching the assistant right now. Please try again in a moment, or call the clinic.",
  });

const SESSION_NOT_FOUND = () =>
  new AgentError("SESSION_NOT_FOUND", "Chat session not found", {
    status: 404,
    safeMessage: "That conversation has expired. Please start a new chat.",
  });

const SESSION_TOO_LONG = () =>
  new AgentError("SESSION_TOO_LONG", "Chat session exceeded its message limit", {
    status: 429,
    safeMessage:
      "This conversation has gone on for a while — please start a new chat, or call the clinic and the team will pick up where we left off.",
  });

const INVALID_INPUT = (safeMessage) =>
  new AgentError("INVALID_INPUT", "Invalid chat input", {
    status: 400,
    safeMessage: safeMessage || "Please provide a valid message.",
  });

module.exports = {
  AgentError,
  NOT_CONFIGURED,
  PROVIDER_FAILED,
  SESSION_NOT_FOUND,
  SESSION_TOO_LONG,
  INVALID_INPUT,
};
