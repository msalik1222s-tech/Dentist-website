// Staff-only endpoints, all behind ADMIN_KEY.
//
//   GET  /api/appointments              submitted and booked appointments
//   GET  /api/admin/handoffs            conversations waiting for a person
//   POST /api/admin/handoffs/:id/resolve
//   GET  /api/admin/sessions            recent conversations
//   GET  /api/admin/sessions/:id        one transcript
//
// The transcript endpoint returns patient conversations, so it is the most
// sensitive thing the API serves. It is admin-key gated like the rest, and the
// key should be treated as a shared password: long, random, rotated if it ever
// appears in a screenshot.

const express = require("express");

const store = require("../store");
const chatStore = require("../persistence/chat-store");
const { requireAdmin } = require("./middleware");

function createAdminRouter() {
  const router = express.Router();

  router.get("/appointments", requireAdmin, async (req, res, next) => {
    try {
      res.json({ ok: true, appointments: await store.loadAppointments() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/handoffs", requireAdmin, async (req, res, next) => {
    try {
      const status = req.query.status === "all" ? null : String(req.query.status || "open");
      res.json({ ok: true, handoffs: await chatStore.listHandoffs({ status, limit: 200 }) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/handoffs/:id/resolve", requireAdmin, async (req, res, next) => {
    try {
      const resolved = await chatStore.resolveHandoff(String(req.params.id));
      if (!resolved) return res.status(404).json({ ok: false, error: "No open handoff with that id." });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/sessions", requireAdmin, async (req, res, next) => {
    try {
      const sessions = await chatStore.listSessions({ limit: 100 });
      res.json({
        ok: true,
        sessions: sessions.map((s) => ({
          id: s.id,
          channel: s.channel,
          status: s.status,
          patientName: s.patientName,
          patientPhone: s.patientPhone,
          messageCount: s.messageCount,
          summary: s.summary,
          updatedAt: s.updatedAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/sessions/:id", requireAdmin, async (req, res, next) => {
    try {
      const session = await chatStore.getSession(String(req.params.id));
      if (!session) return res.status(404).json({ ok: false, error: "Session not found." });

      // 500 covers any conversation a person would actually read through.
      const messages = await chatStore.getRecentMessages(session.id, 500);
      res.json({
        ok: true,
        session: {
          id: session.id,
          channel: session.channel,
          status: session.status,
          patientName: session.patientName,
          patientPhone: session.patientPhone,
          summary: session.summary,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          meta: m.meta,
          at: m.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createAdminRouter };
