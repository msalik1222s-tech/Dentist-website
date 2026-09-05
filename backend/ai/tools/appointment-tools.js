// Appointment tools: availability, booking, lookup, rescheduling, cancelling.
//
// These are the only tools that change anything, so they carry the safety
// rules that must not depend on the model behaving:
//
//   * every write goes through backend/store.js, which re-validates the slot
//     and lets the database's unique index settle double-booking races;
//   * a lookup by phone is capped per session, so the chat cannot be used to
//     enumerate other people's appointments;
//   * results are trimmed to what the caller is entitled to see.

const store = require("../../store");
const mailer = require("../../mailer");
const catalog = require("../../persistence/catalog-store");

// How many distinct phone numbers one conversation may look up. A patient
// needs one, occasionally two (their own and a family member's). Anything
// beyond that is someone probing.
const MAX_PHONE_LOOKUPS_PER_SESSION = 5;

// A serverless instance is frozen once the response is sent, so the email has
// to be awaited rather than fired and forgotten — but a failed notification
// must never sink a booking that is already saved.
async function notify(send) {
  try {
    await send();
  } catch (err) {
    console.error("Email notification failed:", err.message);
  }
}

// What the patient gets to see about an appointment. The stored name and full
// phone number are deliberately not echoed back: if the wrong person guessed
// the number, the reply should not confirm whose it is.
function publicAppointment(appointment) {
  return {
    id: appointment.id,
    date: appointment.date,
    time: appointment.time,
    service: appointment.service || null,
    status: appointment.status,
  };
}

// The model is told to pass a service name from get_services. Matching it back
// to a catalogue entry keeps free text out of the appointments table, so the
// clinic's own reports stay clean.
async function resolveServiceName(requested) {
  const wanted = String(requested || "").trim();
  if (!wanted) return "";
  const services = await catalog.getServices();
  const exact = services.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
  if (exact) return exact.name;
  const partial = services.find(
    (s) =>
      s.name.toLowerCase().includes(wanted.toLowerCase()) ||
      wanted.toLowerCase().includes(s.name.toLowerCase())
  );
  return partial ? partial.name : wanted.slice(0, 100);
}

