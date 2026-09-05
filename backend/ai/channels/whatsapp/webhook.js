// Verifying and parsing inbound WhatsApp webhooks.
//
// Kept apart from the message handling so the security-critical part — proving
// a request really came from the platform — can be read and tested on its own.
//
// The webhook URL is public. Without signature verification anyone who finds
// it could impersonate a patient, book appointments in someone else's name, or
// drive up the clinic's API bill. Every request must be verified against the
// raw body, byte for byte: re-serialising the parsed JSON produces different
// bytes and a different signature.

const crypto = require("crypto");

const config = require("../../config");

const whatsapp = config.whatsapp;

// Meta's subscription handshake: it GETs the URL with a token the clinic chose
// and expects the challenge echoed back.
function verifySubscription(query) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];

  if (!whatsapp.verifyToken) return { ok: false, status: 503, body: "WhatsApp verify token not configured" };
  if (mode !== "subscribe") return { ok: false, status: 400, body: "Bad Request" };
  if (token !== whatsapp.verifyToken) return { ok: false, status: 403, body: "Forbidden" };

  return { ok: true, status: 200, body: String(challenge || "") };
}

// Compares two strings without leaking how much of the prefix matched.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Meta signs the raw body with the app secret: X-Hub-Signature-256: sha256=<hex>
function verifyMetaSignature(rawBody, header) {
  if (!whatsapp.appSecret) return { ok: false, reason: "app_secret_not_configured" };
  if (!rawBody || !rawBody.length) return { ok: false, reason: "empty_body" };
  if (!header || !header.startsWith("sha256=")) return { ok: false, reason: "missing_signature" };

  const expected = crypto.createHmac("sha256", whatsapp.appSecret).update(rawBody).digest("hex");
  return safeEqual(header.slice("sha256=".length), expected)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}

// Twilio signs the request URL concatenated with the POST parameters sorted by
// key, HMAC-SHA1 with the auth token, base64. The URL must be the one Twilio
// called, so PUBLIC_BASE_URL has to match the number's configured webhook
// exactly — including https and any path.
function verifyTwilioSignature(url, params, header) {
  if (!whatsapp.twilioAuthToken) return { ok: false, reason: "auth_token_not_configured" };
  if (!header) return { ok: false, reason: "missing_signature" };

  let payload = String(url);
  for (const key of Object.keys(params || {}).sort()) payload += key + params[key];

  const expected = crypto
    .createHmac("sha1", whatsapp.twilioAuthToken)
    .update(Buffer.from(payload, "utf8"))
    .digest("base64");

  return safeEqual(header, expected) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

function verifyRequest(req) {
  if (whatsapp.provider === "twilio") {
    const base = (whatsapp.publicUrl || "").replace(/\/$/, "");
    if (!base) return { ok: false, reason: "public_base_url_not_configured" };
    return verifyTwilioSignature(base + req.originalUrl, req.body || {}, req.headers["x-twilio-signature"]);
  }
  return verifyMetaSignature(req.rawBody, req.headers["x-hub-signature-256"]);
}

// ---------------------------------------------------------------------------
// Payload -> a flat list of { id, from, text, name }
// ---------------------------------------------------------------------------

// Meta nests messages three levels deep and mixes them with delivery-status
// callbacks, which must be ignored — answering a "read receipt" would send the
// patient a reply to nothing.
function parseMetaPayload(body) {
  const messages = [];
  for (const entry of (body && body.entry) || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = value.contacts || [];
      for (const message of value.messages || []) {
        // Only plain text. Images, audio, location and interactive replies are
        // acknowledged politely elsewhere rather than misread as text.
        const contact = contacts.find((c) => c.wa_id === message.from) || contacts[0];
        messages.push({
          id: message.id,
          from: message.from,
          name: (contact && contact.profile && contact.profile.name) || null,
          type: message.type,
          text: message.type === "text" ? (message.text && message.text.body) || "" : "",
        });
      }
    }
  }
  return messages;
}

function parseTwilioPayload(body) {
  if (!body || !body.From) return [];
  return [
    {
      id: body.MessageSid || body.SmsMessageSid || "",
      from: String(body.From).replace(/^whatsapp:/, ""),
      name: body.ProfileName || null,
      type: body.NumMedia && Number(body.NumMedia) > 0 ? "media" : "text",
      text: body.Body || "",
    },
  ];
}

function parsePayload(body) {
  const messages = whatsapp.provider === "twilio" ? parseTwilioPayload(body) : parseMetaPayload(body);
  return messages.filter((m) => m.id && m.from);
}

module.exports = {
  verifySubscription,
  verifyRequest,
  verifyMetaSignature,
  verifyTwilioSignature,
  parsePayload,
  parseMetaPayload,
  parseTwilioPayload,
};
