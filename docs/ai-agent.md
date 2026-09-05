# Dental Care Assistant — architecture and operations

The AI receptionist behind the website chat widget and the clinic's WhatsApp
number. It answers questions from the clinic's live data, books, reschedules
and cancels real appointments, recommends services, and hands a conversation to
a person when it should not be answering.

It is provider-agnostic: Anthropic, OpenAI and Google adapters ship with it, and
switching between them is one environment variable.

---

## 1. Folder structure

```
backend/
  pg.js                     One shared Postgres pool for every module
  db.js                     Appointments + rate limiting (Postgres | JSON file)
  store.js                  Slot calendar and appointment rules
  mailer.js                 Email notifications to the clinic
  app.js                    Composition root — wires the routers together
  server.js                 Local dev entry point

  persistence/
    catalog-store.js        Services, doctors, FAQs — seeded from JSON, read from the database
    chat-store.js           Sessions, message history, handoffs, webhook de-duplication

  routes/
    middleware.js           Client IP, rate limiting, admin auth
    appointment-routes.js   /api/availability, /api/appointments
    chat-routes.js          /api/chat, /api/chat/config, /api/chat/:sessionId
    catalog-routes.js       /api/services, /api/doctors, /api/faqs, /api/clinic
    admin-routes.js         /api/admin/* (ADMIN_KEY)
    whatsapp-routes.js      /api/whatsapp/webhook

  ai/
    config.js               Every AI setting, read from the environment in one place
    errors.js               Typed errors carrying an HTTP status and a patient-safe message
    agent.js                The orchestration loop

    providers/              The seam that makes the LLM swappable
      index.js              Registry + the provider contract (documented in the file)
      http.js               Shared fetch with a hard deadline
      anthropic.js          Claude (official SDK)
      openai.js             OpenAI / any OpenAI-compatible gateway (REST)
      google.js             Gemini (REST)
      mock.js               Scripted provider — used by the tests, never selected implicitly

    prompt/
      persona.js            Assembles the system prompt for a turn
      context-builder.js    The live data block and the session-memory block

    tools/
      registry.js           One list of tools, one dispatch point
      validate.js           Minimal JSON Schema check for model-supplied arguments
      clinic-tools.js       Clinic info, doctors, services, FAQs, recommendations
      appointment-tools.js  Availability, booking, lookup, reschedule, cancel
      support-tools.js      Human handoff

    memory/
      memory-manager.js     Replay window, rolling summary, per-session facts

    guardrails/
      patterns.js           The pattern sets, separated so they can be reviewed
      input-guard.js        Screens patient messages before they reach a model
      output-guard.js       Screens replies before they reach a patient

    channels/whatsapp/
      index.js              Turns verified deliveries into agent turns
      webhook.js            Signature verification and payload parsing
      client.js             Sending (Meta Cloud API or Twilio)

  data/                     Seed data and the master prompt
    clinic.json  services.json  doctors.json  faqs.json  system-prompt.txt

tests/                      node --test; no database and no API key needed
```

### Why it is shaped this way

Each layer depends only on the one below it, and the dependencies point in one
direction:

```
routes  ->  agent  ->  { guardrails, memory, prompt, tools, providers }
                              tools     ->  store / persistence  ->  pg
```

`agent.js` contains no vendor name, no SQL, no HTTP and no prompt text. Changing
the model is a change in `providers/`; changing the database is a change in
`persistence/`; changing what the assistant can do is a new file in `tools/`.
Nothing else moves.

---

## 2. Request flow

A single patient message:

1. **Rate limit** — per IP, counted in the database so the limit holds across
   serverless instances.
2. **Input guard** — an unmistakable injection or credential-extraction attempt
   is answered with a fixed refusal and **no API call at all**. Borderline
   phrasing is allowed through with a flag.
3. **Memory** — the session is loaded: the last 16 turns plus a rolling summary
   of everything older. Anything that has aged out since the last turn is folded
   into the summary first, so the model never sees a gap.
4. **Prompt** — master prompt + live clinic data + session memory + a
   reinforcement note for anything the input guard flagged, in that order. The
   reinforcement is last because that is where a repeated rule carries the most
   weight.
5. **Generate** — the configured provider, with the tool schemas.
6. **Tools** — up to 6 rounds. Tools run in parallel within a round. Every
   result, including every error, goes back to the model as a tool result so it
   can recover in conversation rather than failing the turn.
7. **Output guard** — the reply is checked for leaked credentials, internal
   structure, diagnosis or medication, unauthorised discounts, and prices no
   tool returned.
8. **Persist** — user turn, assistant turn and a tool-use audit row are written
   in one round trip.

---

## 3. What the assistant can do

| Tool | Purpose |
|---|---|
| `get_clinic_info` | Address, phone, email, opening hours |
| `get_doctors` | Dentists, specialties, qualifications, languages |
| `get_services` | Every service with its official price |
| `search_faqs` | Policy and practical questions |
| `recommend_services` | Which service fits what the patient describes |
| `check_availability` | Open slots on a date, or one exact slot |
| `find_next_available` | The soonest open appointment |
| `book_appointment` | Create a confirmed booking |
| `find_appointments_by_phone` | Look up a patient's appointments |
| `reschedule_appointment` | Move an appointment |
| `cancel_appointment` | Cancel an appointment |
| `request_human_handoff` | Hand the conversation to the clinic team |

