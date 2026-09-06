// Provider-neutral half of the AI assistant: the system prompt, the tool
// catalogue, and the code that runs a tool against the clinic database.
// Nothing here knows which LLM vendor is in use — the adapters in
// chat-openai.js / chat-anthropic.js translate it into their own wire format.
//
// The privacy rules live HERE, not in the adapters, so they apply identically
// whichever provider is active:
//   * reading or changing an appointment needs the phone number AND the
//     booking reference — a phone number alone is not a credential;
//   * every appointment handed back goes through store.publicView(), so the
//     stored phone number and the patient's private note never enter the
//     model's context;
//   * storage failures are replaced with a generic message, so file paths and
//     internal detail never reach the patient.

const fs = require("fs");
const path = require("path");
const store = require("./store");
const mailer = require("./mailer");

const MASTER_PROMPT = fs.readFileSync(path.join(__dirname, "data", "system-prompt.txt"), "utf8");

// The system prompt is split into two parts on purpose.
//
// `cached` is everything that does not change between requests: the master
// prompt plus the clinic profile and price list. Anthropic marks the end of it
// with a cache breakpoint so it is billed in full once and read from cache
// afterwards; OpenAI caches long stable prefixes automatically.
//
// `volatile` is only today's date and the current clock time. That changes
// every minute, so it MUST come last — with the clock inside the cached part,
// the cached prefix would change every minute and never be hit.
function buildSystemPrompt() {
  const clinic = store.getClinicInfo();
  const services = store.getServices();
  const now = store.getClinicNow();
  const currentTime = `${String(Math.floor(now.minutesSinceMidnight / 60)).padStart(2, "0")}:${String(now.minutesSinceMidnight % 60).padStart(2, "0")}`;

  const dataBlock = [
    "",
    "============================================================",
    "LIVE AUTHORIZED CLINIC DATABASE (this overrides anything above it — use it as the single source of truth)",
    "============================================================",
    `Clinic name: ${clinic.name}`,
    `Dentist: ${clinic.dentist}`,
    `Opening hours: ${clinic.hoursLabel}`,
    `Phone: ${clinic.phone}`,
    `Email: ${clinic.email}`,
    `Address: ${clinic.address}`,
    `Currency: ${clinic.currency}`,
    "",
    "Services and official prices:",
    ...services.map((s) => `- ${s.name}: ${s.priceLabel} (id: ${s.id})`),
    "",
    "Appointment availability, booking, rescheduling and cancellation are NOT static — always call the matching tool to check or change them. Never state a slot is available without calling check_availability first.",
  ].join("\n");

  const clockBlock = [
    "",
    "------------------------------------------------------------",
    "CURRENT DATE AND TIME",
    "------------------------------------------------------------",
    `Today's date (clinic-local, Asia/Riyadh): ${now.dateStr}`,
    `Current clinic-local time: ${currentTime}`,
    'Resolve "today", "tomorrow" and "next week" against this date, never against anything you remember.',
  ].join("\n");

  return { cached: MASTER_PROMPT + dataBlock, volatile: clockBlock };
}

// Canonical tool definitions. `parameters` is plain JSON Schema, which is what
// OpenAI expects verbatim and what Anthropic calls `input_schema`.
//
// The `required` arrays are a hint to the model, not a guarantee — a model can
// still call a tool with a field missing. store.js enforces the same rules
// server-side, so a dropped `reference` fails there too.
const TOOLS = [
  {
    name: "get_clinic_info",
    description: "Get the clinic's name, dentist, opening hours, phone, email and address from the live database.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_services",
    description: "Get the full list of dental services and their official starting prices from the live pricing database.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "check_availability",
    description:
      "Check live appointment availability. Pass a date to see all open slots that day. Also pass a time to check one exact slot. Times are 24-hour HH:MM in the clinic's local time.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format." },
        time: { type: "string", description: "Optional exact time in HH:MM 24-hour format." },
      },
      required: ["date"],
    },
  },
  {
    name: "find_next_available",
    description:
      "Search forward from a date (or today) for the next day that has open slots, optionally matching a specific time of day. Use this for the earliest available appointment, or when a requested date is fully booked.",
    parameters: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "Date to start searching from, YYYY-MM-DD. Defaults to today." },
        time: { type: "string", description: "Optional exact HH:MM time to match on each day checked." },
      },
      required: [],
    },
  },
  {
    name: "book_appointment",
    description:
      "Book a confirmed appointment. Only call this after the patient has confirmed the exact date, time and service, and after check_availability has shown that slot as open.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        phone: { type: "string" },
        service: { type: "string", description: "Service name as listed in get_services." },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM 24-hour" },
        message: { type: "string", description: "Optional notes from the patient." },
      },
      required: ["name", "phone", "service", "date", "time"],
    },
  },
  {
    name: "find_appointments_by_phone",
    description:
      "Look up a patient's existing, non-cancelled appointments. Requires BOTH their phone number and the booking reference they were given when the appointment was made (a 6-character code like 4KP7MQ) — a phone number alone will return nothing, because phone numbers are not private. Required before rescheduling or cancelling. If the patient does not have their reference, do not try other tools: ask them to call the clinic.",
    parameters: {
      type: "object",
      properties: {
        phone: { type: "string" },
        reference: { type: "string", description: "The 6-character booking reference given to the patient at booking time." },
      },
      required: ["phone", "reference"],
    },
  },
  {
    name: "reschedule_appointment",
    description: "Move an existing appointment to a new date/time. Requires the appointment id and reference from find_appointments_by_phone.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        reference: { type: "string", description: "The booking reference, as returned by find_appointments_by_phone." },
        new_date: { type: "string", description: "YYYY-MM-DD" },
        new_time: { type: "string", description: "HH:MM 24-hour" },
      },
      required: ["id", "reference", "new_date", "new_time"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing appointment. Requires the appointment id and reference from find_appointments_by_phone. Only call after the patient explicitly confirms they want to cancel.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        reference: { type: "string", description: "The booking reference, as returned by find_appointments_by_phone." },
      },
      required: ["id", "reference"],
    },
  },
];

