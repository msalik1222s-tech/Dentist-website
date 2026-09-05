// Assembles the system prompt for a turn.
//
// Four layers, in this order:
//   1. the master prompt   — identity, tone, policy, guardrails (static)
//   2. the live context    — today's date, the clinic, the catalogue (per turn)
//   3. session memory      — the running summary and what we know about the
//                            patient in this conversation
//   4. turn reinforcement  — a reminder appended when the input guard flagged
//                            something (see guardrails/input-guard.js)
//
// The order matters: the model reads the reinforcement last, immediately before
// answering, which is where a repeated rule carries the most weight.

const fs = require("fs");
const path = require("path");

const context = require("./context-builder");

const PROMPT_FILE = path.join(__dirname, "..", "..", "data", "system-prompt.txt");

// If the prompt file is somehow missing from the deployment bundle the agent
// must not run with no rules at all — it refuses instead.
const FALLBACK =
  "You are the Dental Care Assistant for a dental clinic. The clinic's master prompt " +
  "failed to load, so you are operating without your full instructions. Tell the patient " +
  "you are temporarily unable to help and give them the clinic's phone number from " +
  "get_clinic_info. Do not answer questions about prices, availability or treatment, and " +
  "do not book anything.";

// Read once per process: on a warm instance this is the difference between one
// file read and one per message.
let masterPrompt = null;

function getMasterPrompt() {
  if (masterPrompt !== null) return masterPrompt;
  try {
    masterPrompt = fs.readFileSync(PROMPT_FILE, "utf8").trim();
  } catch (err) {
    console.error("FATAL: could not read the master system prompt:", err.message);
    masterPrompt = FALLBACK;
  }
  return masterPrompt;
}

function isDegraded() {
  return getMasterPrompt() === FALLBACK;
}

// Channel-specific behaviour lives here rather than in the master prompt, so a
// new channel does not mean editing the clinic's prompt file.
const CHANNEL_NOTES = {
  web: "The patient is using the chat widget on the clinic's website. They can also use the booking form on the same page.",
  whatsapp:
    "The patient is messaging on WhatsApp. Keep replies short — a few lines at most, no long lists, and no markdown of any kind. " +
    "Their WhatsApp number is a good default contact number for a booking, but read it back and confirm it before using it.",
};

async function build({ channel = "web", session = null, reinforcement = "" } = {}) {
  const parts = [getMasterPrompt()];

  parts.push(await context.build());

  const note = CHANNEL_NOTES[channel] || CHANNEL_NOTES.web;
  parts.push("\n============================================================\nCHANNEL\n============================================================\n" + note);

  const memory = context.buildMemoryBlock(session);
  if (memory) parts.push(memory);

  if (reinforcement) parts.push(reinforcement);

  return parts.join("\n");
}

module.exports = { build, getMasterPrompt, isDegraded, CHANNEL_NOTES };
