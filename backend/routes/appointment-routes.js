// The website's appointment form and slot picker.
//
//   GET  /api/availability?date=YYYY-MM-DD
//   POST /api/appointments
//
// Shares one 30-minute slot calendar with the AI assistant, so a time booked
// through the form cannot be double-booked through chat, or the other way
// round. The database's partial unique index is what finally decides a race.

const express = require("express");

const store = require("../store");
const mailer = require("../mailer");
const { limiter } = require("./middleware");

function validate(body) {
  const errors = [];
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const date = String(body.date || "").trim();
  const time = String(body.time || "").trim();
  const service = String(body.service || "").trim();
  const message = String(body.message || "").trim();

  if (!name || name.length > 100) errors.push("Please provide a valid name.");
  if (!phone || phone.replace(/[^0-9+]/g, "").length < 7 || phone.length > 30) {
    errors.push("Please provide a valid phone number.");
  }
  if (!date || !store.isValidDate(date)) {
    errors.push("Please provide a valid preferred date.");
  } else if (date < store.getClinicNow().dateStr) {
    errors.push("Preferred date can't be in the past.");
  }
  if (!time || !store.isValidTime(time)) errors.push("Please choose an available appointment time.");
  if (service.length > 100) errors.push("Service value is too long.");
  if (message.length > 1000) errors.push("Message is too long (max 1000 characters).");

  return { errors, clean: { name, phone, date, time, service, message } };
}

function createAppointmentRouter() {
  const router = express.Router();

  router.get("/availability", limiter("availability"), async (req, res, next) => {
    try {
      const date = String(req.query.date || "").trim();
      if (!store.isValidDate(date)) {
        return res.status(400).json({ ok: false, error: "Please provide a valid date (YYYY-MM-DD)." });
      }
      res.json({ ok: true, date, slots: await store.getAvailableSlots(date) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/appointments", limiter("appointments"), async (req, res, next) => {
    const { errors, clean } = validate(req.body || {});
    if (errors.length) return res.status(400).json({ ok: false, error: errors[0] });

    let entry;
    try {
      entry = await store.createAppointment({ ...clean, source: "form", status: "pending" });
    } catch (err) {
      if (err.code) return next(err); // a database failure, not a booking conflict
      return res.status(409).json({ ok: false, error: err.message });
    }

    try {
      await mailer.notifyNewAppointment(entry);
    } catch (err) {
      // The booking is already saved — a failed notification must not fail it.
      console.error("Email notification failed:", err.message);
    }

    res.status(201).json({
      ok: true,
      message: `Thanks ${clean.name.split(" ")[0]}! Your request is noted — we'll call you shortly to confirm.`,
    });
  });

  return router;
}

module.exports = { createAppointmentRouter, validate };
