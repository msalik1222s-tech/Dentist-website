// Appointment, slot and service logic.
//
// Storage goes through db.js (Postgres, or a JSON file for local dev), so
// everything that touches appointments is async.
//
// Privacy model: a phone number is not a secret. Every booking therefore also
// gets a short reference, given to the patient at booking time, and reading or
// changing an appointment needs BOTH the phone number and that reference.
// publicView() decides what a caller is allowed to see.

const crypto = require("crypto");
const db = require("./db");
const mailer = require("./mailer");

const CLINIC = require("./data/clinic.json");
const SERVICES = require("./data/services.json");

// Errors carry a `status` so callers can tell "the patient did something
// invalid" (400/404/409, safe to show them) from "storage is broken" (500, log
// it and show a generic message).
function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Strips newlines/control characters so patient-supplied text can't break
// out of a single line (e.g. email header/subject injection via the name
// field, or garbled rows in admin.html).
function stripControlChars(s) {
  return String(s || "").replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ").trim();
}

// Compare the last 9 digits so "0501234567", "+966 50 123 4567" and
// "966501234567" all resolve to the same patient. This is what gets stored in
// the phone_digits column and what lookups are keyed on.
function phoneKey(phone) {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  return digits.length > 9 ? digits.slice(-9) : digits;
}

function getClinicInfo() {
  return CLINIC;
}

function getServices() {
  return SERVICES;
}

