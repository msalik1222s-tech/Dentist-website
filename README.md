# Bright Smile Dental Clinic — Website

A static marketing site for Bright Smile Dental Clinic, an Express API for appointment requests, and the **Dental Care Assistant** — an AI receptionist that answers from the clinic's live data and books real appointments, on the website and on WhatsApp. It runs as one Node process locally and deploys to Vercel as static files plus a single serverless function.

The AI agent has its own guide: **[docs/ai-agent.md](docs/ai-agent.md)** — architecture, guardrails, memory, swapping the LLM, and WhatsApp setup.

## Project structure

```
public/                 Everything served publicly — nothing else is web-reachable
  index.html            Main site (all HTML/CSS/JS in one file)
  admin.html            Key-protected view of appointment requests and chat handoffs
  img/                  Site images (Pexels, free-license)

api/
  index.js              Vercel serverless entry point (wraps the Express app)

backend/
  app.js                Composition root — wires the routers together
  server.js             Local dev entry point (serves public/ + the API on one port)
  pg.js                 One shared Postgres pool for every module
  db.js                 Appointments + rate limiting (Postgres, or a JSON file locally)
  store.js              Appointment/slot/service logic
  mailer.js             Email notifications to the clinic
  .env.example          Copy to .env and fill in your own values

  persistence/          Catalogue and conversation storage
  routes/               One router per area (appointments, chat, catalogue, admin, WhatsApp)
  ai/                   The Dental Care Assistant — see docs/ai-agent.md
    agent.js              Orchestration loop
    providers/            Swappable LLM adapters (Anthropic, OpenAI, Google, mock)
    prompt/               System prompt assembly + live clinic context
    tools/                What the agent can actually do
    memory/               Session memory, replay window, rolling summary
    guardrails/           Input screening and output safety checks
    channels/whatsapp/    Webhook verification, parsing, sending

  data/
    clinic.json         Clinic profile (name, hours, contact, slot length)
    services.json       Services, prices and recommendation keywords (seed)
    doctors.json        Dentists and their specialties (seed)
    faqs.json           Frequently asked questions (seed)
    system-prompt.txt   Master system prompt for the AI assistant
    appointments.json   Local-only appointment records (gitignored)
    chat-history.json   Local-only conversation records (gitignored)

tests/                  node --test — no API key or database needed
docs/
  ai-agent.md           AI agent architecture, guardrails and operations

scripts/
  db-check.js           One-command health check for DATABASE_URL

vercel.json             Static output + /api/* rewrite + function settings
serve.cjs               Legacy static file server (superseded by backend/, unused)
```

## Requirements

- Node.js 18+

## Local setup

```bash
npm install
```

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and set at least:

- `ADMIN_KEY` — any long random string, required to view submitted requests at `/admin.html`

Then start the server:

```bash
npm start
```

The site is served at `http://localhost:5500` (or whatever `PORT` you set). With no `DATABASE_URL`, appointments are stored in `backend/data/appointments.json`, which is fine for development.

## Deploying to Vercel

The repo is already shaped for Vercel: `public/` is the static output, and every `/api/*` request is rewritten onto the single function in `api/index.js`. No build step runs.

### 1. Create a database

Vercel's filesystem is read-only and each request may hit a fresh instance, so appointments **cannot** be kept in a JSON file there — the site needs Postgres. Any provider works (Neon, Supabase, Railway); the Vercel Marketplace's Neon integration is the shortest path and sets `DATABASE_URL` for you.

Tables and indexes are created automatically on the first request — there is no migration step.

### 2. Import the repo

In Vercel: **Add New → Project → Import** this GitHub repository. Leave the framework preset as **Other** and don't set a build command; `vercel.json` supplies the rest.

### 3. Set environment variables

