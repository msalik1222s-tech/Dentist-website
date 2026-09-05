// Chat API for the website widget.
//
//   GET  /api/chat/config          is the assistant available, and what to greet with
//   POST /api/chat                 send a message, get a reply
//   GET  /api/chat/:sessionId      replay a conversation (used to restore the widget)
//
// Authentication for a session is the session id itself: 24 random bytes,
// unguessable, held only by the browser that started the conversation. That is
// the right trade-off for a clinic chat widget — a patient is not going to
// create an account to ask about opening hours — but it does mean the id is a
// credential, so it is never logged in full and never put in a URL the server
// records. Anyone who wants a stronger guarantee should put the widget behind
// the clinic's own login and pass the patient id through.

const express = require("express");

const agent = require("../ai/agent");
const errors = require("../ai/errors");
const chatStore = require("../persistence/chat-store");
const store = require("../store");
const config = require("../ai/config");
const { limiter } = require("./middleware");

// Sessions are keyed by an opaque hex token; anything else is not worth a
// database round trip.
function isSessionId(value) {
  return typeof value === "string" && /^[a-f0-9]{32,64}$/.test(value);
}

// Maps an AgentError to a status and a message the patient may see. Anything
// unrecognised becomes a generic 500 — an unexpected error's text can carry
// SQL or a provider response.
function fail(res, err) {
  if (err instanceof errors.AgentError) {
    if (err.status >= 500) console.error(`Chat error [${err.code}]:`, err.message);
    return res.status(err.status).json({ ok: false, error: err.safeMessage, code: err.code });
  }
  console.error("Chat error:", err);
  return res
    .status(500)
    .json({ ok: false, error: "Something went wrong. Please try again or call the clinic." });
}

function createChatRouter() {
  const router = express.Router();

  router.get("/chat/config", (req, res) => {
    const clinic = store.getClinicInfo();
    const status = agent.status();
    res.json({
      ok: true,
      enabled: status.enabled,
      assistantName: "Dental Care Assistant",
      clinicName: clinic.name,
      clinicPhone: clinic.phone,
      whatsapp: config.whatsapp.contactNumber || null,
      greeting: status.enabled
        ? `Hello! I'm the ${clinic.name} assistant. I can help with our dentists, services, prices, opening hours, or booking an appointment. What can I do for you?`
        : "Our chat assistant isn't available right now — please call the clinic and the team will be glad to help.",
    });
  });

  router.post("/chat", limiter("chat"), async (req, res) => {
    const body = req.body || {};

    // Two request shapes are accepted. The current one sends a session id and a
    // single message. The original widget sent the whole transcript with every
    // request; that still works, and the last user message is taken from it,
    // so a cached copy of the old page keeps functioning after a deploy.
    let message = typeof body.message === "string" ? body.message : "";
    if (!message && Array.isArray(body.messages)) {
      const lastUser = [...body.messages].reverse().find((m) => m && m.role === "user" && typeof m.content === "string");
      message = lastUser ? lastUser.content : "";
    }

    if (!message.trim()) {
      return res.status(400).json({ ok: false, error: "Please provide a message." });
    }
    if (body.sessionId !== undefined && body.sessionId !== null && !isSessionId(body.sessionId)) {
      return res.status(400).json({ ok: false, error: "Invalid session." });
    }

    try {
      const result = await agent.respond({
        message,
        sessionId: body.sessionId || null,
        channel: "web",
        locale: typeof body.locale === "string" ? body.locale.slice(0, 12) : null,
      });

      res.json({
        ok: true,
        reply: result.reply,
        sessionId: result.sessionId,
        handoff: result.handoff,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Lets the widget restore a conversation after a page reload. Only the
  // patient-visible turns come back: tool traffic stays server-side.
  router.get("/chat/:sessionId", limiter("chat"), async (req, res) => {
    if (!isSessionId(req.params.sessionId)) {
      return res.status(400).json({ ok: false, error: "Invalid session." });
    }

    try {
      const session = await chatStore.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ ok: false, error: "That conversation has expired." });

      const rows = await chatStore.getRecentMessages(session.id, config.memoryWindow * 2);
      res.json({
        ok: true,
        sessionId: session.id,
        status: session.status,
        messages: rows
          .filter((r) => (r.role === "user" || r.role === "assistant") && r.content)
          .map((r) => ({ role: r.role, content: r.content, at: r.createdAt })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}

module.exports = { createChatRouter, isSessionId };
