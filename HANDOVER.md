# Bright Smile Dental Clinic — Handover

Two audiences. **Part 1** is for the dentist and reception staff. **Part 2** is
for whoever administers the hosting account.

> **Status: not yet cleared for clinic use.** Everything in this document is
> verified locally, but two live settings could not be checked from here — see
> [Before the clinic relies on this](#before-the-clinic-relies-on-this). Work
> through that section first.

---

## Part 1 — For the clinic

### Getting into the dashboard

**Address:** https://dentist-website-seven-psi.vercel.app/admin

1. Open that address in any browser (phone, tablet or desktop).
2. Type the **admin key** into the box. The practice owner holds this key —
   it is not written down anywhere on the website.
3. Press **Load**.

The appointment list appears. The browser remembers the key until the tab is
closed, so you only type it once per shift.

When you walk away from a shared reception computer, press **Sign out**. That
forgets the key and clears the patient list off the screen.

> The page is set to `noindex`, so it will not appear in Google. It is still
> reachable by anyone who knows the address, so **the admin key is the only
> thing protecting patient details. Treat it like the safe combination.**

### Reading the list

Every booking is one row:

| Column | What it is |
|---|---|
| **Reference** | The 6-character code the patient was given, e.g. `K7M2PQ`. The date and time the request came in sits underneath it. |
| **Patient** | Their name. Any note they typed appears underneath in grey. |
| **Phone** | Call this number to confirm the appointment. |
| **Service** | What they asked for. |
| **Date** / **Time** | When they want to come in. |
| **Status** | `Pending`, `Confirmed` or `Cancelled`. |
| **Actions** | The buttons described below. |

Always ask a patient for their **reference** on the phone. It is how you find
their booking without hunting through the list.

### The three statuses

- **Pending** — a new request from the website form. Nobody has spoken to the
  patient yet. **These are your to-do list.**
- **Confirmed** — the clinic has agreed the appointment. Bookings made through
  the AI chat assistant arrive already confirmed, because the assistant checks
  the diary and books a genuinely free slot.
- **Cancelled** — no longer happening. The row stays as a record, and the time
  slot is free for someone else.

The four buttons at the top (**All / Pending / Confirmed / Cancelled**) filter
the list, and each shows a count. **Start every shift on `Pending`.**

### The daily routine

1. Open the dashboard and click **Pending**.
2. For each row, phone the patient on the number shown.
3. Press the button that matches what you agreed:

   - **Confirm** — the appointment is going ahead. Status becomes `Confirmed`.
   - **Reschedule** — they want a different time. A box opens showing only the
     times that are genuinely free that day; pick a date and a time and press
     **Save**. The old slot is released automatically.
   - **Cancel** — they are not coming. The slot is freed for another patient.

4. Press **Refresh** now and then to pick up bookings that came in while you
   had the page open.

Each button asks you to confirm before it does anything, and the line under the
toolbar reports what happened.

### Things that will happen, and what they mean

- **"No change — it was already in that state."** Someone already did it, or
  you double-clicked. Nothing is wrong.
- **"That slot is already booked."** While you had the page open, somebody took
  that time. The box stays open with a refreshed list of free times — pick
  another.
- **"Admin key rejected."** The key is wrong or has been changed. Ask the
  practice owner.
- **"Too many admin requests."** The dashboard limits how fast it can be
  clicked. Wait a minute and press **Refresh**.
- **A row named "TEST — ..." with a phone number of `+000000000...`** That is
  test data, not a patient. Cancel it and ignore it.

### What the clinic is NOT told automatically

**Nobody is texted or messaged when a booking comes in.** You have to open the
dashboard to see new bookings.

- **Email** — the clinic *can* be emailed on every booking, but only once the
  mail settings are filled in (Part 2). Until then, no email is sent.
- **SMS** — not built. There is no SMS integration in this system at all.
- **WhatsApp** — the "WhatsApp Us" button on the website only opens a chat for
  the *patient* to message you manually. **It does not notify you of bookings.**

So until email is switched on, **check the dashboard at the start of every
day.**

---

## Part 2 — For whoever runs the hosting

### Configuration variables

Set these in **Vercel → your project → Settings → Environment Variables**, then
**redeploy** — Vercel only picks up changes on a new deployment.

Never put any of these in the code, in `public/`, or in a git commit.

#### Required

| Name | Purpose |
|---|---|
| `ADMIN_KEY` | The key staff type into the dashboard. **If unset, the dashboard is locked out for everyone** — the server rejects every key, including the right one. Use a long random string. |
| `DATABASE_URL` | Postgres connection string (Neon, Supabase, Railway — any will do). **Required on Vercel**, whose filesystem is read-only: without it, no booking can be saved at all. Tables are created automatically on first request. |

#### Strongly recommended

| Name | Purpose |
|---|---|
| `TRUST_PROXY` | Set to `1` on Vercel. See [the rate-limiting note](#rate-limits-behind-vercels-proxy) below. |

#### Email notifications — all-or-nothing

`SMTP_HOST` and `CLINIC_EMAIL` must **both** be set or no mail is sent at all.
Bookings are still saved either way; the clinic just is not told.

| Name | Purpose |
|---|---|
| `SMTP_HOST` | Mail server, e.g. `smtp.gmail.com`. |
| `SMTP_PORT` | `587` (or `465` for implicit TLS). |
| `SMTP_USER` | Mailbox the mail is sent *from*. |
| `SMTP_PASS` | For Gmail this must be a 16-character **App Password**, not the account password. App Passwords require 2-Step Verification. |
| `CLINIC_EMAIL` | **The address the clinic actually reads.** This is the recipient — the one setting that decides where booking alerts land. |
| `FROM_EMAIL` | The "from" address. Most providers require it to match `SMTP_USER`. |

#### AI chat assistant — optional

| Name | Purpose |
|---|---|
| `OPENAI_API_KEY` | Enables the assistant. Leave empty to disable the chat widget. |
| `ANTHROPIC_API_KEY` | Alternative provider. |
| `CHAT_PROVIDER` | `openai` or `anthropic`, when both keys are set. |
| `OPENAI_MODEL` / `ANTHROPIC_MODEL` | Model overrides. |
| `OPENAI_BASE_URL` | For an Azure/gateway/proxy endpoint. |

### Setting or rotating the admin key privately

Generate a key — it is never typed by hand and never shared over chat or email:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

**Local development** — put it in `backend/.env` (already git-ignored; copy
`backend/.env.example` to start):

```
ADMIN_KEY=<paste the generated value>
```

**Vercel** — either paste it into Settings → Environment Variables → `ADMIN_KEY`
(select Production, Preview and Development), or:

```bash
vercel env add ADMIN_KEY production
```

That command prompts for the value on a hidden stdin, so the key never reaches
your shell history. Then redeploy.

**To rotate:** replace the value, redeploy, and tell staff the new key. Anyone
still holding the old key is locked out immediately — they see "Admin key
rejected" and the browser discards the stored key on its own.

**Never** commit it, paste it into a chat or ticket, or put it in a URL. The
server accepts the key **only** as an `x-admin-key` request header, precisely
so it cannot leak through access logs, browser history or `Referer` headers.

### Checking the database

```bash
npm run db:check
```

Run it after provisioning the database and after any change to `DATABASE_URL`.
It connects, creates the schema, and runs a full round trip — book, reject a
double-booking, patient lookup, staff confirm, staff reschedule, staff cancel,
slot freed, final state re-read from storage. It leaves one **cancelled** test
booking behind, which holds no slot; the line it prints tells you the reference
so staff can recognise it.

To check the *live* database rather than the local file, run it with the
production connection string in `backend/.env`.

### Storage durability

Bookings live in Postgres and survive restarts and redeployments — Vercel
functions are short-lived and stateless, and nothing about an appointment is
kept in the function's memory.

**If `DATABASE_URL` is missing on Vercel, the system does not degrade quietly —
it fails:** the code refuses to fall back to file storage there, because
Vercel's disk is read-only and every booking would be silently lost. You get a
`FATAL CONFIG` line in the runtime logs and bookings return an error. The JSON
file in `backend/data/` is for local development only.

### Rate limits behind Vercel's proxy

`TRUST_PROXY` is currently unset, which means the app **ignores**
`X-Forwarded-For` and identifies clients by the network socket address. That is
the correct, safe default for a server facing the internet directly — it stops
anyone resetting their own rate limit by inventing a header value.

Behind Vercel's proxy, though, the socket address is Vercel's infrastructure
rather than the patient's. If that address is shared across visitors, the
per-client limits become effectively site-wide:

| Bucket | Limit | If shared site-wide |
|---|---|---|
| Bookings | 5 per 10 min | Only 5 bookings site-wide per 10 minutes |
| Chat | 15 per min | Assistant stops responding under light load |
| Admin | 20 per 10 min | Staff locked out by patients' traffic |

**Setting `TRUST_PROXY=1` on Vercel makes `req.ip` the real client address and
the limits per-patient again.** This has not been measured against the live
deployment — it is read off the code — so confirm it before or just after
changing it.

---

## Before the clinic relies on this

Two things could not be verified from the development machine, and both are
blocking:

1. **Is `DATABASE_URL` set on Vercel?** Verifying it needs one real write to the
   production database, which was deliberately not done. **Check:** open the
   live site, book an appointment through the form, and confirm it appears in
   the dashboard. If the booking fails, `DATABASE_URL` is missing or wrong.
2. **Is `ADMIN_KEY` set on Vercel?** **Check:** open `/admin` and load the list
   with the real key. If a key you know is right is rejected, `ADMIN_KEY` is not
   set on the deployment.

Then, in order:

3. Set `TRUST_PROXY=1` (see above).
4. Decide on booking alerts. Until `SMTP_HOST` and `CLINIC_EMAIL` are both set,
   **the clinic is told nothing automatically** and staff must check the
   dashboard daily. Send a test booking afterwards and confirm the mail arrives.
5. Confirm the service prices. The figures in `backend/data/services.json` are
   **demo values**, and the AI assistant quotes them to patients as the clinic's
   own prices. See `backend/data/PRICING-NOTE.md`.
6. Have a receptionist run one booking end to end — book on the website, find it
   in the dashboard, confirm it, reschedule it, cancel it.

## Running the tests

```bash
npm run test:handover     # website + AI booking -> dashboard -> staff actions -> restart
npm run test:admin        # the admin route is guarded
npm run test:admin-write  # confirm / reschedule / cancel behaviour
npm run test:admin-ui     # the dashboard page itself
npm run db:check          # the configured database, end to end
```

All of them use clearly-marked test data, back up and restore the local data
file, send no mail, and never print the key they are testing with.