The AI shares one 30-minute slot calendar with the website's booking form, so a
time booked in chat cannot be double-booked on the form, or the other way round.

---

## 4. Guardrails

The system prompt asks the model to behave. These are what happens when it does
not — a prompt is a request, not a control.

### Structural (the real defences)

- The model holds **no credentials**. It cannot reach the database, the mail
  server or any API except through a declared tool.
- Every tool **validates its own arguments** before running.
- Every write **re-checks the database**, and a partial unique index on
  `(date, time)` is what finally decides a double-booking race — not an
  application check that can lose to another instance.
- Prices, services, doctors and FAQs are only ever **tool results**. A price the
  model states had to come back from the catalogue first.
- `reschedule_appointment` and `cancel_appointment` **refuse an appointment id
  this conversation did not look up**, so a guessed id cannot move a stranger's
  booking.
- `find_appointments_by_phone` is **capped at 5 distinct numbers per session**,
  so the chat cannot be used to enumerate patients. Lookups return the date,
  time, service and status — never the stored name or full number.

### Input guard

Blocks, with no API call: instruction override, prompt extraction, "developer
mode", role reassignment, credential requests, SQL, and long base64 payloads.
Flags (and reinforces the relevant rule) for: discount requests, medication
questions, requests for a diagnosis, model-identity probing, over-long messages.
Invisible and bidi characters are stripped so nothing can be hidden from anyone
reviewing the transcript.

### Output guard

Replaces the whole reply — no partial redaction — when it finds a credential, a
connection string, an environment variable name, SQL or internal table names,
prompt scaffolding, a diagnosis stated as fact, a medication dose, or a promised
discount or refund. The patient gets a safe message with the clinic's phone
number instead.

Prices are also checked against what the tools actually returned this turn. That
check **warns by default** rather than replacing, because a legitimate reply can
total two services and trip it. Watch the logs for `unverified_price`, and set
`AI_STRICT_PRICE_GUARD=true` once you are satisfied it is clean for your wording.

### What these are not

Pattern matching does not solve prompt injection, and nothing here pretends
otherwise. It is a cheap outer layer that catches the obvious attempts before
they cost an API call. The structural defences above are what actually hold.

---

## 5. Memory

Three kinds, with different lifetimes:

- **Replay window** (`AI_MEMORY_WINDOW`, default 16) — recent turns sent
  verbatim. Keeps the per-message token cost flat however long the conversation
  runs.
- **Rolling summary** — everything older, condensed by the model itself once
  `AI_SUMMARY_TRIGGER` messages is passed. Only re-run when messages have
  actually aged out since the last summary, so it costs one extra call every
  ~16 messages, not one per turn.
- **Facts** — structured values that must not be lost or misremembered: the
  patient's name and number, which numbers have been looked up, and which
  appointment ids this conversation may change.

Tool calls and their results are persisted for audit but **not replayed**.
Replaying them would spend tokens on data that has since changed, and slicing a
window mid tool-call/tool-result pair is rejected outright by some providers.

**Session ids are credentials.** 24 random bytes, held only by the browser that
started the conversation, and the only thing needed to read that transcript back
through `GET /api/chat/:sessionId`. That is the right trade-off for a clinic
chat widget — nobody creates an account to ask about opening hours — but if you
put the widget behind the clinic's own login, pass the patient id through and
scope sessions to it.

---

## 6. Swapping the LLM

Set `AI_PROVIDER` to `anthropic`, `openai` or `google` and provide that
provider's key. Leave it empty and the first provider with a key configured is
used, so an existing deployment with only `ANTHROPIC_API_KEY` keeps working.

To add a vendor, create `backend/ai/providers/<name>.js` exporting `create(settings)`
that returns `{ id, model, isConfigured(), complete(request) }`, and register it
in `providers/index.js`. The full contract — the normalised message, tool-call
and completion shapes — is documented at the top of `providers/index.js`. The
three shipped adapters are the worked examples: Anthropic carries tool results
in a user message, OpenAI uses a dedicated `tool` role keyed by `tool_call_id`,
and Gemini uses `functionResponse` parts and a reduced JSON Schema dialect. All
three normalise to the same thing, and `agent.js` never learns which is active.

---

## 7. API

