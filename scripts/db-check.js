#!/usr/bin/env node
// Verifies DATABASE_URL end to end: connects, creates the schema, and runs a
// full booking round trip (book -> double-book is rejected -> reschedule ->
// cancel -> slot freed). It leaves one cancelled test record behind, which is
// harmless and never shows up as a booked slot.
//
//   npm run db:check
//
// Run this once after provisioning the database and after changing
// DATABASE_URL, so a broken connection string surfaces here rather than as a
// 500 on the live site.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "backend", ".env") });

const hasDatabaseUrl = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
if (!hasDatabaseUrl) {
  console.warn("DATABASE_URL is not set — checking the local JSON file store instead.");
  console.warn("Vercel needs Postgres; set DATABASE_URL and re-run to check the real thing.\n");
}

const db = require("../backend/db");
const store = require("../backend/store");

// A date far enough out that it can't collide with a real booking, and a
// phone number no patient would have.
const TEST_PHONE = "+000000000000";

function ok(label) {
  console.log("  ok  " + label);
}

async function main() {
  const probe = "db-check-" + Date.now();
  console.log("Checking " + (db.isPostgres ? "Postgres (DATABASE_URL)" : "JSON file storage") + "...\n");

  await db.countRateLimitHits(probe, "0.0.0.0", 60000);
  ok(db.isPostgres ? "connected, schema created, rate limiting writable" : "storage reachable");

  const next = await store.findNextAvailable({ fromDate: null });
  if (!next) throw new Error("no free slot found in the next 30 days");
  const { date, time } = next;
  ok(`found a free slot: ${date} ${time}`);

  const appt = await store.createAppointment({
    name: "DB Check",
    phone: TEST_PHONE,
    service: "Check-up",
    date,
    time,
    source: "db-check",
  });
  ok("booked a test appointment (id " + appt.id + ")");

  let rejected = false;
  try {
    await store.createAppointment({
      name: "DB Check Duplicate",
      phone: TEST_PHONE,
      service: "Check-up",
      date,
      time,
      source: "db-check",
    });
  } catch (err) {
    rejected = err.message === "That slot is already booked.";
  }
  if (!rejected) throw new Error("double-booking was NOT rejected — the unique index is missing");
  ok("double-booking the same slot is rejected");

  const slots = await store.getAvailableSlots(date);
  if (slots.includes(time)) throw new Error("booked slot still shows as available");
  ok("booked slot no longer offered in availability");

  const found = await store.findAppointmentsByPhone(TEST_PHONE);
  if (!found.some((a) => a.id === appt.id)) throw new Error("lookup by phone did not find the booking");
  ok("lookup by phone works");

  const later = await store.findNextAvailable({ fromDate: date });
  const moved = await store.rescheduleAppointment({
    id: appt.id,
    newDate: later.date,
    newTime: later.time,
  });
  if (moved.date !== later.date || moved.time !== later.time) throw new Error("reschedule did not stick");
  ok(`rescheduled to ${moved.date} ${moved.time}`);

  await store.cancelAppointment({ id: appt.id });
  const afterCancel = await store.getAvailableSlots(moved.date);
  if (!afterCancel.includes(moved.time)) throw new Error("cancelling did not free the slot");
  ok("cancelled, and the slot was freed again");

  console.log("\nAll checks passed. The database is ready.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFAILED: " + err.message);
    if (err.code) console.error("Postgres error code: " + err.code);
    process.exit(1);
  });
