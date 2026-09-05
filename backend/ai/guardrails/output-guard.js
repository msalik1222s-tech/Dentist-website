// The last check before anything is shown to a patient.
//
// The system prompt asks the model not to leak secrets, diagnose, or invent
// prices. This module is what happens when it does anyway — a prompt is a
// request, and a request is not a control. Nothing here trusts the model.
//
// Severity decides the response:
//   "replace" — the reply is thrown away and a safe message sent instead.
//               Used where partial redaction would still be harmful (a live
//               credential, a diagnosis, a promised discount).
//   "warn"    — logged with the session id, reply sent as-is. Used where the
//               check has real false positives and the harm is low.

const patterns = require("./patterns");
const config = require("../config");

const SAFE_FALLBACK =
  "I'd rather not answer that from here — let me put you in touch with the clinic team, who can give you a proper answer. " +
  "You can call us on {phone}, and I'm happy to help with appointments, services and opening hours in the meantime.";

function findViolations(text) {
  const violations = [];

  const check = (list, type, severity) => {
    for (const pattern of list) {
      if (pattern.test(text)) {
        violations.push({ type, severity, pattern: String(pattern) });
        break; // one hit per category is enough to decide
      }
    }
  };

  check(patterns.SECRET_PATTERNS, "secret_leak", "replace");
  check(patterns.INTERNALS_PATTERNS, "internals_leak", "replace");
  check(patterns.MEDICAL_PATTERNS, "medical_overreach", "replace");
  check(patterns.COMMITMENT_PATTERNS, "unauthorised_commitment", "replace");

  return violations;
}

// Prices the agent is allowed to say out loud: whatever the catalogue returned
// through a tool this turn, plus anything the patient themselves mentioned.
//
// Off by default (AI_STRICT_PRICE_GUARD). A legitimate reply can contain an
// arithmetic total — "two visits, so SAR 300" — that is in no catalogue, and
// replacing that reply is worse than letting it through. With the flag on, the
// check enforces; with it off it logs, which is how a clinic can find out
// whether enforcement would be safe for their wording before turning it on.
function checkPrices(text, allowedAmounts) {
  const violations = [];
  const mentioned = text.match(/\b(?:SAR|ر\.س|riyals?)\s*([0-9][0-9,\.]*)|([0-9][0-9,\.]*)\s*(?:SAR|riyals?)\b/gi) || [];

  for (const raw of mentioned) {
    const digits = raw.replace(/[^0-9.]/g, "").replace(/\.$/, "");
    const amount = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount === 0) continue;
    if (!allowedAmounts.has(amount)) {
      violations.push({
        type: "unverified_price",
        severity: config.strictPriceGuard ? "replace" : "warn",
        detail: raw.trim(),
      });
    }
  }
  return violations;
}

// `allowedAmounts` is a Set of numbers gathered by the agent from this turn's
// tool results and the patient's own message.
function inspect(text, { allowedAmounts = new Set(), clinicPhone = "" } = {}) {
  const reply = String(text || "").trim();

  if (!reply) {
    return {
      safe: false,
      text: "Sorry — I didn't manage to put an answer together. Could you ask me again?",
      violations: [{ type: "empty_reply", severity: "replace" }],
    };
  }

  const violations = [...findViolations(reply), ...checkPrices(reply, allowedAmounts)];
  const mustReplace = violations.some((v) => v.severity === "replace");

  if (mustReplace) {
    return {
      safe: false,
      text: SAFE_FALLBACK.replace("{phone}", clinicPhone || "the clinic"),
      violations,
    };
  }

  return { safe: true, text: reply, violations };
}

// Pulls every number a tool result stated as a price, so the price check knows
// what the catalogue actually said this turn.
function collectAllowedAmounts(toolResults, patientText) {
  const amounts = new Set();

  const walk = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === "number") {
      amounts.add(value);
      return;
    }
    if (typeof value === "string") {
      for (const match of value.match(/[0-9][0-9,]*(?:\.[0-9]+)?/g) || []) {
        amounts.add(Number(match.replace(/,/g, "")));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === "object") Object.values(value).forEach(walk);
  };

  toolResults.forEach(walk);
  walk(String(patientText || ""));
  return amounts;
}

module.exports = { inspect, collectAllowedAmounts, SAFE_FALLBACK };
