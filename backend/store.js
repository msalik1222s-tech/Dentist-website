const db = require("./db");

const CLINIC = require("./data/clinic.json");
const SERVICES = require("./data/services.json");

// Strips newlines/control characters so patient-supplied text can't break
// out of a single line (e.g. email header/subject injection via the name
// field, or garbled rows in admin.html).
function stripControlChars(s) {
  return String(s || "").replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ").trim();
}

function phoneDigits(phone) {
  return String(phone || "").replace(/[^0-9]/g, "");
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

async function createAppointment({ name, phone, service, date, time, message, source, status }) {
  if (!name || !String(name).trim()) throw new Error("Patient name is required.");
  if (!phone || !String(phone).trim()) throw new Error("Phone number is required.");
  if (!isValidDate(date)) throw new Error("Invalid date format. Use YYYY-MM-DD.");
  if (!isValidTime(time)) throw new Error("Invalid or out-of-hours time slot.");
  if (date < getClinicNow().dateStr) throw new Error("Cannot book an appointment in the past.");
  if (!(await isSlotAvailable(date, time))) throw new Error("That slot is already booked.");

  const cleanPhone = stripControlChars(phone).slice(0, 30);
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: stripControlChars(name).slice(0, 100),
    phone: cleanPhone,
    phoneDigits: phoneDigits(cleanPhone),
    service: stripControlChars(service || "").slice(0, 100),
    date,
    time,
    message: String(message || "").replace(/\r\n?/g, "\n").trim().slice(0, 1000),
    status: status || "confirmed",
    source: source || "chat",
    createdAt: new Date().toISOString(),
  };

  try {
    return await db.insertAppointment(entry);
  } catch (err) {
    // The check above can lose a race against a booking on another instance;
    // the database's unique index is what actually decides.
    if (err.message === "SLOT_TAKEN") throw new Error("That slot is already booked.");
    throw err;
  }
}

async function findAppointmentsByPhone(phone) {
  const p = phoneDigits(phone);
  if (!p) return [];
  return db.findByPhoneDigits(p);
}

async function rescheduleAppointment({ id, newDate, newTime }) {
  const appt = await db.getAppointmentById(id);
  if (!appt) throw new Error("Appointment not found.");
  if (appt.status === "cancelled") throw new Error("This appointment was already cancelled.");
  if (!isValidDate(newDate)) throw new Error("Invalid date format. Use YYYY-MM-DD.");
  if (!isValidTime(newTime)) throw new Error("Invalid or out-of-hours time slot.");
  if (newDate < getClinicNow().dateStr) throw new Error("Cannot reschedule to a date in the past.");

  const sameSlot = appt.date === newDate && appt.time === newTime;
  if (!sameSlot && !(await isSlotAvailable(newDate, newTime))) {
    throw new Error("That slot is already booked.");
  }

  let updated;
  try {
    updated = await db.updateAppointmentSchedule(id, newDate, newTime, new Date().toISOString());
  } catch (err) {
    if (err.message === "SLOT_TAKEN") throw new Error("That slot is already booked.");
    throw err;
  }
  if (!updated) throw new Error("This appointment was already cancelled.");
  return updated;
}

async function cancelAppointment({ id }) {
  const appt = await db.getAppointmentById(id);
  if (!appt) throw new Error("Appointment not found.");
  const cancelled = await db.cancelAppointmentById(id, new Date().toISOString());
  if (!cancelled) throw new Error("This appointment was already cancelled.");
  return cancelled;
}

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
  isRateLimited,
  isValidDate,
  isValidTime,
};
