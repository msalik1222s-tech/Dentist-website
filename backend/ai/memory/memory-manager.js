// Session memory.
//
// A serverless instance does not survive between requests, so "memory" means
// the database. This module is the only thing that reads or writes it on the
// agent's behalf, and it hands the agent a Conversation object for one turn.
//
// Three kinds of memory, with different lifetimes:
//
//   * Replay window — the last N user/assistant turns, sent to the model
//     verbatim. Short, so the token cost per message stays flat however long
//     the conversation runs.
//
//   * Rolling summary — everything that has fallen out of the window,
//     condensed into a paragraph by the model itself. Written back to the
//     session row and prepended to the prompt.
//
//   * Facts — structured values the agent must not lose or misremember: the
//     patient's name and number, which phone numbers have been looked up, and
//     which appointment ids this conversation is entitled to change.
//
// A deliberate choice: tool calls and their results are persisted for audit but
// are NOT replayed to the model. Replaying them would cost tokens for data that
// has since changed (a slot free an hour ago may be booked now), and slicing a
// window mid tool-call/tool-result pair is rejected outright by some providers.
// Everything that must survive the turn goes into facts instead.

const chatStore = require("../../persistence/chat-store");
const config = require("../config");
const errors = require("../errors");

// Roles that are replayed to the model. "tool" rows are audit only.
const REPLAY_ROLES = new Set(["user", "assistant"]);

const SUMMARY_PROMPT =
  "You are condensing a conversation between a dental clinic's receptionist assistant and a patient, " +
  "so the assistant can remember it after the earlier messages scroll out of its context.\n\n" +
  "Write one short paragraph, at most 120 words, in the third person. Keep only what still matters: " +
  "what the patient wants, any appointment booked, moved or cancelled (with its date and time), their " +
  "stated name or phone number, anything they were promised, and anything still unresolved. Drop " +
  "greetings, small talk and anything already dealt with. State only what the transcript says — invent " +
  "nothing. Reply with the paragraph and nothing else.";

function truncate(text, max) {
  const s = String(text || "");
  return s.length > max ? s.slice(0, max) : s;
}

// ---------------------------------------------------------------------------
// Conversation — one turn's view of a session
// ---------------------------------------------------------------------------

class Conversation {
  constructor(session, history) {
    this.session = session;
    this.history = history; // normalised messages, oldest first
    this.pending = []; // rows to write when the turn completes
    this._facts = { ...(session.facts || {}) };
    this._factsDirty = false;
  }

  get sessionId() {
    return this.session.id;
  }

  get channel() {
    return this.session.channel;
  }

  get facts() {
    return this._facts;
  }

  setFact(key, value) {
    this._facts[key] = value;
    this._factsDirty = true;
  }

  // Name and phone are stored on the session row as well as in facts: the
  // admin view and the handoff email need them without parsing JSON.
  rememberPatient({ name, phone } = {}) {
    if (name && !this._facts.patientName) this.setFact("patientName", truncate(name, 100));
    if (phone && !this._facts.patientPhone) this.setFact("patientPhone", truncate(phone, 30));
  }

  // An appointment may only be rescheduled or cancelled if this conversation
  // looked it up first — otherwise a guessed id would be enough to change a
  // stranger's booking.
  rememberAppointmentIds(ids) {
    const known = new Set(this._facts.verifiedAppointmentIds || []);
    for (const id of ids || []) known.add(String(id));
    // Capped so a long session cannot grow the row without bound.
    this.setFact("verifiedAppointmentIds", Array.from(known).slice(-25));
  }

  hasSeenAppointmentId(id) {
    return (this._facts.verifiedAppointmentIds || []).includes(String(id));
  }

  // Queued rather than written immediately: one round trip at the end of the
  // turn instead of one per message.
  record(role, content, meta) {
    this.pending.push({ role, content: truncate(content, 8000), meta: meta || {} });
  }

  recordUser(text, meta) {
    this.record("user", text, meta);
    this.history.push({ role: "user", content: text });
  }

  recordAssistant(text, meta) {
    this.record("assistant", text, meta);
    this.history.push({ role: "assistant", content: text });
  }

