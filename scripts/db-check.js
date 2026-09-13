#!/usr/bin/env node
// Verifies the configured storage end to end: connects, creates the schema,
// and runs the full booking round trip a clinic actually depends on —
//
//   book -> double-book rejected -> patient lookup needs phone AND reference
//        -> staff confirm -> staff reschedule -> staff cancel -> slot freed
//
//   npm run db:check
//
// Run it once after provisioning the database and after changing
// DATABASE_URL, so a broken connection string surfaces here rather than as a
// 500 on the live site.
//
// The booking it creates is clearly marked as test data (see TEST_NAME) and is
// left cancelled, so it never holds a slot a real patient could have wanted.
// Staff can recognise and ignore it in the admin list.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "backend", ".env") });

const hasDatabaseUrl = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
if (!hasDatabaseUrl) {
  console.warn("DATABASE_URL is not set — checking the local JSON file store instead.");
  console.warn("Vercel needs Postgres; set DATABASE_URL and re-run to check the real thing.\n");
}

const db = require("../backend/db");
const store = require("../backend/store");

// Obvious test data: a phone number no patient can have, and a name that says
// what it is at a glance if anyone sees it in the admin list.
const TEST_PHONE = "+000000000000";
const TEST_NAME = "TEST — automated db-check";

function ok(label) {
  console.log("  ok  " + label);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const probe = "db-check-" + Date.now();
  console.log("Checking " + (db.isPostgres ? "Postgres (DATABASE_URL)" : "JSON file storage") + "...\n");

  await db.countRateLimitHits(probe, "0.0.0.0", 60000);
  ok(db.isPostgres ? "connected, schema created, rate limiting writable" : "storage reachable");

  const next = await store.findNextAvailable({ fromDate: null });
  assert(next, "no free slot found in the next 30 days");
  const { date, time } = next;
  ok(`found a free slot: ${date} ${time}`);

  // Booked as "pending" so this check exercises the staff confirm step below,
  // which is the path the admin dashboard uses most.
  const appt = await store.createAppointment({
    name: TEST_NAME,
    phone: TEST_PHONE,
    service: "Check-up",
    date,
    time,
    source: "db-check",
    status: "pending",
  });
  // createAppointment returns a redacted view: a reference, never an internal
  // id. The reference is what every later step here identifies the row by,
  // exactly as the clinic and the patient do.
  assert(appt && appt.ref, "booking returned no reference");
  ok(`booked a test appointment (reference ${appt.ref}, status ${appt.status})`);

  let rejected = false;
  try {
    await store.createAppointment({
      name: TEST_NAME + " (duplicate)",
      phone: TEST_PHONE,
      service: "Check-up",
      date,
      time,
      source: "db-check",
    });
  } catch (err) {
    rejected = err.message === "That slot is already booked.";
  }
  assert(rejected, "double-booking was NOT rejected — the unique index is missing");
  ok("double-booking the same slot is rejected");

  const slots = await store.getAvailableSlots(date);
  assert(!slots.includes(time), "booked slot still shows as available");
  ok("booked slot no longer offered in availability");

  // The patient credential is the phone number AND the reference together.
  const found = await store.findAppointmentsByPhone(TEST_PHONE, appt.ref);
  assert(found.some((a) => a.ref === appt.ref), "lookup by phone + reference did not find the booking");
  ok("patient lookup by phone + reference works");

  const withoutRef = await store.findAppointmentsByPhone(TEST_PHONE, "");
  assert(withoutRef.length === 0, "phone number alone returned a booking — the reference is not being required");
  ok("phone number alone reveals nothing");

  // ---- the clinic's side: exactly what the admin dashboard calls ----

  const confirmed = await store.adminConfirmAppointment(appt.ref);
  assert(confirmed.changed && confirmed.appointment.status === "confirmed", "staff confirm did not stick");
  ok("staff confirm works");

  const again = await store.adminConfirmAppointment(appt.ref);
  assert(!again.changed, "a repeated confirm reported a change");
  ok("a second confirm is a no-op, not an error");

  const later = await store.findNextAvailable({ fromDate: date });
  assert(later, "no second free slot found to reschedule into");
  const moved = await store.adminRescheduleAppointment({
    ref: appt.ref,
    newDate: later.date,
    newTime: later.time,
  });
  assert(
    moved.appointment.date === later.date && moved.appointment.time === later.time,
    "staff reschedule did not stick"
  );
  ok(`staff reschedule works (moved to ${later.date} ${later.time})`);

  const freedOld = await store.getAvailableSlots(date);
  assert(freedOld.includes(time), "the original slot was not freed by the reschedule");
  ok("the original slot was freed by the move");

  await store.adminCancelAppointment(appt.ref);
  const afterCancel = await store.getAvailableSlots(later.date);
  assert(afterCancel.includes(later.time), "cancelling did not free the slot");
  ok("staff cancel works, and the slot was freed again");

  // Proves the write actually reached storage rather than only the in-memory
  // copy this process has been handing around.
  const reread = await db.getAppointmentByRef(appt.ref);
  assert(reread && reread.status === "cancelled", "the cancelled status did not persist to storage");
  ok("the final state was re-read from storage and matches");

  console.log(
    "\nAll checks passed. Storage is ready" +
      (db.isPostgres ? " (Postgres)." : " — but this was the local JSON file, NOT the deployed database.")
  );
  console.log(`Left behind: one cancelled test booking, reference ${appt.ref}, named "${TEST_NAME}".`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFAILED: " + err.message);
    if (err.code) console.error("Postgres error code: " + err.code);
    process.exit(1);
  });
