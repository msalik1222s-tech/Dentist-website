# 5-Minute Client Demo — Runbook

Local screen-share demo of Bright Smile Dental. Everything below runs on your
machine against an isolated demo diary. **Production and your real local
records are never touched.**

---

## Start it

```bash
npm run demo
```

To begin from an empty diary (do this before the client joins):

```bash
npm run demo -- --reset
```

| | |
|---|---|
| **Website** | http://localhost:5500/ |
| **Dashboard** | http://localhost:5500/admin |

Stop it with `Ctrl+C`. If port 5500 is busy: `DEMO_PORT=5501 npm run demo`.

**Check the startup banner names the AI provider:**

```
AI chat assistant: openai (gpt-4o-mini)
```

If it says `WARNING: OPENAI_API_KEY not set` instead, the assistant will not
answer — see [If the assistant goes quiet](#if-the-assistant-goes-quiet).

### Pre-flight (run once before the client joins)

```bash
npm run chat:check
```

Makes real calls to OpenAI and checks the answers against
`backend/data/clinic.json` and `services.json` — hours, the dentist's name, the
whitening price — then books an appointment through the assistant, confirms the
reference reached the diary, and cancels it again. Takes about 30 seconds and
costs a fraction of a cent. **If this passes, the assistant is genuinely
working**; it is not a mock.

## Your demo login

The demo admin key is generated on first run into **`.env.demo`** in the
project root. It is git-ignored and never printed to the terminal.

Read it privately, just before you present:

```bash
grep ADMIN_KEY .env.demo
```

Copy the value after `ADMIN_KEY=` and paste it into the dashboard's key box.

**To rotate it,** delete `.env.demo` and run `npm run demo` again — a new key is
generated. Do this if the key is ever shown on a shared screen.

This key unlocks only the demo diary on this machine. It is not the clinic's
admin key and gives no access to the live site.

## What the sandbox guarantees

`scripts/demo.js` pins four things before the app loads:

| | |
|---|---|
| **Diary** | `demo/appointments.demo.json` — git-ignored, isolated |
| **Real local records** | `backend/data/appointments.json` — not opened |
| **Production database** | `DATABASE_URL` blanked, so it cannot be reached |
| **Email / notifications** | SMTP blanked — nothing can leave the machine |

The startup banner restates all four. **Leave the terminal visible** — it is
your proof to the client that nothing live is being touched.

---

## The script (≈5 minutes)

Have two browser tabs open beforehand: the website and the dashboard. Look up
the demo key before you start.

### 0:00 — The website *(30s)*

Open http://localhost:5500/. Scroll the homepage.

> "This is the clinic's site — services, the team, opening hours, and a booking
> form. It's live on Vercel; today I'm running it locally so you can see the
> back office too."

### 0:30 — Book as a patient *(1m)*

Scroll to **Book your appointment**. Fill it in while narrating:

- **Full name:** `Sara Demo (DEMO BOOKING)`
- **Phone:** `+000000000111`
- **Preferred date:** pick a weekday a week or two out
- **Preferred time:** *pause here* —

> "These times aren't a fixed list. The page just asked the server which slots
> are genuinely free that day — anything already booked simply isn't offered."

- **Service:** Teeth whitening
- **Note:** `Demo booking — not a real patient`

Press **Request appointment**.

> "The patient gets a booking reference straight away — that's what they quote
> on the phone."

**Read the reference aloud and write it down.** You need it in a moment.

> ⚠️ Use a name whose *first word* is a normal first name. The confirmation
> greets the patient by it — `Sara Demo (DEMO BOOKING)` reads "Thanks Sara!",
> whereas `DEMO PATIENT — Sara` reads "Thanks DEMO!".

### 1:30 — Open the back office *(45s)*

Switch to http://localhost:5500/admin.

> "This is what reception sees. It's password-protected and hidden from Google."

Paste the demo key, press **Load**.

Point at the row — same reference, name, phone, service, date, time.

> "The booking the patient just made is already here. Note the phone number —
> that's how reception calls them back."

Point at the filter buttons.

> "Reception starts the day on **Pending** — that's the call-back list. It came
> in as Pending because a human still has to agree the time."

### 2:15 — Confirm *(45s)*

Press **Confirm**, click OK.

> "One click. The status flips to Confirmed and the counters update. Behind
> that, it's saved to the database — it survives a restart or a redeploy."

### 3:00 — Reschedule *(1m)*

Press **Reschedule**.

> "Patient calls, wants a different time."

Point at the time dropdown *before* choosing.

> "Again — only genuinely free times. The system won't let reception
> double-book the chair. If someone grabs that slot while this box is open, it
> refuses and offers a fresh list."

Pick a new time, press **Save**. The row updates and the old slot is released.

### 3:45 — The AI assistant *(1m)*

Open the website tab and click the chat bubble, bottom left.

Ask, one at a time:

> "What are your opening hours?"
> "How much is teeth whitening?"

> "It's answering from the clinic's own data — the hours and the price list
> you'd give me. It isn't guessing, and it can't invent a service you don't
> offer."

Then book through it:

> "Book me in. Name: Omar Demo. Phone: +000000000222. Teeth whitening.
> Tomorrow at 3pm."

It checks the diary, books a genuinely free slot, and reads back a reference.

> "That booking is now in the same list reception works from — whether it came
> from the form or the assistant, it lands in one place."

Switch to the dashboard, press **Refresh**, and point at the new row.

> **Confirm the form booking, not this one.** A booking the assistant makes
> arrives **already Confirmed** — it checked the diary and took a genuinely
> free slot, so there is nothing for reception to agree. The row therefore
> offers only **Reschedule** and **Cancel**. Demonstrate **Confirm** on the
> Pending row from the website form earlier in the script; that is the one
> that needs a human.

> ⚠️ **Give the assistant a plain name** — `Omar Demo`, not
> `DEMO PATIENT — Omar Demo (not a real patient)`. From a decorated name the
> model picks whichever fragment it judges to be the name, and the choice is
> not stable between runs (observed as both `Omar Demo` and `DEMO PATIENT` for
> identical input). Put the demo label in the note instead — the note is stored
> word for word.

### 4:45 — Cancel and sign out *(45s)*

Press **Cancel**, click OK.

> "The record stays for the clinic's history, and the slot goes straight back
> into the pool for another patient."

Press **Sign out**.

> "Reception machines are shared, so this clears the key and wipes the patient
> list off the screen."

### 4:45 — Close

> "So: patient books online, reception sees it instantly, and confirms,
> moves or cancels in one click — with the diary protected from
> double-booking throughout."

---

## Working today vs. still to set up

Be straight with the client about the line between these.

**Working in this demo — the real system, not a mock**

- Public website and booking form
- Live availability lookup; double-booking prevented
- Booking references
- Password-protected dashboard, rejects wrong keys
- Confirm / reschedule / cancel, saved to the database
- Status filters with counts, refresh, sign out
- Bookings survive restarts and redeployments
- **AI assistant** — real OpenAI `gpt-4o-mini`, answering from the clinic's own
  data, booking into the same diary, declining services the clinic doesn't offer

**Production setup still required**

- **Live database + admin key on Vercel** — not yet confirmed from here. Verify
  by booking once on the live site and loading it in the live dashboard.
- **AI assistant on the live site** — works locally, but the live deployment
  needs `OPENAI_API_KEY` in Vercel → Environment Variables (and a redeploy)
  before patients can use it there.
- **Booking alert emails — off.** Needs `SMTP_HOST` *and* `CLINIC_EMAIL`. Until
  then staff check the dashboard; nobody is notified automatically.
- **Service prices are demo figures** (`backend/data/services.json`) and the
  assistant quotes them as real. Confirm them with the client.
- **`TRUST_PROXY=1`** should be set on Vercel.

### Do not say

- ❌ "You'll get a WhatsApp when someone books." **No automatic WhatsApp,
  SMS or push notification exists.** The WhatsApp button only opens a chat for
  the *patient* to message the clinic by hand.
- ❌ "The assistant answers patient questions **on the live site**." It works
  locally; the key still has to be added in Vercel.
- ❌ Quoting prices as final. They come from `services.json`, which still holds
  demo figures.

### If the assistant goes quiet

The chat replies *"temporarily unavailable"* when the server cannot reach
OpenAI, and *"isn't set up yet"* when no key is configured. The real cause is
always printed in the terminal running `npm run demo`, e.g.:

```
OpenAI request failed [CHAT_AUTH_FAILED] model=gpt-4o-mini status=401 ...
```

| Code in the log | Meaning |
|---|---|
| `CHAT_NOT_CONFIGURED` | No key in `backend/.env` — run `node scripts/set-key.js` |
| `CHAT_AUTH_FAILED` | Key rejected — wrong or revoked |
| `CHAT_QUOTA_EXCEEDED` | Billing limit reached on the OpenAI account |
| `CHAT_UPSTREAM_ERROR` + `status=n/a` | Network can't reach `api.openai.com` — see TLS note below |

> **Antivirus and HTTPS.** This machine runs Avast, whose Web Shield inspects
> HTTPS by re-signing every certificate with its own root. Browsers trust that
> root because it is in the Windows certificate store; Node does not read that
> store by default, so it rejected every outbound call with
> `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, which the SDK reported as a bare
> "Connection error". `backend/system-ca.js` now loads the system store at
> startup, and the banner says so:
>
> ```
> TLS: trusting 256 additional certificate(s) from the system store.
> ```
>
> If that line is missing and chat fails, the antivirus root is not being
> picked up. The same applies to Kaspersky, ESET and corporate proxies. This
> runs only locally — the Vercel function is untouched.

`npm run chat:check` tells you which of these you have in about 30 seconds.

> **Note on `.env` and worktrees.** `backend/.env` is git-ignored, so it does
> **not** travel into a git worktree. A worktree gets whatever placeholder
> `.env` was made for it, which is why a key that plainly exists in the main
> folder can look "missing" to a demo running from a worktree. Check you are
> reading the `.env` next to the code you are actually running.

---

## After the demo

```bash
npm run demo -- --reset
```

Clears the demo diary. Delete `.env.demo` too if the key was on screen.

Nothing needs undoing: no demo run ever writes to `backend/data/appointments.json`,
the production database, or any mailbox.
