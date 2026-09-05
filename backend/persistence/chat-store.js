// Persistence for conversations: sessions, message history, human-handoff
// requests, and de-duplication of inbound webhook events.
//
// Same two-driver arrangement as backend/db.js — Postgres when DATABASE_URL is
// set, a JSON file for local development — behind one async interface.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const pg = require("../pg");

const ON_VERCEL = !!process.env.VERCEL;

// Session ids are bearer credentials: whoever holds one can read that
// conversation's history, so they must be unguessable, not sequential.
function newSessionId() {
  return crypto.randomBytes(24).toString("hex");
}

function newId(prefix) {
  return prefix + "_" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id            text PRIMARY KEY,
    channel       text NOT NULL DEFAULT 'web',
    external_id   text,
    locale        text,
    patient_name  text,
    patient_phone text,
    summary       text NOT NULL DEFAULT '',
    facts         jsonb NOT NULL DEFAULT '{}'::jsonb,
    status        text NOT NULL DEFAULT 'active',
    message_count int NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
  );

  -- One conversation per WhatsApp number: the webhook looks a session up by
  -- (channel, external_id) rather than starting a new one for every message.
  CREATE UNIQUE INDEX IF NOT EXISTS chat_sessions_external_idx
    ON chat_sessions (channel, external_id) WHERE external_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS chat_sessions_updated_idx ON chat_sessions (updated_at DESC);

  CREATE TABLE IF NOT EXISTS chat_messages (
    id         bigserial PRIMARY KEY,
    session_id text NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role       text NOT NULL,
    content    text NOT NULL DEFAULT '',
    meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS chat_messages_session_idx ON chat_messages (session_id, id);

  CREATE TABLE IF NOT EXISTS handoffs (
    id            text PRIMARY KEY,
    session_id    text,
    channel       text NOT NULL DEFAULT 'web',
    reason        text NOT NULL DEFAULT '',
    summary       text NOT NULL DEFAULT '',
    patient_name  text,
    patient_phone text,
    status        text NOT NULL DEFAULT 'open',
    created_at    timestamptz NOT NULL DEFAULT now(),
    resolved_at   timestamptz
  );

  CREATE INDEX IF NOT EXISTS handoffs_status_idx ON handoffs (status, created_at DESC);

  -- Messaging platforms retry deliveries. This primary key is what stops one
  -- WhatsApp message being answered twice.
  CREATE TABLE IF NOT EXISTS inbound_events (
    id          text PRIMARY KEY,
    channel     text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
  );
`;

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

function createPostgresChatStore() {
  const pool = pg.getPool();
  const init = pg.once(() => pool.query(SCHEMA));

  async function query(text, params) {
    await init();
    return pool.query(text, params);
  }

  const SESSION_COLUMNS =
    "id, channel, external_id, locale, patient_name, patient_phone, summary, facts, status, message_count, created_at, updated_at";

  function toSession(row) {
    if (!row) return null;
    return {
      id: row.id,
      channel: row.channel,
      externalId: row.external_id || null,
      locale: row.locale || null,
      patientName: row.patient_name || null,
      patientPhone: row.patient_phone || null,
      summary: row.summary || "",
      facts: row.facts || {},
      status: row.status,
      messageCount: row.message_count,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  function toHandoff(row) {
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      channel: row.channel,
      reason: row.reason,
      summary: row.summary,
      patientName: row.patient_name,
      patientPhone: row.patient_phone,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    };
  }

  const HANDOFF_COLUMNS =
    "id, session_id, channel, reason, summary, patient_name, patient_phone, status, created_at, resolved_at";

  return {
    async createSession({ channel = "web", externalId = null, locale = null } = {}) {
      const { rows } = await query(
        `INSERT INTO chat_sessions (id, channel, external_id, locale)
         VALUES ($1,$2,$3,$4) RETURNING ${SESSION_COLUMNS}`,
        [newSessionId(), channel, externalId, locale]
      );
      return toSession(rows[0]);
    },

    async getSession(id) {
      const { rows } = await query(`SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE id = $1`, [id]);
      return toSession(rows[0]);
    },

    // Atomic get-or-create: two WhatsApp messages arriving at once on two
    // instances must not produce two sessions for the same number.
    async getOrCreateByExternalId({ channel, externalId, locale = null }) {
      const { rows } = await query(
        `INSERT INTO chat_sessions (id, channel, external_id, locale)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (channel, external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET updated_at = now()
         RETURNING ${SESSION_COLUMNS}`,
        [newSessionId(), channel, externalId, locale]
      );
      return toSession(rows[0]);
    },

    async updateSession(id, patch) {
      const columns = {
        locale: "locale",
        patientName: "patient_name",
        patientPhone: "patient_phone",
        summary: "summary",
        facts: "facts",
        status: "status",
      };
      const sets = [];
      const params = [id];
      for (const [key, column] of Object.entries(columns)) {
        if (patch[key] === undefined) continue;
        params.push(key === "facts" ? JSON.stringify(patch[key]) : patch[key]);
        sets.push(`${column} = $${params.length}${key === "facts" ? "::jsonb" : ""}`);
      }
      if (!sets.length) return this.getSession(id);
      const { rows } = await query(
        `UPDATE chat_sessions SET ${sets.join(", ")}, updated_at = now()
         WHERE id = $1 RETURNING ${SESSION_COLUMNS}`,
        params
      );
      return toSession(rows[0]);
    },

    async appendMessages(sessionId, messages) {
      if (!messages.length) return;
      const values = [];
      const params = [sessionId];
      for (const m of messages) {
        params.push(m.role, m.content || "", JSON.stringify(m.meta || {}));
        values.push(`($1, $${params.length - 2}, $${params.length - 1}, $${params.length}::jsonb)`);
      }
      await query(
        `INSERT INTO chat_messages (session_id, role, content, meta) VALUES ${values.join(", ")}`,
        params
      );
      await query(
        `UPDATE chat_sessions SET message_count = message_count + $2, updated_at = now() WHERE id = $1`,
        [sessionId, messages.length]
      );
    },

    // Newest `limit` rows, returned oldest-first so they replay straight into
    // the model as conversation history.
    async getRecentMessages(sessionId, limit) {
      const { rows } = await query(
        `SELECT id, role, content, meta, created_at FROM (
           SELECT id, role, content, meta, created_at FROM chat_messages
           WHERE session_id = $1 ORDER BY id DESC LIMIT $2
         ) recent ORDER BY id ASC`,
        [sessionId, limit]
      );
      return rows.map((r) => ({
        id: Number(r.id),
        role: r.role,
        content: r.content,
        meta: r.meta || {},
        createdAt: new Date(r.created_at).toISOString(),
      }));
    },

    async countMessages(sessionId) {
      const { rows } = await query(
        `SELECT count(*)::int AS c FROM chat_messages WHERE session_id = $1`,
        [sessionId]
      );
      return rows[0].c;
    },

    // Used by the summariser: the older messages about to fall out of the live
    // window, which need folding into the running summary first.
    async getMessagesBefore(sessionId, beforeId, limit) {
      const { rows } = await query(
        `SELECT id, role, content FROM (
           SELECT id, role, content FROM chat_messages
           WHERE session_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3
         ) older ORDER BY id ASC`,
        [sessionId, beforeId, limit]
      );
      return rows.map((r) => ({ id: Number(r.id), role: r.role, content: r.content }));
    },

    async createHandoff(entry) {
      const { rows } = await query(
        `INSERT INTO handoffs (id, session_id, channel, reason, summary, patient_name, patient_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${HANDOFF_COLUMNS}`,
        [
          newId("ho"),
          entry.sessionId || null,
          entry.channel || "web",
          entry.reason || "",
          entry.summary || "",
          entry.patientName || null,
          entry.patientPhone || null,
        ]
      );
      return toHandoff(rows[0]);
    },

    async listHandoffs({ status, limit = 100 } = {}) {
      const { rows } = await query(
        `SELECT ${HANDOFF_COLUMNS} FROM handoffs
         WHERE ($1::text IS NULL OR status = $1)
         ORDER BY created_at DESC LIMIT $2`,
        [status || null, limit]
      );
      return rows.map(toHandoff);
    },

    async resolveHandoff(id) {
      const { rows } = await query(
        `UPDATE handoffs SET status = 'resolved', resolved_at = now()
         WHERE id = $1 AND status <> 'resolved' RETURNING id`,
        [id]
      );
      return !!rows[0];
    },

    async listSessions({ limit = 50 } = {}) {
      const { rows } = await query(
        `SELECT ${SESSION_COLUMNS} FROM chat_sessions ORDER BY updated_at DESC LIMIT $1`,
        [limit]
      );
      return rows.map(toSession);
    },

    // True the first time an event id is seen, false on every retry, so the
    // caller can drop duplicate webhook deliveries.
    async markEventSeen(channel, eventId) {
      const { rows } = await query(
        `INSERT INTO inbound_events (id, channel) VALUES ($1,$2)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [eventId, channel]
      );
      if (Math.random() < 0.02) {
        // Opportunistic cleanup so the table cannot grow without bound.
        query("DELETE FROM inbound_events WHERE received_at < now() - interval '2 days'").catch(() => {});
      }
      return !!rows[0];
    },
  };
}

