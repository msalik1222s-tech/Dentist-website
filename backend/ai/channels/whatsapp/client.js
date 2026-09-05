// Sending WhatsApp messages.
//
// Two providers behind one send() so the rest of the channel does not care
// which the clinic uses:
//   * "meta"   — WhatsApp Cloud API (Graph). The direct route.
//   * "twilio" — Twilio's WhatsApp API. Easier to get started with.
//
// Nothing here knows about the agent; it only moves text.

const config = require("../../config");

const whatsapp = config.whatsapp;

// WhatsApp rejects anything longer. Splitting on a paragraph or sentence
// boundary keeps a long reply readable instead of cutting mid-word.
const MAX_BODY = 4096;

function splitMessage(text, limit = MAX_BODY) {
  const body = String(text || "").trim();
  if (body.length <= limit) return body ? [body] : [];

  const chunks = [];
  let rest = body;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    if (cut < limit * 0.5) cut = window.lastIndexOf(". ") + 1;
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function postForm(url, params, headers) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    throw new Error(`WhatsApp send failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
}

async function sendViaMeta(to, text) {
  const url = `https://graph.facebook.com/${whatsapp.graphVersion}/${whatsapp.phoneNumberId}/messages`;

  for (const chunk of splitMessage(text)) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + whatsapp.token,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: chunk },
      }),
    });
    if (!response.ok) {
      throw new Error(`WhatsApp send failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
  }
}

async function sendViaTwilio(to, text) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${whatsapp.twilioAccountSid}/Messages.json`;
  const auth =
    "Basic " + Buffer.from(`${whatsapp.twilioAccountSid}:${whatsapp.twilioAuthToken}`).toString("base64");

  for (const chunk of splitMessage(text, 1600)) {
    await postForm(
      url,
      {
        From: whatsapp.twilioFrom,
        To: to.startsWith("whatsapp:") ? to : "whatsapp:" + to,
        Body: chunk,
      },
      { Authorization: auth }
    );
  }
}

function isConfigured() {
  if (!whatsapp.enabled) return false;
  if (whatsapp.provider === "twilio") {
    return !!(whatsapp.twilioAccountSid && whatsapp.twilioAuthToken && whatsapp.twilioFrom);
  }
  return !!(whatsapp.token && whatsapp.phoneNumberId);
}

async function send(to, text) {
  if (!isConfigured()) throw new Error("WhatsApp is not configured");
  if (!String(text || "").trim()) return;
  if (whatsapp.provider === "twilio") return sendViaTwilio(to, text);
  return sendViaMeta(to, text);
}

// Best effort: a message the clinic never sees is bad, but a webhook that
// 500s makes the platform retry the whole delivery and answer the patient
// twice.
async function trySend(to, text) {
  try {
    await send(to, text);
    return true;
  } catch (err) {
    console.error("WhatsApp send failed:", err.message);
    return false;
  }
}

module.exports = { send, trySend, isConfigured, splitMessage };