const tools = [
  {
    name: "check_availability",
    description:
      "Check live appointment availability for a date. Pass a time as well to check that exact slot. Times are 24-hour HH:MM in the clinic's local timezone. Never tell a patient a slot is free without calling this first.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format.", maxLength: 10 },
        time: { type: "string", description: "Optional exact time in HH:MM 24-hour format.", maxLength: 5 },
      },
      required: ["date"],
    },
    async handler(input) {
      if (!store.isValidDate(input.date)) {
        return { error: "Invalid date format, expected YYYY-MM-DD." };
      }
      const availableSlots = await store.getAvailableSlots(input.date);
      if (input.time) {
        return {
          date: input.date,
          time: input.time,
          available: availableSlots.includes(input.time),
          availableSlots,
        };
      }
      return {
        date: input.date,
        availableSlots,
        fullyBooked: availableSlots.length === 0,
      };
    },
  },

  {
    name: "find_next_available",
    description:
      "Search forward day by day for the next date with an open slot, optionally matching a particular time of day. Use this for 'the earliest appointment', 'any time is fine', or when the date the patient asked for is fully booked.",
    parameters: {
      type: "object",
      properties: {
        from_date: {
          type: "string",
          description: "Date to start searching from, YYYY-MM-DD. Defaults to today.",
          maxLength: 10,
        },
        time: { type: "string", description: "Optional exact HH:MM time to match on each day.", maxLength: 5 },
      },
    },
    async handler(input) {
      const result = await store.findNextAvailable({ fromDate: input.from_date, time: input.time });
      return result || { found: false, note: "Nothing is open in the next 30 days. Offer to have the clinic call back." };
    },
  },

  {
    name: "book_appointment",
    description:
      "Book a confirmed appointment. Only call this once the patient has given their name and phone number and explicitly confirmed the exact date, time and service — and only after check_availability showed that slot open. The booking is not real until this returns success.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Patient's full name.", maxLength: 100 },
        phone: { type: "string", description: "Patient's contact phone number.", maxLength: 30 },
        service: { type: "string", description: "Service name exactly as listed by get_services.", maxLength: 100 },
        date: { type: "string", description: "YYYY-MM-DD", maxLength: 10 },
        time: { type: "string", description: "HH:MM 24-hour", maxLength: 5 },
        message: { type: "string", description: "Optional note from the patient.", maxLength: 1000 },
      },
      required: ["name", "phone", "service", "date", "time"],
    },
    async handler(input, ctx) {
      const entry = await store.createAppointment({
        name: input.name,
        phone: input.phone,
        service: await resolveServiceName(input.service),
        date: input.date,
        time: input.time,
        message: input.message,
        source: ctx.channel === "whatsapp" ? "whatsapp" : "chat",
      });

      await notify(() => mailer.notifyNewAppointment(entry));

      // Remembering the name and number means the patient is not asked for
      // them again if they come back to reschedule later in the conversation.
      ctx.rememberPatient({ name: entry.name, phone: entry.phone });
      ctx.rememberAppointmentIds([entry.id]);

      return {
        success: true,
        appointment: publicAppointment(entry),
        confirmedWith: store.getClinicInfo().name,
      };
    },
  },

  {
    name: "find_appointments_by_phone",
    description:
      "Look up a patient's upcoming appointments by the phone number they booked with. Required before rescheduling or cancelling — never act on an appointment you have not looked up here first.",
    parameters: {
      type: "object",
      properties: {
        phone: { type: "string", description: "The phone number the appointment was booked with.", maxLength: 30 },
      },
      required: ["phone"],
    },
    async handler(input, ctx) {
      const digits = String(input.phone).replace(/[^0-9]/g, "");
      if (digits.length < 7) {
        return { error: "That does not look like a complete phone number. Ask the patient to repeat it." };
      }

      // Anti-enumeration: a real patient checks one or two numbers.
      const seen = new Set(ctx.facts.lookedUpPhones || []);
      if (!seen.has(digits) && seen.size >= MAX_PHONE_LOOKUPS_PER_SESSION) {
        return {
          error:
            "Too many different phone numbers have been checked in this conversation. Ask the patient to call the clinic so a team member can help.",
        };
      }
      seen.add(digits);
      ctx.setFact("lookedUpPhones", Array.from(seen));

      const appointments = await store.findAppointmentsByPhone(input.phone);
      if (!appointments.length) {
        return {
          appointments: [],
          note: "No upcoming appointment is on file for that number. Do not speculate about why — offer to book a new one, or to have the clinic team check.",
        };
      }

      ctx.rememberPatient({ phone: input.phone });
      // Recorded so reschedule/cancel can refuse an id this conversation never
      // looked up.
      ctx.rememberAppointmentIds(appointments.map((a) => a.id));
      return { appointments: appointments.map(publicAppointment) };
    },
  },

  {
    name: "reschedule_appointment",
    description:
      "Move an existing appointment to a new date and time. Needs the appointment id from find_appointments_by_phone. Check the new slot with check_availability first, and confirm the change with the patient before calling this.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Appointment id from find_appointments_by_phone.", maxLength: 64 },
        new_date: { type: "string", description: "YYYY-MM-DD", maxLength: 10 },
        new_time: { type: "string", description: "HH:MM 24-hour", maxLength: 5 },
      },
      required: ["id", "new_date", "new_time"],
    },
    async handler(input, ctx) {
      // The id must have come back from a lookup in this same conversation.
      // Without that, a guessed id would be enough to move a stranger's
      // appointment.
      if (!ctx.hasSeenAppointmentId(input.id)) {
        return {
          error:
            "That appointment has not been verified in this conversation. Ask the patient for the phone number they booked with and call find_appointments_by_phone first.",
        };
      }

      const appointment = await store.rescheduleAppointment({
        id: input.id,
        newDate: input.new_date,
        newTime: input.new_time,
      });
      await notify(() => mailer.notifyAppointmentChange("rescheduled", appointment));
      return { success: true, appointment: publicAppointment(appointment) };
    },
  },

  {
    name: "cancel_appointment",
    description:
      "Cancel an existing appointment. Needs the appointment id from find_appointments_by_phone. Only call this after the patient has explicitly said they want to cancel that specific appointment.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Appointment id from find_appointments_by_phone.", maxLength: 64 },
      },
      required: ["id"],
    },
    async handler(input, ctx) {
      if (!ctx.hasSeenAppointmentId(input.id)) {
        return {
          error:
            "That appointment has not been verified in this conversation. Ask the patient for the phone number they booked with and call find_appointments_by_phone first.",
        };
      }

      const appointment = await store.cancelAppointment({ id: input.id });
      await notify(() => mailer.notifyAppointmentChange("cancelled", appointment));
      return { success: true, appointment: publicAppointment(appointment) };
    },
  },
];

module.exports = { tools, MAX_PHONE_LOOKUPS_PER_SESSION };
