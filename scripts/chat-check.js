#!/usr/bin/env node
// Verifies the AI assistant end to end against the REAL provider.
//
//   npm run chat:check
//
// The counterpart to db:check. It makes genuine API calls — there is no mock
// and no canned answer anywhere in this file — and checks the replies against
// backend/data/clinic.json and backend/data/services.json, so a fluent answer
// containing the wrong price still fails.
//
// It runs under the same isolation as the demo: the demo diary, no production
// database, no outbound mail. The booking it makes is clearly labelled and is
// cancelled again at the end.
//
// The API key is read from backend/.env and is never printed.

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const DEMO_DIR = path.join(ROOT, "demo");
const DEMO_DB = path.join(DEMO_DIR, "appointments.demo.json");

fs.mkdirSync(DEMO_DIR, { recursive: true });
if (!fs.existsSync(DEMO_DB)) fs.writeFileSync(DEMO_DB, "[]");

// Same four pins as scripts/demo.js, set before anything loads.
process.env.APPOINTMENTS_FILE = DEMO_DB;
process.env.DATABASE_URL = "";
process.env.POSTGRES_URL = "";
process.env.SMTP_HOST = "";
process.env.CLINIC_EMAIL = "";

require("dotenv").config({ path: path.join(ROOT, "backend", ".env") });

const chat = require(path.join(ROOT, "backend", "chat"));
const store = require(path.join(ROOT, "backend", "store"));
const db = require(path.join(ROOT, "backend", "db"));

const CLINIC = require(path.join(ROOT, "backend", "data", "clinic.json"));
const SERVICES = require(path.join(ROOT, "backend", "data", "services.json"));

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log("  PASS  " + label);
    pass++;
  } else {
    console.log("  FAIL  " + label + (detail ? "\n        " + detail : ""));
    fail++;
  }
}

function say(text) {
  console.log("\n  > " + text);
}
function heard(reply) {
  console.log("  < " + String(reply).replace(/\n/g, "\n    "));
  console.log("");
}

// One patient turn. `history` accumulates so later turns keep context.
async function ask(history, text) {
  history.push({ role: "user", content: text });
  say(text);
  const reply = await chat.respond(history);
  history.push({ role: "assistant", content: reply });
  heard(reply);
  return reply;
}

const digits = (s) => String(s).replace(/[^0-9]/g, "");

