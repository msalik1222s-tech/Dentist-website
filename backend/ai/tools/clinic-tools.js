// Read-only tools over the clinic catalogue: profile, doctors, services,
// prices, FAQs, and service suggestions.
//
// Every one of these reads the live catalogue (backend/persistence/catalog-store)
// rather than anything baked into the prompt. That is what makes "never invent
// a price" enforceable instead of merely requested: a price the model states
// had to come back from here first.

const store = require("../../store");
const catalog = require("../../persistence/catalog-store");

// Trimmed to what a patient may see. Internal columns (sort_order, active)
// stay out of the model's context entirely.
function publicService(service) {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    price: service.priceLabel,
    startingPrice: service.startingPrice,
    appointmentLengthMinutes: service.durationMinutes || null,
  };
}

function publicDoctor(doctor) {
  return {
    name: doctor.name,
    title: doctor.title,
    specialties: doctor.specialties,
    qualifications: doctor.qualifications,
    experienceYears: doctor.experienceYears,
    languages: doctor.languages,
    about: doctor.bio,
  };
}

function normalise(text) {
  return String(text || "").toLowerCase();
}

// Word-overlap scoring. Deliberately dumb and deterministic: the ranking is a
// shortlist for the model to talk about, not an answer in itself.
//
// A multi-word keyword scores on a phrase match, and again — lower — when all
// of its words appear somewhere in the text. Patients write "my face is
// swollen", not "swollen face", and an exact-phrase-only match misses that.
function scoreKeywords(haystack, keywords) {
  const words = new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean));
  let score = 0;

  for (const keyword of keywords) {
    const k = normalise(keyword);
    if (!k) continue;

    if (haystack.includes(k)) {
      score += k.includes(" ") ? 3 : 2;
      continue;
    }
    const parts = k.split(/[^a-z0-9]+/).filter(Boolean);
    if (parts.length > 1 && parts.every((part) => words.has(part))) score += 2;
  }

  return score;
}

const tools = [
  {
    name: "get_clinic_info",
    description:
      "Get the clinic's name, address, phone, email, opening hours and timezone from the live clinic record. Use this for any question about where the clinic is, how to contact it, or when it is open.",
    parameters: { type: "object", properties: {} },
    async handler() {
      const clinic = store.getClinicInfo();
      return {
        name: clinic.name,
        openingHours: clinic.hoursLabel,
        phone: clinic.phone,
        email: clinic.email,
        address: clinic.address,
        currency: clinic.currency,
        appointmentLengthMinutes: clinic.slotMinutes,
      };
    },
  },

  {
    name: "get_doctors",
    description:
      "Get the clinic's dentists from the live database: names, titles, specialties, qualifications, years of experience and the languages they speak. Use this before naming or describing any dentist.",
    parameters: { type: "object", properties: {} },
    async handler() {
      return { doctors: (await catalog.getDoctors()).map(publicDoctor) };
    },
  },

  {
    name: "get_services",
    description:
      "Get every service the clinic offers with its official price, from the live pricing database. This is the only source of prices — use it before stating any price, and quote the price exactly as returned.",
    parameters: { type: "object", properties: {} },
    async handler() {
      const services = await catalog.getServices();
      return {
        currency: store.getClinicInfo().currency,
        services: services.map(publicService),
        note: "These are the official clinic prices. They cannot be discounted or negotiated.",
      };
    },
  },

  {
    name: "search_faqs",
    description:
      "Search the clinic's frequently asked questions for an answer to a policy or practical question — payment, insurance, children, first visits, cancellations, nervous patients and so on. Use this before saying you do not know.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the patient asked, in their own words.", maxLength: 300 },
      },
      required: ["query"],
    },
    async handler(input) {
      const faqs = await catalog.getFaqs();
      const query = normalise(input.query);
      const words = query.split(/[^a-z0-9]+/).filter((w) => w.length > 2);

      const ranked = faqs
        .map((faq) => {
          const haystack = normalise(faq.question + " " + faq.answer + " " + (faq.tags || []).join(" "));
          let score = scoreKeywords(query, faq.tags || []);
          for (const word of words) if (haystack.includes(word)) score += 1;
          return { faq, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      if (!ranked.length) {
        return {
          matches: [],
          note: "No FAQ covers this. Say you do not have that information and offer to put the patient in touch with the clinic team.",
        };
      }
      return { matches: ranked.map((r) => ({ question: r.faq.question, answer: r.faq.answer })) };
    },
  },

  {
    name: "recommend_services",
    description:
      "Given what a patient describes (a symptom, a concern, or a goal like whiter or straighter teeth), return the clinic services that are most likely relevant, with their official prices. This suggests what to book — it is NOT a diagnosis, and the result must always be presented as 'a dentist would need to examine you to say for sure'.",
    parameters: {
      type: "object",
      properties: {
        concern: {
          type: "string",
          description: "What the patient described, in their own words.",
          maxLength: 500,
        },
      },
      required: ["concern"],
    },
    async handler(input) {
      const services = await catalog.getServices();
      const concern = normalise(input.concern);

      const ranked = services
        .map((service) => {
          let score = scoreKeywords(concern, service.keywords || []);
          if (concern.includes(normalise(service.name))) score += 4;
          return { service, score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      // Urgency is judged separately from the keyword ranking. It is the one
      // thing here with a real cost if it is missed, so it must not depend on
      // a service having matched.
      const urgent = /(bleed|swell|swollen|knocked out|trauma|accident|unbearable|can.?t sleep|severe pain)/.test(
        concern
      );

      const urgentNote = urgent
        ? " The description sounds urgent: offer the soonest appointment, and if there is heavy bleeding, difficulty breathing or swallowing, or major facial swelling, tell the patient to seek emergency medical care immediately."
        : "";

      if (!ranked.length) {
        return {
          suggestions: [],
          urgent,
          note:
            "Nothing in the catalogue clearly matches. Suggest a general check-up so a dentist can look, and do not guess at a cause." +
            urgentNote,
        };
      }

      return {
        suggestions: ranked.map((r) => publicService(r.service)),
        urgent,
        note:
          "Present these as options a dentist may discuss, never as a diagnosis. Always add that an examination is needed to know for certain." +
          urgentNote,
      };
    },
  },
];

module.exports = { tools };