### Public

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/chat/config` | Is the assistant available, greeting, clinic contact |
| `POST` | `/api/chat` | `{ message, sessionId?, locale? }` → `{ reply, sessionId, handoff }` |
| `GET` | `/api/chat/:sessionId` | Replay a conversation (the widget uses this after a reload) |
| `GET` | `/api/clinic` `/api/services` `/api/doctors` `/api/faqs` | The same live rows the agent reads |
| `GET` | `/api/availability?date=YYYY-MM-DD` | Open slots |
| `POST` | `/api/appointments` | The website's booking form |

`POST /api/chat` also accepts the older `{ messages: [...] }` transcript shape,
so a cached copy of the page keeps working after a deploy.

### Staff (`ADMIN_KEY`, via `x-admin-key` or `?key=`)

| Method | Path |
|---|---|
| `GET` | `/api/appointments` |
| `GET` | `/api/admin/handoffs?status=open\|all` |
| `POST` | `/api/admin/handoffs/:id/resolve` |
| `GET` | `/api/admin/sessions` |
| `GET` | `/api/admin/sessions/:id` |

Open handoffs appear on `/admin.html` under the appointment requests, with a
**Done** button.

### WhatsApp

| Method | Path |
|---|---|
| `GET` | `/api/whatsapp/webhook` (subscription handshake) |
| `POST` | `/api/whatsapp/webhook` (inbound messages) |

---

## 8. WhatsApp setup

### Meta WhatsApp Cloud API (default)

1. Create a Meta app with the WhatsApp product, and add a phone number.
2. Set in the environment:
   - `WHATSAPP_ENABLED=true`
   - `WHATSAPP_PROVIDER=meta`
   - `WHATSAPP_TOKEN` — permanent access token
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_APP_SECRET` — App Secret from the app dashboard
   - `WHATSAPP_VERIFY_TOKEN` — any string you choose
3. In **WhatsApp → Configuration → Webhook**, set the callback URL to
   `https://your-domain/api/whatsapp/webhook`, paste the same verify token, and
   subscribe to the **messages** field.

### Twilio

Set `WHATSAPP_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_WHATSAPP_FROM`, and `PUBLIC_BASE_URL`. Twilio signs the exact URL it
called, so `PUBLIC_BASE_URL` must match the number's configured webhook —
scheme and path included — or every request is rejected.

### How it behaves

- Every POST is **signature-verified against the raw request body** before
  anything is read out of it. `WHATSAPP_APP_SECRET` is not optional: without it
  the endpoint refuses everything.
- Message ids are checked against `inbound_events`, so a retried delivery is
  dropped rather than answered twice.
- The route **always returns 200**, even on an internal failure — anything else
  buys a retry of a message that has already been answered.
- The WhatsApp number is the session key, so a patient messaging next week
  continues the same conversation.
- Photos, voice notes and locations get a polite "I can only read text" reply
  rather than being misread.

### Scaling note

The reply is generated and sent **inline**, before the response returns: a
serverless instance is frozen the moment it does, so there is nowhere to defer
the work to. That is why the function's `maxDuration` is raised to 60s in
`vercel.json`. A clinic expecting heavy WhatsApp traffic should put a real queue
in front of it — the seam is `handleMessages()` in
`backend/ai/channels/whatsapp/index.js`, which is the only thing the route calls.

---

## 9. Editing what the assistant knows

| What | Where |
|---|---|
| Persona, tone, rules, guardrails | `backend/data/system-prompt.txt` |
| Clinic name, hours, contact, slot length | `backend/data/clinic.json` |
| Services and prices | `services` table (seeded from `services.json`) |
| Dentists | `doctors` table (seeded from `doctors.json`) |
| FAQs | `faqs` table (seeded from `faqs.json`) |

The JSON files are **seed data**. On first run with `DATABASE_URL` set they fill
the tables with `ON CONFLICT DO NOTHING`, so a price the clinic edits in the
database is never overwritten by a redeploy. To change a price in production,
`UPDATE` the row — the change is live within `CATALOG_TTL_MS` (60s), with no
deploy. Locally, without `DATABASE_URL`, the JSON files are read directly.

The `keywords` on each service drive `recommend_services`. They are matched
against what the patient describes, so add the words your patients actually use.

---

## 10. Testing

```bash
npm test
```

29 tests plus the WhatsApp suite, all against the scripted `mock` provider and a
temporary data directory: no API key, no database, no network. They cover the
agent loop, tool dispatch and validation, session memory, both guardrails, and
WhatsApp signature verification and payload parsing.

To exercise the whole site locally without an API key, put `AI_PROVIDER=mock` in
`backend/.env` — the widget then answers with a fixed scripted reply, which is
enough to check the plumbing.

---

## 11. Operating it

Each turn logs one line, with no message content:

```
[agent] session=8f43a72a channel=web verdict=clean tools=get_services|check_availability turns=2
```

Worth alerting on:

- `verdict=blocked` in volume from one session — someone is probing.
- `violations=secret_leak:replace` or `internals_leak:replace` — the output
  guard caught something it should never have had to. Investigate.
- `violations=tool_turns_exhausted` — the model is looping; usually a tool
  returning an error it cannot recover from.
- `unverified_price` — a price no tool returned. Check the wording before
  turning on `AI_STRICT_PRICE_GUARD`.

Transcripts are readable at `GET /api/admin/sessions/:id`. They contain patient
conversations, so `ADMIN_KEY` should be treated as a shared password: long,
random, and rotated if it ever appears in a screenshot.
