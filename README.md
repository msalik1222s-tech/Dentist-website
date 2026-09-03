# Bright Smile Dental Clinic — Website

A static marketing site for Bright Smile Dental Clinic with a small Express backend for appointment requests and an AI chat assistant.

## Project structure

```
index.html            Main site (all HTML/CSS/JS in one file)
admin.html             Password-protected view of submitted appointment requests
img/                    Site images (Pexels, free-license)
serve.cjs               Legacy static file server (superseded by backend/, unused)

backend/
  server.js             Express app — serves the site + API routes
  chat.js                Claude tool-use loop for the AI chat assistant
  store.js               Appointment/slot/service data helpers
  package.json
  .env.example           Copy to .env and fill in your own values
  data/
    clinic.json           Clinic profile (name, dentist, hours, contact)
    services.json          Services + official prices
    system-prompt.txt      Master system prompt for the AI assistant
    appointments.json      Appointment records (created at runtime, gitignored)
```

## Requirements

- Node.js 18+

## Setup

```bash
cd backend
npm install
copy .env.example .env      # (or `cp .env.example .env` on macOS/Linux)
```

Edit `backend/.env` and set at least:

- `ADMIN_KEY` — any long random string, required to view submitted requests at `/admin.html`

Then start the server:

```bash
npm start
```

The site is served at `http://localhost:5500` (or whatever `PORT` you set).

## Features

### Appointment request form

The form on the homepage posts to `POST /api/appointments` and saves requests to `backend/data/appointments.json`. View submissions at `/admin.html` using your `ADMIN_KEY`.

### Email notifications (optional)

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `CLINIC_EMAIL` and `FROM_EMAIL` in `.env` to email the clinic whenever a new request comes in. Leave `SMTP_HOST` empty to skip this — requests are still saved either way.

### AI chat assistant (optional)

A floating chat widget lets patients ask about services, prices, hours, and book/reschedule/cancel appointments in English, Arabic or Urdu. It's powered by the Claude API and only ever answers from `backend/data/clinic.json` and `backend/data/services.json`, and checks/updates real slots in `appointments.json` — it never invents prices or availability.

To enable it:

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/)
2. Set `ANTHROPIC_API_KEY` in `backend/.env`
3. Restart the server

Without a key, the widget shows a friendly "not set up yet" message instead of failing silently.

To change the clinic's dentist, hours, contact info, services or prices, edit `backend/data/clinic.json` and `backend/data/services.json` — the chat assistant and the website should be kept in sync manually.

## Notes

- `backend/.env` and `backend/data/appointments.json` are gitignored — they hold secrets and live patient data and should never be committed.
- There is no database; appointments are stored in a JSON file. This is fine for a small clinic's volume but isn't meant to scale to a multi-location system.