In **Project Settings → Environment Variables**, for Production *and* Preview:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (set automatically by the Neon integration) |
| `ADMIN_KEY` | yes | Long random string; without it `/admin.html` stays locked out |
| `ANTHROPIC_API_KEY` | for chat | From [console.anthropic.com](https://console.anthropic.com/) |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-sonnet-5` |
| `AI_PROVIDER` | no | `anthropic` (default), `openai` or `google`. Leave empty to use whichever key is set |
| `OPENAI_API_KEY` / `GOOGLE_API_KEY` | for those providers | Alternatives to Anthropic |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | for email | Leave `SMTP_HOST` empty to disable email |
| `CLINIC_EMAIL`, `FROM_EMAIL` | for email | Where notifications go, and who they come from |
| `WHATSAPP_*` | for WhatsApp | See [docs/ai-agent.md](docs/ai-agent.md#8-whatsapp-setup) |

`backend/.env.example` lists every variable, including the optional tuning for
generation, memory and guardrails.

Redeploy after adding variables — they are baked in at deploy time.

### 4. Verify the database

With the same `DATABASE_URL` in your local `backend/.env`:

```bash
npm run db:check
```

This connects, creates the schema, and runs a full booking round trip (book → double-book rejected → reschedule → cancel → slot freed). Run it after provisioning the database and any time `DATABASE_URL` changes, so a bad connection string shows up here instead of as a 500 on the live site.

## Features

### Appointment request form

The form on the homepage lets patients pick a date and then a real open time slot (fetched live from `GET /api/availability?date=YYYY-MM-DD`), and posts to `POST /api/appointments`. This shares the same 30-minute slot calendar as the AI assistant, so a time booked through the form is blocked from being double-booked through chat, and vice versa. View submitted requests at `/admin.html` using your `ADMIN_KEY`.

Double-booking is prevented by a partial unique index on `(date, time)` in the database, not just by an application check — two patients booking the same slot at the same moment on different serverless instances cannot both win.

### Email notifications (optional)

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `CLINIC_EMAIL` and `FROM_EMAIL` to email the clinic whenever a new request comes in. Leave `SMTP_HOST` empty to skip this — requests are still saved either way.

### Dental Care Assistant (optional)

A floating chat widget lets patients ask about the clinic's dentists, services, prices and opening hours, get a service suggested for what they describe, and book, reschedule or cancel appointments — in English, Arabic or Urdu. The same assistant answers on WhatsApp when that channel is configured.

Everything it says about the clinic comes back from a tool call against the live database first: it never invents a price, a dentist, a policy or a free slot. It cannot diagnose, prescribe or discount, and it hands the conversation to the clinic team when it should not be answering. Full detail — architecture, guardrails, memory, and how to swap the LLM — is in **[docs/ai-agent.md](docs/ai-agent.md)**.

To enable it:

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/) (or use OpenAI/Google — see `AI_PROVIDER`)
2. Set `ANTHROPIC_API_KEY` (in `backend/.env` locally, or Vercel's environment variables)
3. Restart / redeploy

Without a key, the widget shows a friendly "not set up yet" message instead of failing silently.

**Changing what it knows.** Clinic name, hours and contact live in `backend/data/clinic.json`. Services, dentists and FAQs are database tables, seeded once from `backend/data/services.json`, `doctors.json` and `faqs.json` — so in production you change a price with an `UPDATE` and it is live within a minute, with no redeploy and nothing to keep in sync by hand. The persona and rules live in `backend/data/system-prompt.txt`.

**Handoffs.** When the assistant escalates — a complaint, a request for a person, anything clinical — the clinic gets an email and the conversation appears on `/admin.html` with a **Done** button.

### Tests

```bash
npm test
```

Covers the agent loop, tools, memory, both guardrails and the WhatsApp webhook, against a scripted provider and a temporary data directory — no API key, no database, no network.

### Rate limiting

`/api/appointments` (5 per 10 min), `/api/chat` (15 per min) and `/api/availability` (30 per min) are rate limited per IP. The counters live in the database, so the limits hold across serverless instances rather than resetting whenever a new one starts.

## Notes

- `backend/.env`, `backend/data/appointments.json` and `backend/data/chat-history.json` are gitignored — they hold secrets and live patient data and should never be committed.
- Only `public/` is web-reachable. Backend source and `backend/data/*` are bundled into the function but are not downloadable.
- The JSON file store is for local development only. It will silently lose data on Vercel, which is why `DATABASE_URL` is required there.
- A chat session id is a bearer credential: whoever holds one can read that conversation back. It is 24 random bytes and is never logged in full. See [docs/ai-agent.md](docs/ai-agent.md#5-memory) if you need something stronger.
- The data model suits a single-location clinic. Appointments are booked against one shared 30-minute calendar, not per dentist, so the assistant offers a slot at the clinic rather than with a named dentist. Adding per-dentist calendars means a `doctor_id` on `appointments` and on the slot query — the agent's tools would follow, but nothing else here assumes it.
