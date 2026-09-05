// Public read-only catalogue.
//
// The same live rows the AI agent reads, exposed so the website can render
// services, dentists and FAQs from the database instead of a second, drifting
// copy hard-coded in the HTML. Nothing here is patient data.

const express = require("express");

const catalog = require("../persistence/catalog-store");
const store = require("../store");
const { limiter } = require("./middleware");

function createCatalogRouter() {
  const router = express.Router();

  router.get("/clinic", limiter("catalog"), (req, res) => {
    const clinic = store.getClinicInfo();
    res.json({
      ok: true,
      clinic: {
        name: clinic.name,
        hours: clinic.hoursLabel,
        phone: clinic.phone,
        email: clinic.email,
        address: clinic.address,
        currency: clinic.currency,
      },
    });
  });

  router.get("/services", limiter("catalog"), async (req, res, next) => {
    try {
      const services = await catalog.getServices();
      res.json({
        ok: true,
        // keywords drive the agent's recommendations and are not meant for
        // patients, so they are dropped here.
        services: services.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          priceLabel: s.priceLabel,
          startingPrice: s.startingPrice,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/doctors", limiter("catalog"), async (req, res, next) => {
    try {
      res.json({ ok: true, doctors: await catalog.getDoctors() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/faqs", limiter("catalog"), async (req, res, next) => {
    try {
      const faqs = await catalog.getFaqs();
      res.json({ ok: true, faqs: faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer })) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createCatalogRouter };