// Parses a strict YYYY-MM-DD string as a real calendar date (rejects
// overflow like 2026-02-30, which `Date.parse` silently rolls into March).
// Uses UTC throughout so results don't depend on the host machine's
// timezone — important once this runs on a server that isn't in Jeddah.
function parseDateStrict(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function isValidDate(date) {
  return parseDateStrict(date) !== null;
}

function isValidTime(time) {
  return generateDaySlots().includes(time);
}

function generateDaySlots() {
  const slots = [];
  for (let mins = CLINIC.openHour * 60; mins < CLINIC.closeHour * 60; mins += CLINIC.slotMinutes) {
    const h = String(Math.floor(mins / 60)).padStart(2, "0");
    const m = String(mins % 60).padStart(2, "0");
    slots.push(`${h}:${m}`);
  }
  return slots;
}

// Current date/time in the clinic's fixed timezone (Asia/Riyadh, UTC+3,
// no DST), independent of the host server's own timezone.
function getClinicNow() {
  const offsetMs = (CLINIC.timezoneOffsetMinutes || 0) * 60000;
  const clinicMoment = new Date(Date.now() + offsetMs);
  return {
    dateStr: clinicMoment.toISOString().slice(0, 10),
    minutesSinceMidnight: clinicMoment.getUTCHours() * 60 + clinicMoment.getUTCMinutes(),
  };
}

function addDays(dateStr, days) {
  const dt = parseDateStrict(dateStr);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Shared by getAvailableSlots and findNextAvailable so both apply the same
// "no slots in the past, none earlier than right now on today" rules.
function openSlotsFor(date, bookedTimes, clinicNow) {
  if (date < clinicNow.dateStr) return [];
  const booked = new Set(bookedTimes || []);
  let slots = generateDaySlots().filter((t) => !booked.has(t));
  if (date === clinicNow.dateStr) {
    slots = slots.filter((t) => {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + m > clinicNow.minutesSinceMidnight;
    });
  }
  return slots;
}

async function getAvailableSlots(date) {
  if (!isValidDate(date)) return [];
  const clinicNow = getClinicNow();
  if (date < clinicNow.dateStr) return [];
  return openSlotsFor(date, await db.getBookedTimes(date), clinicNow);
}

async function isSlotAvailable(date, time) {
  return (await getAvailableSlots(date)).includes(time);
}

async function findNextAvailable({ fromDate, time, maxDays = 30 }) {
  const clinicNow = getClinicNow();
  let start = isValidDate(fromDate) ? fromDate : clinicNow.dateStr;
  if (start < clinicNow.dateStr) start = clinicNow.dateStr;
  const end = addDays(start, maxDays - 1);

  // Single query for the whole window instead of one per day.
  const bookedByDate = await db.getBookedTimesByRange(start, end);

  let date = start;
  for (let i = 0; i < maxDays; i++) {
    const slots = openSlotsFor(date, bookedByDate.get(date), clinicNow);
    if (time) {
      if (slots.includes(time)) return { date, time };
    } else if (slots.length) {
      return { date, time: slots[0], availableSlots: slots };
    }
    date = addDays(date, 1);
  }
  return null;
}

// ---------- booking references ----------
// Ambiguous characters (0/O, 1/I) are left out so a reference survives being
// read out over the phone. Uniqueness is enforced by a unique index in the
// database, not by scanning the table: createAppointment retries on collision.
const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const REF_LENGTH = 6;
const REF_ATTEMPTS = 50;

function generateRef() {
  let ref = "";
  for (let i = 0; i < REF_LENGTH; i++) {
    ref += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
  }
  return ref;
}

function normalizeRef(ref) {
  return String(ref || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

// What a caller is allowed to see about an appointment. Deliberately drops
// the stored phone number, the patient's free-text message and the internal
// id — none of them is needed to reschedule or cancel (the credential is the
// phone number plus the reference), so none is handed to the assistant.
function publicView(appt) {
  if (!appt) return null;
  return {
    ref: appt.ref,
    name: appt.name,
    service: appt.service,
    date: appt.date,
    time: appt.time,
    status: appt.status,
  };
}

async function createAppointment({ name, phone, service, date, time, message, source, status }) {
  if (!name || !String(name).trim()) throw fail("Patient name is required.", 400);
  if (!phone || !String(phone).trim()) throw fail("Phone number is required.", 400);
  if (!isValidDate(date)) throw fail("Invalid date format. Use YYYY-MM-DD.", 400);
  if (!isValidTime(time)) throw fail("Invalid or out-of-hours time slot.", 400);
  if (date < getClinicNow().dateStr) throw fail("Cannot book an appointment in the past.", 400);
  if (!(await isSlotAvailable(date, time))) throw fail("That slot is already booked.", 409);

  const cleanPhone = stripControlChars(phone).slice(0, 30);
  const base = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: stripControlChars(name).slice(0, 100),
    phone: cleanPhone,
    phoneDigits: phoneKey(cleanPhone),
    service: stripControlChars(service || "").slice(0, 100),
    date,
    time,
    message: String(message || "").replace(/\r\n?/g, "\n").trim().slice(0, 1000),
    status: status || "confirmed",
    source: source || "chat",
    createdAt: new Date().toISOString(),
  };

  // The unique index on `ref` is the real guard. A collision is astronomically
  // unlikely (32^6), but retrying is cheaper than pre-scanning every booking.
  for (let attempt = 0; attempt < REF_ATTEMPTS; attempt++) {
    let created;
    try {
      created = await db.insertAppointment({ ...base, ref: generateRef() });
    } catch (err) {
      if (err.message === "REF_TAKEN") continue;
      // The availability check above can lose a race against a booking on
      // another instance; the database's unique index is what actually decides.
      if (err.message === "SLOT_TAKEN") throw fail("That slot is already booked.", 409);
      throw err;
    }
    // Deliberately outside the try above: that block interprets storage errors
    // as REF_TAKEN/SLOT_TAKEN, and a mail failure must never be mistaken for a
    // reference collision and retried into a second booking.
    await notifyClinic("booked", created);
    return publicView(created);
  }
  throw fail("Could not allocate a unique appointment reference.", 500);
}

// Needs the phone number AND the booking reference. Either one alone returns
// nothing — that is the whole point of the reference.
async function findAppointmentsByPhone(phone, ref) {
  const p = phoneKey(phone);
  const r = normalizeRef(ref);
  if (!p || !r) return [];
  const rows = await db.findByPhoneDigits(p);
  return rows.filter((a) => normalizeRef(a.ref) === r).map(publicView);
}

// Resolves an appointment for a change. The credential is the phone number
// AND the booking reference together — exactly what is needed to read one —
// so changing an appointment is never easier than viewing it. The internal
// id is not part of the credential and is never given to the caller.
//
// Every failure mode (unknown reference, right reference with the wrong
// phone, missing input) raises the SAME 404, so the error can never confirm
// that a reference exists or that a phone number is associated with one.
async function requireAppointment(phone, ref) {
  const r = normalizeRef(ref);
  const p = phoneKey(phone);
  const notFound = () => fail("Appointment not found. Please check the phone number and booking reference.", 404);
  if (!r || !p) throw notFound();
  const appt = await db.getAppointmentByRef(r);
  if (!appt || phoneKey(appt.phone) !== p) throw notFound();
  return appt;
}

// Resolves an appointment for a CLINIC-side change. Staff reach this having
// already authenticated with ADMIN_KEY, so the reference alone identifies the
// booking: a receptionist working from the appointment list has no reason to
// hold the patient's phone number, and requiring it would only push staff
// towards looking phone numbers up for the sake of the form.
async function requireAppointmentByRef(ref) {
  const r = normalizeRef(ref);
  const notFound = () => fail("Appointment not found. Please check the booking reference.", 404);
  if (!r) throw notFound();
  const appt = await db.getAppointmentByRef(r);
  if (!appt) throw notFound();
  return appt;
}

// The clinic's notification email legitimately needs the full row — the staff
// have to phone the patient back, and the patient's note is the point of the
// message. That is the ONLY legitimate consumer of unredacted appointment data
// on the change path, so it is served from inside this module: the raw row is
// handed straight to the mailer and never returned to a caller.
//
// This is what lets rescheduleAppointment/cancelAppointment return publicView()
// unconditionally. A future caller cannot forget to redact, because there is no
// unredacted value for it to receive.
//
// Awaited, not fired and forgotten: a serverless instance is frozen once the
// response is sent. Failures are swallowed — a broken SMTP server must never
// undo a change that is already committed to the database.
async function notifyClinic(action, rawEntry) {
  try {
    if (action === "booked") await mailer.notifyNewAppointment(rawEntry);
    else await mailer.notifyAppointmentChange(action, rawEntry);
  } catch (err) {
    console.error(`Email notification failed for a ${action} appointment:`, err.message);
  }
}

// The reschedule rules themselves, applied to an appointment the caller has
// already proved it may touch. Patients get here with phone + reference and
// staff with ADMIN_KEY + reference, but what makes a new slot legal — a real
// date, clinic hours, not in the past, not already taken — cannot differ
// between the two, so it lives in one place. Returns the raw row; the
// exported wrappers below are what redact it.
async function applyReschedule(appt, newDate, newTime) {
  if (appt.status === "cancelled") throw fail("This appointment was already cancelled.", 409);
  if (!isValidDate(newDate)) throw fail("Invalid date format. Use YYYY-MM-DD.", 400);
  if (!isValidTime(newTime)) throw fail("Invalid or out-of-hours time slot.", 400);
  if (newDate < getClinicNow().dateStr) throw fail("Cannot reschedule to a date in the past.", 400);

  const sameSlot = appt.date === newDate && appt.time === newTime;
  if (!sameSlot && !(await isSlotAvailable(newDate, newTime))) {
    throw fail("That slot is already booked.", 409);
  }

  let updated;
  try {
    updated = await db.updateAppointmentSchedule(appt.id, newDate, newTime, new Date().toISOString());
  } catch (err) {
    if (err.message === "SLOT_TAKEN") throw fail("That slot is already booked.", 409);
    throw err;
  }
  if (!updated) throw fail("This appointment was already cancelled.", 409);
  return updated;
}

async function rescheduleAppointment({ phone, ref, newDate, newTime }) {
  const appt = await requireAppointment(phone, ref);
  const updated = await applyReschedule(appt, newDate, newTime);
  await notifyClinic("rescheduled", updated);
  return publicView(updated);
}

async function cancelAppointment({ phone, ref }) {
  const appt = await requireAppointment(phone, ref);
  const cancelled = await db.cancelAppointmentById(appt.id, new Date().toISOString());
  if (!cancelled) throw fail("This appointment was already cancelled.", 409);
  await notifyClinic("cancelled", cancelled);
  return publicView(cancelled);
}

// ---------- clinic-side changes ----------
//
// The same storage primitives and the same booking rules as the patient paths
// above. Two things differ, both deliberately:
//
//   * The credential is ADMIN_KEY (checked at the route) plus the reference,
//     not phone + reference.
//   * Repeating an action that has already happened answers with the current
//     state instead of an error. Staff work down a list and click twice; a
//     409 there would read as "something is wrong" when nothing is.
//
// `changed` says whether this call actually moved anything, so the route can
// word the response honestly either way.
//
// None of these send the clinic a notification email: the clinic is the one
// making the change, and mailer.notifyAppointmentChange attributes the action
// to the AI assistant, which would be a lie here.

const unchanged = (appt) => ({ appointment: publicView(appt), changed: false });

// Re-read after a losing race so the response still describes the row as it
// actually stands, rather than the stale copy this call started from.
async function currentState(ref, fallback) {
  const current = await db.getAppointmentByRef(normalizeRef(ref));
  return unchanged(current || fallback);
}

async function adminConfirmAppointment(ref) {
  const appt = await requireAppointmentByRef(ref);
  if (appt.status === "cancelled") {
    throw fail(
      "This appointment was cancelled and cannot be confirmed. Book a new appointment instead.",
      409
    );
  }
  if (appt.status === "confirmed") return unchanged(appt);

  const confirmed = await db.confirmAppointmentById(appt.id, new Date().toISOString());
  if (!confirmed) return currentState(ref, appt);
  return { appointment: publicView(confirmed), changed: true };
}

async function adminCancelAppointment(ref) {
  const appt = await requireAppointmentByRef(ref);
  if (appt.status === "cancelled") return unchanged(appt);

  // Cancelling is what frees the slot: every availability query ignores
  // cancelled rows, and appointments_slot_unique stops covering them.
  const cancelled = await db.cancelAppointmentById(appt.id, new Date().toISOString());
  if (!cancelled) return currentState(ref, appt);
  return { appointment: publicView(cancelled), changed: true };
}

// The reference and the status both survive: the row moves to a new slot,
// which frees the old one, and a booking the patient has not confirmed yet
// does not become confirmed just because the clinic moved it.
async function adminRescheduleAppointment({ ref, newDate, newTime }) {
  const appt = await requireAppointmentByRef(ref);
  const sameSlot = appt.date === newDate && appt.time === newTime;
  const updated = await applyReschedule(appt, newDate, newTime);
  return { appointment: publicView(updated), changed: !sameSlot };
}

// Admin-only view: the full rows, phone numbers included. Guarded by ADMIN_KEY
// at the route, never exposed to the chat assistant.
function loadAppointments() {
  return db.listAppointments();
}

// Returns true when this ip has already used up its allowance for the bucket.
async function isRateLimited(bucket, ip, windowMs, maxPerWindow) {
  try {
    const priorHits = await db.countRateLimitHits(bucket, ip, windowMs);
    return priorHits >= maxPerWindow;
  } catch (err) {
    // Never let a rate-limit lookup take the whole endpoint down.
    console.error("Rate limit check failed:", err.message);
    return false;
  }
}

module.exports = {
  publicView,
  getClinicInfo,
  getServices,
  getClinicNow,
  generateDaySlots,
  getAvailableSlots,
  isSlotAvailable,
  findNextAvailable,
  createAppointment,
  findAppointmentsByPhone,
  rescheduleAppointment,
  cancelAppointment,
  adminConfirmAppointment,
  adminCancelAppointment,
  adminRescheduleAppointment,
  loadAppointments,
  isRateLimited,
  isValidDate,
  isValidTime,
};
