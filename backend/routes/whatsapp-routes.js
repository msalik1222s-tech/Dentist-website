// WhatsApp webhook.
//
//   GET  /api/whatsapp/webhook   Meta's subscription handshake
//   POST /api/whatsapp/webhook   inbound messages
//
// Every POST is signature-verified before anything is read out of it. An
// unverified request is rejected with 403 and never reaches the agent.

const express = require("express");

const whatsapp = require("../ai/channels/whatsapp");

function createWhatsappRouter() {
  const router = express.Router();

  router.get("/whatsapp/webhook", (req, res) => {
    const result = whatsapp.webhook.verifySubscription(req.query || {});
    res.status(result.status).type("text/plain").send(result.body);
  });

  router.post("/whatsapp/webhook", async (req, res) => {
    if (!whatsapp.isEnabled()) {
      return res.status(503).json({ ok: false, error: "WhatsApp is not configured." });
    }

    const verified = whatsapp.webhook.verifyRequest(req);
    if (!verified.ok) {
      console.warn("Rejected WhatsApp webhook:", verified.reason);
      return res.status(403).json({ ok: false, error: "Forbidden." });
    }

    let messages = [];
    try {
      messages = whatsapp.webhook.parsePayload(req.body || {});
    } catch (err) {
      console.error("Malformed WhatsApp payload:", err.message);
    }

    // Status callbacks (delivered, read) parse to nothing. Acknowledge and stop.
    if (!messages.length) return res.json({ ok: true, handled: 0 });

    try {
      const results = await whatsapp.handleMessages(messages);
      return res.json({ ok: true, handled: results.length });
    } catch (err) {
      // Deliberately still a 200: the platform retries anything else, and a
      // retry would answer a patient who has already been answered.
      console.error("WhatsApp webhook processing failed:", err.message);
      return res.json({ ok: true, handled: 0, error: "processing_failed" });
    }
  });

  return router;
}

module.exports = { createWhatsappRouter };
