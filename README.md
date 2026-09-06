# Bright Smile Dental Clinic — Website

A static marketing site for Bright Smile Dental Clinic with a small Express API for appointment requests and an AI chat assistant. It runs as one Node process locally and deploys to Vercel as static files plus a single serverless function.

## Project structure

```
public/                 Everything served publicly — nothing else is web-reachable
  index.html            Main site (all HTML/CSS/JS in one file)
  admin.html            Key-protected view of submitted appointment requests
  img/                  Site images (Pexels, free-license)

api/
  index.js              Vercel serverless entry point (wraps the Express app)

backend/
  app.js                Express app factory — API routes, validation, rate limiting
  server.js             Local dev entry point (serves public/ + the API on one port)
  chat.js               Claude tool-use loop for the AI chat assistant
  store.js              Appointment/slot/service logic
  db.js                 Storage driver — Postgres, or a JSON file for local dev
  mailer.js             Email notifications to the clinic
  .env.example          Copy to .env and fill in your own values
  data/
    clinic.json         Clinic profile (name, dentist, hours, contact)
    services.json       Services + official prices
    system-prompt.txt   Master system prompt for the AI assistant
    appointments.json   Local-only appointment records (gitignored)

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
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | for email | Leave `SMTP_HOST` empty to disable email |
| `CLINIC_EMAIL`, `FROM_EMAIL` | for email | Where notifications go, and who they come from |

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

### AI chat assistant (optional)

A floating chat widget lets patients ask about services, prices, hours, and book/reschedule/cancel appointments in English, Arabic or Urdu. It's powered by the Claude API and only ever answers from `backend/data/clinic.json` and `backend/data/services.json`, and checks/updates real slots in the database — it never invents prices or availability.

To enable it:

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/)
2. Set `ANTHROPIC_API_KEY` (in `backend/.env` locally, or Vercel's environment variables)
3. Restart / redeploy

Without a key, the widget shows a friendly "not set up yet" message instead of failing silently.

To change the clinic's dentist, hours, contact info, services or prices, edit `backend/data/clinic.json` and `backend/data/services.json` — the chat assistant and the website should be kept in sync manually.

### Rate limiting

`/api/appointments` (5 per 10 min), `/api/chat` (15 per min) and `/api/availability` (30 per min) are rate limited per IP. The counters live in the database, so the limits hold across serverless instances rather than resetting whenever a new one starts.

## Notes

- `backend/.env` and `backend/data/appointments.json` are gitignored — they hold secrets and live patient data and should never be committed.
- Only `public/` is web-reachable. Backend source and `backend/data/*` are bundled into the function but are not downloadable.
- The JSON file store is for local development only. It will silently lose data on Vercel, which is why `DATABASE_URL` is required there.
- The data model suits a single-location clinic. It isn't meant to scale to a multi-location system with per-dentist calendars.