  // Audit only — never replayed. Tool inputs can contain a patient's phone
  // number, so this row is as sensitive as the message itself.
  recordToolUse(calls, results) {
    this.record("tool", "", {
      calls: calls.map((c) => ({ name: c.name, input: c.input })),
      results: results.map((r) => ({ name: r.name, isError: !!r.isError, output: truncate(r.content, 2000) })),
    });
  }

  async flush() {
    const writes = [];
    if (this.pending.length) writes.push(chatStore.appendMessages(this.session.id, this.pending));

    if (this._factsDirty) {
      writes.push(
        chatStore.updateSession(this.session.id, {
          facts: this._facts,
          patientName: this._facts.patientName || undefined,
          patientPhone: this._facts.patientPhone || undefined,
        })
      );
    }

    this.pending = [];
    this._factsDirty = false;
    await Promise.all(writes);
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function toReplayMessage(row) {
  return { role: row.role, content: row.content };
}

// Providers reject a conversation that starts with an assistant turn, and the
// window can slice one off mid-exchange.
function trimLeadingAssistant(messages) {
  let start = 0;
  while (start < messages.length && messages[start].role !== "user") start += 1;
  return messages.slice(start);
}

async function open({ sessionId, channel = "web", externalId = null, locale = null }) {
  let session;

  if (sessionId) {
    session = await chatStore.getSession(sessionId);
    if (!session) throw errors.SESSION_NOT_FOUND();
  } else if (externalId) {
    session = await chatStore.getOrCreateByExternalId({ channel, externalId, locale });
  } else {
    session = await chatStore.createSession({ channel, locale });
  }

  // A session that has run this long is either abandoned or being abused;
  // either way the patient is better served by a fresh one.
  if (session.messageCount > config.maxSessionMessages) throw errors.SESSION_TOO_LONG();

  const rows = await chatStore.getRecentMessages(session.id, config.memoryWindow * 2);
  const history = trimLeadingAssistant(rows.filter((r) => REPLAY_ROLES.has(r.role)).map(toReplayMessage)).slice(
    -config.memoryWindow
  );

  return new Conversation(session, history);
}

// ---------------------------------------------------------------------------
// Summarisation
// ---------------------------------------------------------------------------

// Run at the start of a turn, before the prompt is built, so anything that has
// already dropped out of the replay window is in the summary the model sees —
// summarising afterwards would leave a gap for exactly one turn.
//
// It only does work when messages have fallen out since the last summary, so
// the cost is one extra call every `memoryWindow` messages, not one per turn.
// A failure is logged and swallowed: losing the summary degrades memory, but
// failing the turn would be worse.
async function summariseIfNeeded(conversation, provider) {
  const session = conversation.session;

  try {
    const total = await chatStore.countMessages(session.id);
    if (total < config.summaryTriggerAt) return null;

    const rows = await chatStore.getRecentMessages(session.id, config.memoryWindow);
    const oldestKept = rows.length ? rows[0].id : null;
    if (!oldestKept) return null;

    const summarisedUpTo = Number(conversation.facts.summarisedUpToId || 0);
    if (summarisedUpTo >= oldestKept) return null; // nothing new has aged out

    const older = (await chatStore.getMessagesBefore(session.id, oldestKept, 60)).filter(
      (r) => REPLAY_ROLES.has(r.role) && r.id > summarisedUpTo
    );
    if (older.length < 2) return null;

    const transcript = older
      .map((r) => (r.role === "user" ? "Patient: " : "Assistant: ") + r.content)
      .join("\n");

    const previous = session.summary
      ? `Summary of everything before this point:\n${session.summary}\n\nNewer messages:\n`
      : "";

    const completion = await provider.complete({
      system: SUMMARY_PROMPT,
      messages: [{ role: "user", content: previous + transcript }],
      tools: [],
      maxTokens: 300,
      temperature: 0,
      timeoutMs: config.requestTimeoutMs,
    });

    const summary = truncate(completion.text.trim(), config.summaryMaxChars);
    if (!summary) return null;

    conversation.setFact("summarisedUpToId", oldestKept);
    await chatStore.updateSession(session.id, { summary });
    session.summary = summary;
    return summary;
  } catch (err) {
    console.error("Summarisation failed for session", session.id, "-", err.message);
    return null;
  }
}

module.exports = { open, summariseIfNeeded, Conversation, SUMMARY_PROMPT };