// A serverless instance is frozen once the response is sent, so email has to
// be awaited rather than fired and forgotten — but it must never sink a
// booking that is already saved.
async function notify(sendFn) {
  try {
    await sendFn();
  } catch (err) {
    console.error("Email notification failed:", err.message);
  }
}

// Async because every store lookup goes to the database.
async function runTool(name, input) {
  try {
    switch (name) {
      case "get_clinic_info":
        return store.getClinicInfo();

      case "get_services":
        return store.getServices();

      case "check_availability": {
        if (!store.isValidDate(input.date)) return { error: "Invalid date format, expected YYYY-MM-DD." };
        const availableSlots = await store.getAvailableSlots(input.date);
        if (input.time) {
          return {
            date: input.date,
            time: input.time,
            available: availableSlots.includes(input.time),
            availableSlots,
          };
        }
        return { date: input.date, availableSlots, fullyBooked: availableSlots.length === 0 };
      }

      case "find_next_available": {
        const result = await store.findNextAvailable({ fromDate: input.from_date, time: input.time });
        return (
          result || {
            found: false,
            searchedDays: 30,
            note: "Nothing open in the next 30 days from that date. Do not keep calling this tool — tell the patient and offer to have the clinic call them back.",
          }
        );
      }

      case "book_appointment": {
        const entry = await store.createAppointment({
          name: input.name,
          phone: input.phone,
          service: input.service,
          date: input.date,
          time: input.time,
          message: input.message,
        });
        await notify(() => mailer.notifyNewAppointment(entry));
        // publicView drops the stored phone number and the patient's private
        // note before anything is handed to the model.
        return {
          success: true,
          appointment: store.publicView(entry),
          tell_the_patient:
            `Their booking reference is ${entry.ref}. They must keep it — it is required to change or cancel this appointment.`,
        };
      }

      case "find_appointments_by_phone": {
        const appointments = await store.findAppointmentsByPhone(input.phone, input.reference);
        if (!appointments.length) {
          return {
            appointments: [],
            note: "No appointment matches that phone number and reference together. Do not guess or retry with a different reference — ask the patient to check the reference they were given, or to call the clinic.",
          };
        }
        return { appointments };
      }

      case "reschedule_appointment": {
        const appt = await store.rescheduleAppointment({
          id: input.id,
          ref: input.reference,
          newDate: input.new_date,
          newTime: input.new_time,
        });
        await notify(() => mailer.notifyAppointmentChange("rescheduled", appt));
        return { success: true, appointment: store.publicView(appt) };
      }

      case "cancel_appointment": {
        const appt = await store.cancelAppointment({ id: input.id, ref: input.reference });
        await notify(() => mailer.notifyAppointmentChange("cancelled", appt));
        return { success: true, appointment: store.publicView(appt) };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    // Storage failures carry file paths and internal detail — keep those out
    // of the model's context, and therefore out of the patient's chat.
    if (err.status === 500) {
      console.error(`Tool "${name}" failed:`, err);
      return { error: "That information isn't available right now. Ask the patient to call the clinic." };
    }
    return { error: err.message };
  }
}

// How many assistant turns one patient message may take. Each turn is a single
// model call; tool results feed the next one.
const MAX_TURNS = 6;

const FALLBACK_REPLY = "I'm having trouble completing that right now — please call the clinic directly.";

module.exports = { buildSystemPrompt, TOOLS, runTool, MAX_TURNS, FALLBACK_REPLY };
