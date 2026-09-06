const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE = path.join(__dirname, "data", "appointments.json");
const TMP_FILE = DATA_FILE + ".tmp";
const CLINIC = require("./data/clinic.json");
const SERVICES = require("./data/services.json");

// Errors carry a `status` so callers can tell "the patient did something
// invalid" (400/409, safe to show them) from "storage is broken" (500, log
// it and show a generic message).
function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Reads the appointments file. A missing or empty file means "no appointments
// yet" — anything else that fails to parse is a hard error on purpose.
// Returning [] on a corrupt file was silent data loss: the next booking would
// save a one-item list straight over every existing appointment.
function loadAppointments() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw fail(`Could not read ${DATA_FILE}: ${err.message}`, 500);
  }

  if (!raw.trim()) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw fail(
      `${DATA_FILE} is not valid JSON (${err.message}). Refusing to continue so the existing ` +
        `appointments aren't overwritten — restore the file from a backup or repair it by hand.`,
      500
    );
  }

  if (!Array.isArray(parsed)) {
    throw fail(`${DATA_FILE} must contain a JSON array of appointments.`, 500);
  }
  return parsed;
}

// Writes to a temp file first and renames it into place, so a crash or a full
// disk mid-write leaves the old file intact instead of a half-written one.
function saveAppointments(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(list, null, 2));
    fs.renameSync(TMP_FILE, DATA_FILE);
  } catch (err) {
    try {
      fs.unlinkSync(TMP_FILE);
    } catch {
      /* nothing to clean up */
    }
    throw fail(`Could not save appointments to ${DATA_FILE}: ${err.message}`, 500);
  }
}

