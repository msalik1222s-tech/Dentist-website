// The WhatsApp channel.
//
// Turns a verified webhook delivery into agent turns and sends the replies
// back. The agent itself is channel-agnostic; everything WhatsApp-specific
// stops here.
//
// Delivery model. The platform retries any delivery that is not acknowledged
// quickly, and a retry would answer the patient twice — so:
//   * every message id is checked against inbound_events before it is
//     processed, and a duplicate is dropped;
//   * the route always answers 200, even when something inside failed, because
//     a 500 buys a retry of a message that has already been answered.
//
// On a serverless host the reply has to be sent before the response returns —
// the instance is frozen the moment it does — so processing is inline rather
// than queued. That is why the function's maxDuration is raised in vercel.json.
// A clinic expecting heavy WhatsApp traffic should put a real queue here: the
// seam is handleMessages(), which is the only thing the route calls.

const agent = require("../../agent");
const config = require("../../config");
const chatStore = require("../../../persistence/chat-store");
const store = require("../../../store");
const client = require("./client");
const webhook = require("./webhook");

const CHANNEL = "whatsapp";

// Sent for a photo, voice note or location. The agent cannot read them, and
// pretending otherwise would be worse than saying so.
const UNSUPPORTED_MEDIA_REPLY =
  "Thanks for that — I can only read text messages, so I wasn't able to open it. " +
  "Could you describe it in a message instead? If it needs a person to look at it, " +
  "call the clinic on {phone} and the team will help.";

function clinicPhone() {
  try {
    return store.getClinicInfo().phone || "the clinic";
  } catch {
    return "the clinic";
  }
}

async function handleOne(message) {
  // Dedupe first: a retried delivery must not reach the agent at all.
  const fresh = await chatStore.markEventSeen(CHANNEL, `${CHANNEL}:${message.id}`);
  if (!fresh) return { id: message.id, status: "duplicate" };

  if (message.type !== "text" || !String(message.text || "").trim()) {
    await client.trySend(message.from, UNSUPPORTED_MEDIA_REPLY.replace("{phone}", clinicPhone()));
    return { id: message.id, status: "unsupported_type" };
  }

  try {
    // The WhatsApp number is the session key, so a patient messaging next week
    // continues the same conversation.
    const result = await agent.respond({
      message: message.text,
      channel: CHANNEL,
      externalId: message.from,
    });

    await client.trySend(message.from, result.reply);
    return { id: message.id, status: "answered", sessionId: result.sessionId };
  } catch (err) {
    console.error("WhatsApp turn failed:", err.message);
    const safe =
      err.safeMessage ||
      `Sorry — I'm having trouble right now. Please call the clinic on ${clinicPhone()} and the team will help.`;
    await client.trySend(message.from, safe);
    return { id: message.id, status: "error" };
  }
}

// Messages are handled one at a time on purpose: two messages from the same
// number in one delivery are two turns of one conversation, and running them
// in parallel would race on the session's memory.
async function handleMessages(messages) {
  const results = [];
  for (const message of messages) results.push(await handleOne(message));
  return results;
}

function isEnabled() {
  return config.whatsapp.enabled && client.isConfigured();
}

module.exports = { handleMessages, isEnabled, webhook, client, CHANNEL };
