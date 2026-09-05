// WhatsApp webhook verification and payload parsing.
//
// The webhook URL is public, so signature verification is the only thing
// standing between the internet and the ability to impersonate a patient.
//
//   node --test tests/

process.env.WHATSAPP_ENABLED = "true";
process.env.WHATSAPP_PROVIDER = "meta";
process.env.WHATSAPP_VERIFY_TOKEN = "clinic-verify-token";
process.env.WHATSAPP_APP_SECRET = "clinic-app-secret";
process.env.WHATSAPP_TOKEN = "graph-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const webhook = require("../backend/ai/channels/whatsapp/webhook");
const client = require("../backend/ai/channels/whatsapp/client");

function sign(body, secret = "clinic-app-secret") {
  return "sha256=" + crypto.createHmac("sha256", secret).update(Buffer.from(body)).digest("hex");
}

test("the subscription handshake echoes the challenge only for the right token", () => {
  const ok = webhook.verifySubscription({
    "hub.mode": "subscribe",
    "hub.verify_token": "clinic-verify-token",
    "hub.challenge": "abc123",
  });
  assert.deepStrictEqual(ok, { ok: true, status: 200, body: "abc123" });

  const wrong = webhook.verifySubscription({
    "hub.mode": "subscribe",
    "hub.verify_token": "guessed",
    "hub.challenge": "abc123",
  });
  assert.strictEqual(wrong.status, 403);
  assert.notStrictEqual(wrong.body, "abc123");
});

test("a correctly signed body is accepted", () => {
  const body = JSON.stringify({ entry: [] });
  assert.strictEqual(webhook.verifyMetaSignature(Buffer.from(body), sign(body)).ok, true);
});

test("a tampered body, a wrong secret and a missing signature are all rejected", () => {
  const body = JSON.stringify({ entry: [] });
  const signature = sign(body);

  assert.strictEqual(webhook.verifyMetaSignature(Buffer.from(body + " "), signature).ok, false);
  assert.strictEqual(webhook.verifyMetaSignature(Buffer.from(body), sign(body, "wrong-secret")).ok, false);
  assert.strictEqual(webhook.verifyMetaSignature(Buffer.from(body), undefined).reason, "missing_signature");
  assert.strictEqual(webhook.verifyMetaSignature(Buffer.from(body), "deadbeef").reason, "missing_signature");
  assert.strictEqual(webhook.verifyMetaSignature(Buffer.alloc(0), signature).reason, "empty_body");
});

test("a signature of the wrong length is rejected without throwing", () => {
  // timingSafeEqual throws on mismatched lengths; the guard must handle it.
  const body = JSON.stringify({ entry: [] });
  assert.strictEqual(webhook.verifyMetaSignature(Buffer.from(body), "sha256=abc").ok, false);
});

test("Twilio's signature scheme is verified over the URL and sorted parameters", () => {
  const url = "https://clinic.example.com/api/whatsapp/webhook";
  const params = { From: "whatsapp:+966500000000", Body: "hello", MessageSid: "SM1" };

  let payload = url;
  for (const key of Object.keys(params).sort()) payload += key + params[key];
  const signature = crypto.createHmac("sha1", "twilio-token").update(Buffer.from(payload, "utf8")).digest("base64");

  process.env.TWILIO_AUTH_TOKEN = "twilio-token";
  delete require.cache[require.resolve("../backend/ai/config")];
  delete require.cache[require.resolve("../backend/ai/channels/whatsapp/webhook")];
  const freshWebhook = require("../backend/ai/channels/whatsapp/webhook");

  assert.strictEqual(freshWebhook.verifyTwilioSignature(url, params, signature).ok, true);
  assert.strictEqual(freshWebhook.verifyTwilioSignature(url, params, "wrong").ok, false);
  assert.strictEqual(freshWebhook.verifyTwilioSignature(url, { ...params, Body: "changed" }, signature).ok, false);
});

test("a Meta payload yields one message per inbound text", () => {
  const messages = webhook.parseMetaPayload({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "966500000001", profile: { name: "Sara" } }],
              messages: [
                { id: "wamid.1", from: "966500000001", type: "text", text: { body: "Hello" } },
                { id: "wamid.2", from: "966500000001", type: "image", image: { id: "media1" } },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.strictEqual(messages.length, 2);
  assert.deepStrictEqual(
    messages.map((m) => [m.id, m.type, m.text]),
    [
      ["wamid.1", "text", "Hello"],
      ["wamid.2", "image", ""],
    ]
  );
  assert.strictEqual(messages[0].name, "Sara");
});

test("delivery-status callbacks parse to nothing so they are never answered", () => {
  const statusCallback = {
    entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "read" }] } }] }],
  };
  assert.strictEqual(webhook.parseMetaPayload(statusCallback).length, 0);
});

test("a long reply is split on a natural boundary rather than mid-word", () => {
  const paragraph = "This is a sentence about your appointment. ".repeat(200);
  const chunks = client.splitMessage(paragraph, 500);

  assert.ok(chunks.length > 1, "an over-long message is split");
  for (const chunk of chunks) assert.ok(chunk.length <= 500, "no chunk exceeds the limit");
  assert.strictEqual(chunks.join(" ").replace(/\s+/g, " ").trim(), paragraph.replace(/\s+/g, " ").trim());
});

test("a short reply is sent as one message, and an empty one as none", () => {
  assert.deepStrictEqual(client.splitMessage("See you Thursday!"), ["See you Thursday!"]);
  assert.deepStrictEqual(client.splitMessage("   "), []);
});
