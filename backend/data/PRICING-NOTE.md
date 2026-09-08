# Pricing in `services.json` is demo pricing

Every `startingPrice` and `priceLabel` in `services.json` is a **sample figure
written for the demo build**. None has been confirmed by the clinic.

They are not cosmetic placeholders. They are used in two visible places:

- the price line on each service card of the homepage (`From SAR 150`, …)
- the AI assistant's system prompt, where they are labelled *official prices* —
  the assistant quotes them to patients on request

**Before the site is made public**, have the client confirm or replace each
figure. Change them in `services.json` only; nothing else needs editing.

Currency is set separately, in `clinic.json` (`"currency": "SAR"`).
