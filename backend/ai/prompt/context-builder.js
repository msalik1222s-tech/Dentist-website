// The live context block: what is true right now, injected into every turn.
//
// This is not a substitute for the tools. The catalogue is included so the
// agent can answer "what do you offer" without a round trip and so it never
// has to guess at a service name — but the prompt still requires get_services
// before quoting a price, and check_availability before offering a time.
// Availability is deliberately absent: it changes between one message and the
// next, so there is no honest way to state it here.

const store = require("../../store");
const catalog = require("../../persistence/catalog-store");

function formatClockTime(minutesSinceMidnight) {
  const hours = String(Math.floor(minutesSinceMidnight / 60)).padStart(2, "0");
  const minutes = String(minutesSinceMidnight % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

// "2026-09-05" -> "Saturday 5 September 2026", so the model does not have to
// work out the weekday itself (a reliable source of off-by-one errors).
function describeDate(dateStr) {
  const date = new Date(dateStr + "T00:00:00Z");
  return date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function addDays(dateStr, days) {
  const date = new Date(dateStr + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function build() {
  const clinic = store.getClinicInfo();
  const now = store.getClinicNow();
  const [services, doctors] = await Promise.all([catalog.getServices(), catalog.getDoctors()]);

  const lines = [
    "",
    "============================================================",
    "LIVE CLINIC DATA (authoritative — overrides anything above)",
    "============================================================",
    "",
    "TIME",
    `  Today is ${describeDate(now.dateStr)} (${now.dateStr}) in the clinic's timezone.`,
    `  The current clinic-local time is ${formatClockTime(now.minutesSinceMidnight)}.`,
    `  "Tomorrow" means ${describeDate(addDays(now.dateStr, 1))} (${addDays(now.dateStr, 1)}).`,
    "",
    "CLINIC",
    `  Name: ${clinic.name}`,
    `  Opening hours: ${clinic.hoursLabel}`,
    `  Phone: ${clinic.phone}`,
    `  Email: ${clinic.email}`,
    `  Address: ${clinic.address}`,
    `  Currency: ${clinic.currency}`,
    `  Appointments are ${clinic.slotMinutes} minutes long, on the hour and half hour.`,
    "",
    "DENTISTS",
    ...doctors.map(
      (d) =>
        `  ${d.name} — ${d.title}. Specialties: ${(d.specialties || []).join(", ") || "general practice"}.` +
        (d.languages && d.languages.length ? ` Speaks ${d.languages.join(", ")}.` : "")
    ),
    "",
    "SERVICES AND OFFICIAL PRICES",
    ...services.map((s) => `  ${s.name} — ${s.priceLabel}`),
    "",
    "REMINDERS",
    "  Appointment availability is NOT listed here because it changes constantly.",
    "  Call check_availability or find_next_available before offering any time.",
    "  Call get_services before quoting any price, even one listed above.",
  ];

  return lines.join("\n");
}

// What the agent has learned in this conversation. Kept separate from the live
// data block because it is per-session and, unlike the catalogue, not
// authoritative — the patient may have mistyped their own number.
function buildMemoryBlock(session) {
  if (!session) return "";

  const facts = session.facts || {};
  const lines = [];

  if (session.summary) {
    lines.push("Earlier in this conversation:", "  " + session.summary);
  }

  const known = [];
  if (facts.patientName) known.push(`name: ${facts.patientName}`);
  if (facts.patientPhone) known.push(`phone: ${facts.patientPhone}`);
  if (known.length) {
    lines.push(
      "Already given by this patient (do not ask again, but do confirm before booking): " + known.join(", ")
    );
  }

  if (session.status === "handoff") {
    lines.push(
      "A handoff to the clinic team has already been requested in this conversation. Do not request another one " +
        "for the same issue — remind the patient the team will be in touch, and keep helping with anything else."
    );
  }

  if (!lines.length) return "";

  return (
    "\n============================================================\nSESSION MEMORY\n" +
    "============================================================\n" +
    lines.join("\n")
  );
}

module.exports = { build, buildMemoryBlock, describeDate };
