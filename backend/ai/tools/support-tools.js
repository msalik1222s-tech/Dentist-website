// Escalation to a human.
//
// The agent's most important capability is knowing when to stop. This records
// a handoff request the clinic can act on, emails the team, and marks the
// session so the transcript is easy to find in the admin view.

const store = require("../../store");
const mailer = require("../../mailer");
const chatStore = require("../../persistence/chat-store");
const config = require("../config");

const REASONS = ["patient_asked", "complaint", "clinical_question", "policy_exception", "system_problem", "other"];

const tools = [
  {
    name: "request_human_handoff",
    description:
      "Hand the conversation to a member of the clinic team. Call this when the patient asks for a human, makes a complaint, asks for an exception to clinic policy, needs a clinical judgement only a dentist can make, or when a booking or lookup keeps failing. Tell the patient you are doing it, and give them the clinic's phone number as well.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why the conversation needs a person.",
          enum: REASONS,
        },
        summary: {
          type: "string",
          description:
            "A short, factual summary of what the patient needs, written for the staff member who will pick this up.",
          maxLength: 800,
        },
        patient_name: { type: "string", description: "The patient's name, if they gave one.", maxLength: 100 },
        patient_phone: {
          type: "string",
          description: "A number the clinic can call back on, if the patient gave one.",
          maxLength: 30,
        },
      },
      required: ["reason", "summary"],
    },
    async handler(input, ctx) {
      const clinic = store.getClinicInfo();

      const handoff = await chatStore.createHandoff({
        sessionId: ctx.sessionId,
        channel: ctx.channel,
        reason: input.reason,
        summary: input.summary,
        patientName: input.patient_name || ctx.facts.patientName || null,
        patientPhone: input.patient_phone || ctx.facts.patientPhone || null,
      });

      // The session is flagged rather than closed: the patient can keep asking
      // ordinary questions while they wait for the callback.
      await chatStore.updateSession(ctx.sessionId, { status: "handoff" });

      try {
        await mailer.notifyHandoff(handoff);
      } catch (err) {
        console.error("Handoff email failed:", err.message);
      }

      return {
        success: true,
        reference: handoff.id,
        clinicPhone: clinic.phone,
        clinicEmail: clinic.email,
        whatsapp: config.whatsapp.contactNumber || null,
        openingHours: clinic.hoursLabel,
        note:
          "Tell the patient a team member will follow up, give them the clinic phone number so they can call straight away if it is urgent, and keep helping with anything else you can.",
      };
    },
  },
];

module.exports = { tools, REASONS };
