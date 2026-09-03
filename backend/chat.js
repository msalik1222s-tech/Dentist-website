const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const store = require("./store");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MASTER_PROMPT = fs.readFileSync(path.join(__dirname, "data", "system-prompt.txt"), "utf8");

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function buildSystemPrompt() {
  const clinic = store.getClinicInfo();
  const services = store.getServices();
  const today = new Date().toISOString().slice(0, 10);

  const dataBlock = [
    "",
    "============================================================",
    "LIVE AUTHORIZED CLINIC DATABASE (this overrides anything above it says by default — use it as the single source of truth)",
    "============================================================",
    `Today's date: ${today}`,
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

  return MASTER_PROMPT + dataBlock;
}

const TOOLS = [
  {
    name: "get_clinic_info",
    description: "Get the clinic's name, dentist, opening hours, phone, email and address from the live database.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_services",
    description: "Get the full list of dental services and their official starting prices from the live pricing database.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "check_availability",
    description:
      "Check live appointment availability. Pass a date to see all open slots that day. Also pass a time to check one exact slot. Times are 24-hour HH:MM in the clinic's local time.",
    input_schema: {
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
      "Search forward from a date (or today) for the next day that has open slots, optionally matching a specific time of day. Use this for 'earliest appointment' or when a requested date is fully booked.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "Date to start searching from, YYYY-MM-DD. Defaults to today." },
        time: { type: "string", description: "Optional exact HH:MM time to match on each day checked." },
      },
    },
  },
  {
    name: "book_appointment",
    description:
      "Book a confirmed appointment. Only call this after the patient has confirmed the exact date, time and service, and after check_availability has shown that slot as open.",
    input_schema: {
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
      "Look up a patient's existing, non-cancelled appointments by their phone number. Required before rescheduling or cancelling — never act on an appointment without first verifying it through this tool.",
    input_schema: {
      type: "object",
      properties: { phone: { type: "string" } },
      required: ["phone"],
    },
  },
  {
    name: "reschedule_appointment",
    description: "Move an existing appointment to a new date/time. Requires the appointment id from find_appointments_by_phone.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        new_date: { type: "string", description: "YYYY-MM-DD" },
        new_time: { type: "string", description: "HH:MM 24-hour" },
      },
      required: ["id", "new_date", "new_time"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing appointment. Requires the appointment id from find_appointments_by_phone. Only call after the patient explicitly confirms they want to cancel.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

function runTool(name, input) {
  try {
    switch (name) {
      case "get_clinic_info":
        return store.getClinicInfo();

      case "get_services":
        return store.getServices();

      case "check_availability": {
        if (!store.isValidDate(input.date)) return { error: "Invalid date format, expected YYYY-MM-DD." };
        const availableSlots = store.getAvailableSlots(input.date);
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
        const result = store.findNextAvailable({ fromDate: input.from_date, time: input.time });
        return result || { found: false };
      }

      case "book_appointment": {
        const entry = store.createAppointment({
          name: input.name,
          phone: input.phone,
          service: input.service,
          date: input.date,
          time: input.time,
          message: input.message,
        });
        return { success: true, appointment: entry };
      }

      case "find_appointments_by_phone":
        return { appointments: store.findAppointmentsByPhone(input.phone) };

      case "reschedule_appointment": {
        const appt = store.rescheduleAppointment({
          id: input.id,
          newDate: input.new_date,
          newTime: input.new_time,
        });
        return { success: true, appointment: appt };
      }

      case "cancel_appointment": {
        const appt = store.cancelAppointment({ id: input.id });
        return { success: true, appointment: appt };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

async function respond(clientMessages) {
  const anthropic = getClient();
  if (!anthropic) {
    throw new Error("CHAT_NOT_CONFIGURED");
  }

  let messages = clientMessages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  const system = buildSystemPrompt();

  for (let turn = 0; turn < 6; turn++) {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: TOOLS,
      messages,
    });

    if (resp.stop_reason !== "tool_use") {
      return resp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    }

    messages.push({ role: "assistant", content: resp.content });

    const toolResults = resp.content
      .filter((b) => b.type === "tool_use")
      .map((block) => ({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(runTool(block.name, block.input || {})),
      }));

    messages.push({ role: "user", content: toolResults });
  }

  return "I'm having trouble completing that right now — please call the clinic directly.";
}

module.exports = { respond };
