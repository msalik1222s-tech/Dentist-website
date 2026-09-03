const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data", "appointments.json");
const CLINIC = require("./data/clinic.json");
const SERVICES = require("./data/services.json");

function loadAppointments() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveAppointments(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

function getClinicInfo() {
  return CLINIC;
}

function getServices() {
  return SERVICES;
}

function getServiceByName(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  return (
    SERVICES.find((s) => s.id === n || s.name.toLowerCase() === n) ||
    SERVICES.find((s) => s.name.toLowerCase().includes(n) || n.includes(s.name.toLowerCase())) ||
    null
  );
}

function isValidDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) && !Number.isNaN(Date.parse(date));
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

function getAvailableSlots(date) {
  if (!isValidDate(date)) return [];
  const all = loadAppointments();
  const booked = new Set(
    all
      .filter((a) => a.date === date && a.status !== "cancelled" && a.time)
      .map((a) => a.time)
  );
  return generateDaySlots().filter((t) => !booked.has(t));
}

function isSlotAvailable(date, time) {
  return getAvailableSlots(date).includes(time);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function findNextAvailable({ fromDate, time, maxDays = 30 }) {
  let date = isValidDate(fromDate) ? fromDate : new Date().toISOString().slice(0, 10);
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

function createAppointment({ name, phone, service, date, time, message }) {
  if (!name || !String(name).trim()) throw new Error("Patient name is required.");
  if (!phone || !String(phone).trim()) throw new Error("Phone number is required.");
  if (!isValidDate(date)) throw new Error("Invalid date format. Use YYYY-MM-DD.");
  if (!isValidTime(time)) throw new Error("Invalid or out-of-hours time slot.");
  if (!isSlotAvailable(date, time)) throw new Error("That slot is already booked.");

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: String(name).trim(),
    phone: String(phone).trim(),
    service: String(service || "").trim(),
    date,
    time,
    message: String(message || "").trim(),
    status: "confirmed",
    source: "chat",
    createdAt: new Date().toISOString(),
  };

  const list = loadAppointments();
  list.push(entry);
  saveAppointments(list);
  return entry;
}

function findAppointmentsByPhone(phone) {
  const p = String(phone || "").replace(/[^0-9]/g, "");
  if (!p) return [];
  return loadAppointments().filter(
    (a) => String(a.phone || "").replace(/[^0-9]/g, "") === p && a.status !== "cancelled"
  );
}

function rescheduleAppointment({ id, newDate, newTime }) {
  const list = loadAppointments();
  const appt = list.find((a) => a.id === id);
  if (!appt) throw new Error("Appointment not found.");
  if (appt.status === "cancelled") throw new Error("This appointment was already cancelled.");
  if (!isValidDate(newDate)) throw new Error("Invalid date format. Use YYYY-MM-DD.");
  if (!isValidTime(newTime)) throw new Error("Invalid or out-of-hours time slot.");
  const sameSlot = appt.date === newDate && appt.time === newTime;
  if (!sameSlot && !isSlotAvailable(newDate, newTime)) {
    throw new Error("That slot is already booked.");
  }
  appt.date = newDate;
  appt.time = newTime;
  appt.updatedAt = new Date().toISOString();
  saveAppointments(list);
  return appt;
}

function cancelAppointment({ id }) {
  const list = loadAppointments();
  const appt = list.find((a) => a.id === id);
  if (!appt) throw new Error("Appointment not found.");
  if (appt.status === "cancelled") throw new Error("This appointment was already cancelled.");
  appt.status = "cancelled";
  appt.updatedAt = new Date().toISOString();
  saveAppointments(list);
  return appt;
}

module.exports = {
  getClinicInfo,
  getServices,
  getServiceByName,
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