// Strips newlines/control characters so patient-supplied text can't break
// out of a single line (e.g. email header/subject injection via the name
// field, or garbled rows in admin.html).
function stripControlChars(s) {
  return String(s || "").replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ").trim();
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

function getAvailableSlots(date) {
  if (!isValidDate(date)) return [];
  const { dateStr: todayStr, minutesSinceMidnight: nowMinutes } = getClinicNow();
  if (date < todayStr) return [];

  const all = loadAppointments();
  const booked = new Set(
    all
      .filter((a) => a.date === date && a.status !== "cancelled" && a.time)
      .map((a) => a.time)
  );
  let slots = generateDaySlots().filter((t) => !booked.has(t));

  if (date === todayStr) {
    slots = slots.filter((t) => {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + m > nowMinutes;
    });
  }

  return slots;
}

function isSlotAvailable(date, time) {
  return getAvailableSlots(date).includes(time);
}

function addDays(dateStr, days) {
  const dt = parseDateStrict(dateStr);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function findNextAvailable({ fromDate, time, maxDays = 30 }) {
  let date = isValidDate(fromDate) ? fromDate : getClinicNow().dateStr;
  for (let i = 0; i < maxDays; i++) {
    const slots = getAvailableSlots(date);
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
// A phone number is not a secret: anyone who knows one could previously read,
// move or cancel that patient's appointment. So every booking also gets a
// short reference, given to the patient at booking time, and looking an
// appointment up needs BOTH. Ambiguous characters (0/O, 1/I) are left out so
// it survives being read out over the phone.
const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const REF_LENGTH = 6;

function generateRef(existing) {
  const taken = new Set(existing.map((a) => String(a.ref || "").toUpperCase()));
  for (let attempt = 0; attempt < 50; attempt++) {
    let ref = "";
    for (let i = 0; i < REF_LENGTH; i++) {
      ref += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
    }
    if (!taken.has(ref)) return ref;
  }
  throw fail("Could not allocate a unique appointment reference.", 500);
}

function normalizeRef(ref) {
  return String(ref || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

// Compare the last 9 digits so "0501234567", "+966 50 123 4567" and
// "966501234567" all resolve to the same patient.
function phoneKey(phone) {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  return digits.length > 9 ? digits.slice(-9) : digits;
}

// What a caller is allowed to see about an appointment. Deliberately drops
// the stored phone number and the patient's free-text message — neither is
// needed to reschedule or cancel, so neither is handed to the assistant.
function publicView(appt) {
  return {
    id: appt.id,
    ref: appt.ref,
    name: appt.name,
    service: appt.service,
    date: appt.date,
    time: appt.time,
    status: appt.status,
  };
}

function createAppointment({ name, phone, service, date, time, message, source, status }) {
  if (!name || !String(name).trim()) throw fail("Patient name is required.", 400);
  if (!phone || !String(phone).trim()) throw fail("Phone number is required.", 400);
  if (!isValidDate(date)) throw fail("Invalid date format. Use YYYY-MM-DD.", 400);
  if (!isValidTime(time)) throw fail("Invalid or out-of-hours time slot.", 400);
  if (date < getClinicNow().dateStr) throw fail("Cannot book an appointment in the past.", 400);
  if (!isSlotAvailable(date, time)) throw fail("That slot is already booked.", 409);

  const list = loadAppointments();

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    ref: generateRef(list),
    name: stripControlChars(name).slice(0, 100),
    phone: stripControlChars(phone).slice(0, 30),
    service: stripControlChars(service || "").slice(0, 100),
    date,
    time,
    message: String(message || "").replace(/\r\n?/g, "\n").trim().slice(0, 1000),
    status: status || "confirmed",
    source: source || "chat",
    createdAt: new Date().toISOString(),
  };

  list.push(entry);
  saveAppointments(list);
  return entry;
}

// Needs the phone number AND the booking reference. Either one alone returns
// nothing — that is the whole point of the reference.
function findAppointmentsByPhone(phone, ref) {
  const p = phoneKey(phone);
  const r = normalizeRef(ref);
  if (!p || !r) return [];
  return loadAppointments()
    .filter((a) => a.status !== "cancelled")
    .filter((a) => phoneKey(a.phone) === p && normalizeRef(a.ref) === r)
    .map(publicView);
}

// Resolves an appointment for a change. Requires the reference as well as the
// id, so a guessed id on its own gets nowhere. A wrong reference is reported
// as "not found" rather than "wrong reference" — otherwise the error message
// itself confirms that the id exists.
function requireAppointment(list, id, ref) {
  const appt = list.find((a) => a.id === id);
  if (!appt || !normalizeRef(ref) || normalizeRef(appt.ref) !== normalizeRef(ref)) {
    throw fail("Appointment not found. Please check the booking reference.", 404);
  }
  return appt;
}

function rescheduleAppointment({ id, ref, newDate, newTime }) {
  const list = loadAppointments();
  const appt = requireAppointment(list, id, ref);
  if (appt.status === "cancelled") throw fail("This appointment was already cancelled.", 409);
  if (!isValidDate(newDate)) throw fail("Invalid date format. Use YYYY-MM-DD.", 400);
  if (!isValidTime(newTime)) throw fail("Invalid or out-of-hours time slot.", 400);
  if (newDate < getClinicNow().dateStr) throw fail("Cannot reschedule to a date in the past.", 400);
  const sameSlot = appt.date === newDate && appt.time === newTime;
  if (!sameSlot && !isSlotAvailable(newDate, newTime)) {
    throw fail("That slot is already booked.", 409);
  }
  appt.date = newDate;
  appt.time = newTime;
  appt.updatedAt = new Date().toISOString();
  saveAppointments(list);
  return appt;
}

function cancelAppointment({ id, ref }) {
  const list = loadAppointments();
  const appt = requireAppointment(list, id, ref);
  if (appt.status === "cancelled") throw fail("This appointment was already cancelled.", 409);
  appt.status = "cancelled";
  appt.updatedAt = new Date().toISOString();
  saveAppointments(list);
  return appt;
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
  loadAppointments,
  saveAppointments,
  isValidDate,
  isValidTime,
};