// ---------------------------------------------------------------------------
// JSON file (local development)
// ---------------------------------------------------------------------------

function createFileChatStore() {
  // DATA_DIR lets the test suite point the file store at a temporary directory
  // instead of writing over a developer's own data.
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
  const DATA_FILE = path.join(DATA_DIR, "chat-history.json");

  function assertWritableHost() {
    if (!ON_VERCEL) return;
    throw Object.assign(
      new Error(
        "DATABASE_URL is not set. Vercel's filesystem is read-only, so chat history cannot " +
          "be saved. Add a Postgres connection string as DATABASE_URL in Project Settings " +
          "-> Environment Variables and redeploy."
      ),
      { code: "NO_DATABASE_URL" }
    );
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      return {
        sessions: parsed.sessions || [],
        messages: parsed.messages || [],
        handoffs: parsed.handoffs || [],
        events: parsed.events || [],
        nextMessageId: parsed.nextMessageId || 1,
      };
    } catch {
      return { sessions: [], messages: [], handoffs: [], events: [], nextMessageId: 1 };
    }
  }

  function save(state) {
    assertWritableHost();
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  }

  function blankSession({ channel, externalId, locale }) {
    const now = new Date().toISOString();
    return {
      id: newSessionId(),
      channel: channel || "web",
      externalId: externalId || null,
      locale: locale || null,
      patientName: null,
      patientPhone: null,
      summary: "",
      facts: {},
      status: "active",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  return {
    async createSession(options) {
      const state = load();
      const session = blankSession(options || {});
      state.sessions.push(session);
      save(state);
      return { ...session };
    },

    async getSession(id) {
      return load().sessions.find((s) => s.id === id) || null;
    },

    async getOrCreateByExternalId({ channel, externalId, locale }) {
      const state = load();
      const existing = state.sessions.find((s) => s.channel === channel && s.externalId === externalId);
      if (existing) return { ...existing };
      const session = blankSession({ channel, externalId, locale });
      state.sessions.push(session);
      save(state);
      return { ...session };
    },

    async updateSession(id, patch) {
      const state = load();
      const session = state.sessions.find((s) => s.id === id);
      if (!session) return null;
      for (const key of ["locale", "patientName", "patientPhone", "summary", "facts", "status"]) {
        if (patch[key] !== undefined) session[key] = patch[key];
      }
      session.updatedAt = new Date().toISOString();
      save(state);
      return { ...session };
    },

    async appendMessages(sessionId, messages) {
      if (!messages.length) return;
      const state = load();
      const session = state.sessions.find((s) => s.id === sessionId);
      for (const m of messages) {
        state.messages.push({
          id: state.nextMessageId++,
          sessionId,
          role: m.role,
          content: m.content || "",
          meta: m.meta || {},
          createdAt: new Date().toISOString(),
        });
      }
      if (session) {
        session.messageCount += messages.length;
        session.updatedAt = new Date().toISOString();
      }
      save(state);
    },

    async getRecentMessages(sessionId, limit) {
      return load()
        .messages.filter((m) => m.sessionId === sessionId)
        .slice(-limit)
        .map((m) => ({ ...m }));
    },

    async countMessages(sessionId) {
      return load().messages.filter((m) => m.sessionId === sessionId).length;
    },

    async getMessagesBefore(sessionId, beforeId, limit) {
      return load()
        .messages.filter((m) => m.sessionId === sessionId && m.id < beforeId)
        .slice(-limit)
        .map((m) => ({ id: m.id, role: m.role, content: m.content }));
    },

    async createHandoff(entry) {
      const state = load();
      const handoff = {
        id: newId("ho"),
        sessionId: entry.sessionId || null,
        channel: entry.channel || "web",
        reason: entry.reason || "",
        summary: entry.summary || "",
        patientName: entry.patientName || null,
        patientPhone: entry.patientPhone || null,
        status: "open",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      };
      state.handoffs.push(handoff);
      save(state);
      return { ...handoff };
    },

    async listHandoffs({ status, limit = 100 } = {}) {
      return load()
        .handoffs.filter((h) => !status || h.status === status)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit);
    },

    async resolveHandoff(id) {
      const state = load();
      const handoff = state.handoffs.find((h) => h.id === id && h.status !== "resolved");
      if (!handoff) return false;
      handoff.status = "resolved";
      handoff.resolvedAt = new Date().toISOString();
      save(state);
      return true;
    },

    async listSessions({ limit = 50 } = {}) {
      return load()
        .sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, limit);
    },

    async markEventSeen(channel, eventId) {
      const state = load();
      if (state.events.some((e) => e.id === eventId)) return false;
      state.events.push({ id: eventId, channel, receivedAt: new Date().toISOString() });
      if (state.events.length > 500) state.events = state.events.slice(-500);
      save(state);
      return true;
    },
  };
}

const store = pg.isPostgres ? createPostgresChatStore() : createFileChatStore();

module.exports = Object.assign({ isPostgres: pg.isPostgres }, store);