async function main() {
  const status = chat.status();
  console.log("\n=== 0. Provider ===");
  console.log("  provider: " + (status.provider || "none"));
  console.log("  model:    " + (status.model || "none"));
  console.log("  storage:  " + (db.isPostgres ? "Postgres" : path.basename(db.dataFile || "")));
  check("an AI provider is configured", status.enabled, "no API key found in backend/.env");
  if (!status.enabled) return;
  check("storage is the isolated demo diary", !db.isPostgres && /demo/.test(db.dataFile || ""));

  // -----------------------------------------------------------------
  console.log("\n=== 1. Clinic hours ===");
  const hours = await ask([], "What are your opening hours?");
  // clinic.json says 9:00 AM - 9:00 PM every day.
  check(
    "the reply states the opening time (9)",
    /\b9(:00)?\s*(am|a\.m\.)?\b/i.test(hours) || /\b09:00\b/.test(hours),
    hours
  );
  // "9 PM", "9:00 PM" and "21:00" are all the same answer.
  check(
    "the reply states the closing time (9 PM / 21:00)",
    /\b9(:00)?\s*(pm|p\.m\.)/i.test(hours) || /\b21:00\b/.test(hours),
    hours
  );
  check("the reply says it is open every day", /every day|daily|7 days|seven days/i.test(hours), hours);

  // -----------------------------------------------------------------
  console.log("\n=== 2. The dentist's name ===");
  const who = await ask([], "Who is the dentist at the clinic?");
  check(`the reply names ${CLINIC.dentist}`, new RegExp(CLINIC.dentist.replace(/\./g, "\\.?"), "i").test(who), who);

  // -----------------------------------------------------------------
  console.log("\n=== 3. Service price ===");
  const whitening = SERVICES.find((s) => /whiten/i.test(s.name));
  const price = await ask([], "How much does teeth whitening cost?");
  check(
    `the reply quotes the configured price (${whitening.startingPrice})`,
    digits(price).includes(String(whitening.startingPrice)),
    `expected ${whitening.startingPrice} — got: ${price}`
  );
  check("the reply uses the clinic's currency (SAR)", /SAR|riyal/i.test(price), price);

  // -----------------------------------------------------------------
  console.log("\n=== 4. A booking made BY the assistant ===");

  const when = await store.findNextAvailable({ fromDate: null });
  if (!when) throw new Error("no free slot in the next 30 days");

  // A plain, ordinary name — deliberately.
  //
  // Given a decorated one like "DEMO PATIENT — Omar Demo (not a real patient)"
  // the model extracts whatever fragment it judges to be the name, and the
  // choice is not stable between runs: observed as both "Omar Demo" and
  // "DEMO PATIENT" for identical input. That is reasonable behaviour on a
  // messy string, but it means the label belongs in the note field, which is
  // stored verbatim. The same applies when demonstrating this to a client.
  const NAME = "Omar Demo";
  const PHONE = "+000000000222";
  const NOTE = "DEMO BOOKING — software demonstration, not a real patient.";

  const history = [];
  const booking = await ask(
    history,
    `Please book an appointment. Name: ${NAME}. Phone: ${PHONE}. ` +
      `Service: teeth whitening. Date: ${when.date}. Time: ${when.time}. ` +
      `Please add this note to the booking: "${NOTE}"`
  );

  // The reference is the thing the patient is told to keep, so it has to be
  // in the reply the patient can actually see.
  const refInReply = (String(booking).match(/\b[23456789A-HJ-NP-Z]{6}\b/) || [])[0];
  check("the assistant gave the patient a booking reference", !!refInReply, booking);

  // The real test: is it in the store the dashboard reads?
  //
  // Looked up by the phone number, NOT by an exact name match. The model
  // normalises what the patient types — asked to book
  // "DEMO PATIENT — Omar Demo (not a real patient)" it sensibly passes
  // "Omar Demo" to the tool — so an exact-name lookup fails even though the
  // booking is sitting right there. The phone number is what survives intact.
  const all = await store.loadAppointments();
  const stored = all.find((a) => digits(a.phone) === digits(PHONE));
  check("the booking actually reached the appointment store", !!stored);

  if (stored) {
    console.log(`  ... stored as ${stored.ref} | "${stored.name}" | ${stored.date} ${stored.time} | ${stored.status} | source=${stored.source}`);
    check("the reference the patient was told matches the stored one", refInReply === stored.ref, `${refInReply} vs ${stored.ref}`);
    check("it is recorded as coming from the assistant", stored.source === "chat");
    check("the stored name is recognisably the patient", /omar demo/i.test(stored.name), stored.name);
    check("the date is the one requested", stored.date === when.date, `${stored.date} vs ${when.date}`);
    check("the time is the one requested", stored.time === when.time, `${stored.time} vs ${when.time}`);
    check("the slot is no longer offered to anyone else", !(await store.getAvailableSlots(when.date)).includes(when.time));

    // Clean up so a rehearsal does not leave a slot held.
    await store.adminCancelAppointment(stored.ref);
    console.log(`  ... cancelled ${stored.ref} again (demo diary left tidy)`);
  }

  // -----------------------------------------------------------------
  // Everything above calls chat.respond() directly. This section goes over
  // real HTTP through POST /api/chat — the exact path the chat widget in the
  // browser uses — so a routing, validation or serialisation problem between
  // the page and the adapter cannot hide behind a passing in-process test.
  console.log("\n=== 5. POST /api/chat over HTTP (the path the widget uses) ===");

  const { createApp } = require(path.join(ROOT, "backend", "app"));
  const server = await new Promise((resolve) => {
    const s = createApp({ serveStatic: false }).listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "What are your opening hours?" }] }),
    });
    const body = await res.json();
    console.log("  < HTTP " + res.status + ": " + JSON.stringify(body).slice(0, 300));
    check("the endpoint answers 200", res.status === 200, "got " + res.status);
    check("it returns a real reply, not an error", body.ok === true && !!body.reply);
    check(
      "the reply over HTTP carries the clinic's hours",
      /\b9(:00)?\s*(am|pm|a\.m\.|p\.m\.)/i.test(body.reply || "") || /\b21:00\b/.test(body.reply || ""),
      body.reply
    );

    const bad = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    check("an empty message is rejected with 400", bad.status === 400, "got " + bad.status);
  } finally {
    await new Promise((r) => server.close(r));
  }

  // -----------------------------------------------------------------
  console.log("\n=== 6. It refuses what it should refuse ===");
  const invented = await ask([], "Do you do laser eye surgery, and can Dr. Asad prescribe me antibiotics over chat?");
  check(
    "it does not invent a service the clinic has not listed",
    !/yes,? we (do|offer) laser eye/i.test(invented),
    invented
  );
}

main()
  .then(() => {
    console.log("\n==============================================");
    console.log("RESULT: " + pass + " passed, " + fail + " failed");
    console.log("==============================================");
    process.exit(fail ? 1 : 0);
  })
  .catch((err) => {
    console.error("\nFAILED: " + (err && err.message));
    if (err && err.code) console.error("code: " + err.code);
    process.exit(1);
  });
