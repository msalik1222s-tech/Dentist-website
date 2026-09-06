// Storage driver for appointments and rate limiting.
//
// Two backends share one async interface:
//   * Postgres  — used whenever DATABASE_URL is set (required on Vercel, whose
//                 filesystem is read-only and whose instances are short-lived).
//   * JSON file — used for local development when DATABASE_URL is absent.
//
// Everything is async so callers don't have to care which one is active.

const fs = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

// Vercel sets VERCEL=1 in every deployment, preview builds included.
const ON_VERCEL = !!process.env.VERCEL;

// ---------------------------------------------------------------------------
// Postgres driver
// ---------------------------------------------------------------------------

function createPostgresDriver(connectionString) {
  const { Pool } = require("pg");

  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const pool = new Pool({
    connectionString,
    // Managed providers (Neon, Supabase, Railway) terminate TLS with chains
    // Node doesn't always trust, so only verify when the URL asks us to.
    ssl: isLocal || /sslmode=/.test(connectionString) ? undefined : { rejectUnauthorized: false },
    // One connection per serverless instance: many instances times a big pool
    // exhausts the database's connection limit fast.
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });

  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS appointments (
      id           text PRIMARY KEY,
      ref          text NOT NULL DEFAULT '',
      name         text NOT NULL,
      phone        text NOT NULL,
      phone_digits text NOT NULL DEFAULT '',
      service      text NOT NULL DEFAULT '',
      date         text NOT NULL,
      time         text NOT NULL,
      message      text NOT NULL DEFAULT '',
      status       text NOT NULL DEFAULT 'confirmed',
      source       text NOT NULL DEFAULT 'chat',
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz
    );

    CREATE UNIQUE INDEX IF NOT EXISTS appointments_slot_unique
      ON appointments (date, time) WHERE status <> 'cancelled';

    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS ref text NOT NULL DEFAULT '';

    -- The booking reference is half of the credential a patient uses to read
    -- or change their appointment, so it has to be unique. Rows predating this
    -- column have an empty ref and are excluded, so they cannot collide with
    -- each other — and an empty reference never matches a lookup.
    CREATE UNIQUE INDEX IF NOT EXISTS appointments_ref_unique
      ON appointments (ref) WHERE ref <> '';

    CREATE INDEX IF NOT EXISTS appointments_date_idx ON appointments (date);
    CREATE INDEX IF NOT EXISTS appointments_phone_idx ON appointments (phone_digits);

    CREATE TABLE IF NOT EXISTS rate_limits (
      bucket text NOT NULL,
      ip     text NOT NULL,
      hit_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS rate_limits_lookup_idx
      ON rate_limits (bucket, ip, hit_at);
  `;

  // The appointments_slot_unique index above is the real double-booking guard.
  // A check-then-insert in app code races when two visitors book the same slot
  // on two instances at once; the index makes the database reject the loser.

  // Run the schema once per cold start, not once per request.
  let ready = null;
  function init() {
    if (!ready) {
      ready = pool.query(SCHEMA).catch((err) => {
        ready = null; // let the next request retry instead of failing forever
        throw err;
      });
    }
    return ready;
  }

  async function query(text, params) {
    await init();
    return pool.query(text, params);
  }

  const COLUMNS =
    "id, ref, name, phone, service, date, time, message, status, source, created_at, updated_at";

  function toEntry(row) {
    if (!row) return null;
    const entry = {
      id: row.id,
      ref: row.ref,
      name: row.name,
      phone: row.phone,
      service: row.service,
      date: row.date,
      time: row.time,
      message: row.message,
      status: row.status,
      source: row.source,
      createdAt: new Date(row.created_at).toISOString(),
    };
    if (row.updated_at) entry.updatedAt = new Date(row.updated_at).toISOString();
    return entry;
  }

  function isUniqueViolation(err) {
    return err && err.code === "23505";
  }

  // Which constraint failed decides what the caller does next: a duplicate
  // reference just needs a fresh one, a taken slot is a real booking conflict.
  function uniqueViolationKind(err) {
    if (!isUniqueViolation(err)) return null;
    return String(err.constraint || "").includes("ref") ? "REF_TAKEN" : "SLOT_TAKEN";
  }

  return {
    async getBookedTimes(date) {
      const { rows } = await query(
        "SELECT time FROM appointments WHERE date = $1 AND status <> 'cancelled'",
        [date]
      );
      return rows.map((r) => r.time);
    },

    // One query for the whole search window — findNextAvailable would otherwise
    // fire 30 round trips, which is painfully slow on serverless.
    async getBookedTimesByRange(fromDate, toDate) {
      const { rows } = await query(
        `SELECT date, time FROM appointments
         WHERE date >= $1 AND date <= $2 AND status <> 'cancelled'`,
        [fromDate, toDate]
      );
      const byDate = new Map();
      for (const row of rows) {
        if (!byDate.has(row.date)) byDate.set(row.date, []);
        byDate.get(row.date).push(row.time);
      }
      return byDate;
    },

    async insertAppointment(entry) {
      try {
        const { rows } = await query(
          `INSERT INTO appointments
             (id, ref, name, phone, phone_digits, service, date, time, message, status, source, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING ${COLUMNS}`,
          [
            entry.id,
            entry.ref,
            entry.name,
            entry.phone,
            entry.phoneDigits,
            entry.service,
            entry.date,
            entry.time,
            entry.message,
            entry.status,
            entry.source,
            entry.createdAt,
          ]
        );
        return toEntry(rows[0]);
      } catch (err) {
        const kind = uniqueViolationKind(err);
        if (kind) throw new Error(kind);
        throw err;
      }
    },

    async listAppointments() {
      const { rows } = await query(
        `SELECT ${COLUMNS} FROM appointments ORDER BY created_at DESC`
      );
      return rows.map(toEntry);
    },

    async findByPhoneDigits(digits) {
      const { rows } = await query(
        `SELECT ${COLUMNS} FROM appointments
         WHERE phone_digits = $1 AND status <> 'cancelled'
         ORDER BY date, time`,
        [digits]
      );
      return rows.map(toEntry);
    },

    async getAppointmentById(id) {
      const { rows } = await query(`SELECT ${COLUMNS} FROM appointments WHERE id = $1`, [id]);
      return toEntry(rows[0]);
    },

    async updateAppointmentSchedule(id, date, time, updatedAt) {
      try {
        const { rows } = await query(
          `UPDATE appointments SET date = $2, time = $3, updated_at = $4
           WHERE id = $1 AND status <> 'cancelled'
           RETURNING ${COLUMNS}`,
          [id, date, time, updatedAt]
        );
        return toEntry(rows[0]);
      } catch (err) {
        if (isUniqueViolation(err)) throw new Error("SLOT_TAKEN");
        throw err;
      }
    },

    async cancelAppointmentById(id, updatedAt) {
      const { rows } = await query(
        `UPDATE appointments SET status = 'cancelled', updated_at = $2
         WHERE id = $1 AND status <> 'cancelled'
         RETURNING ${COLUMNS}`,
        [id, updatedAt]
      );
      return toEntry(rows[0]);
    },

    // Returns how many hits this ip already made in the window, excluding the
    // one being recorded now (the INSERT is invisible to the SELECT's snapshot),
    // which matches the old in-memory "push, then test length > max" semantics.
    async countRateLimitHits(bucket, ip, windowMs) {
      if (Math.random() < 0.01) {
        // Opportunistic cleanup so the table can't grow without bound.
        query("DELETE FROM rate_limits WHERE hit_at < now() - interval '1 day'").catch(() => {});
      }
      const { rows } = await query(
        `WITH ins AS (
           INSERT INTO rate_limits (bucket, ip) VALUES ($1, $2)
         )
         SELECT count(*)::int AS c FROM rate_limits
         WHERE bucket = $1 AND ip = $2 AND hit_at > now() - make_interval(secs => $3::double precision)`,
        [bucket, ip, windowMs / 1000]
      );
      return rows[0].c;
    },
  };
}

// ---------------------------------------------------------------------------
// JSON-file driver (local development only)
// ---------------------------------------------------------------------------

function createFileDriver() {
  const DATA_FILE = path.join(__dirname, "data", "appointments.json");

  // Vercel’s filesystem is read-only, so this driver cannot store anything there.
  // Without this guard the first booking dies inside writeFileSync with an EROFS
  // that the patient only ever sees as "Something went wrong", and the request is
  // lost. Fail with the actual cause instead.
  function assertWritableHost() {
    if (!ON_VERCEL) return;
    throw Object.assign(
      new Error(
        "DATABASE_URL is not set. Vercel’s filesystem is read-only, so appointments " +
          "cannot be saved to backend/data/appointments.json. Add a Postgres connection " +
          "string as DATABASE_URL in Project Settings -> Environment Variables and redeploy."
      ),
      { code: "NO_DATABASE_URL" }
    );
  }

  function load() {
    try {
      const list = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function save(list) {
    assertWritableHost();
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
  }

  // Must match store.phoneKey: the last 9 digits, so the same patient is
  // found whether they typed "0501234567" or "+966 50 123 4567".
  function digitsOf(phone) {
    const digits = String(phone || "").replace(/[^0-9]/g, "");
    return digits.length > 9 ? digits.slice(-9) : digits;
  }

  const hits = new Map();

  return {
    async getBookedTimes(date) {
      return load()
        .filter((a) => a.date === date && a.status !== "cancelled" && a.time)
        .map((a) => a.time);
    },

    async getBookedTimesByRange(fromDate, toDate) {
      const byDate = new Map();
      for (const a of load()) {
        if (a.status === "cancelled" || !a.time) continue;
        if (a.date < fromDate || a.date > toDate) continue;
        if (!byDate.has(a.date)) byDate.set(a.date, []);
        byDate.get(a.date).push(a.time);
      }
      return byDate;
    },

    async insertAppointment(entry) {
      const list = load();
      const taken = list.some(
        (a) => a.date === entry.date && a.time === entry.time && a.status !== "cancelled"
      );
      if (taken) throw new Error("SLOT_TAKEN");
      // Mirrors the appointments_ref_unique index on the Postgres side.
      if (entry.ref && list.some((a) => a.ref === entry.ref)) {
        throw new Error("REF_TAKEN");
      }
      const { phoneDigits, ...stored } = entry;
      list.push(stored);
      save(list);
      return stored;
    },

    async listAppointments() {
      return load().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },

    async findByPhoneDigits(digits) {
      return load().filter((a) => digitsOf(a.phone) === digits && a.status !== "cancelled");
    },

    async getAppointmentById(id) {
      return load().find((a) => a.id === id) || null;
    },

    async updateAppointmentSchedule(id, date, time, updatedAt) {
      const list = load();
      const appt = list.find((a) => a.id === id && a.status !== "cancelled");
      if (!appt) return null;
      const taken = list.some(
        (a) => a.id !== id && a.date === date && a.time === time && a.status !== "cancelled"
      );
      if (taken) throw new Error("SLOT_TAKEN");
      appt.date = date;
      appt.time = time;
      appt.updatedAt = updatedAt;
      save(list);
      return appt;
    },

    async cancelAppointmentById(id, updatedAt) {
      const list = load();
      const appt = list.find((a) => a.id === id && a.status !== "cancelled");
      if (!appt) return null;
      appt.status = "cancelled";
      appt.updatedAt = updatedAt;
      save(list);
      return appt;
    },

    async countRateLimitHits(bucket, ip, windowMs) {
      const key = bucket + "|" + ip;
      const now = Date.now();
      const kept = (hits.get(key) || []).filter((t) => now - t < windowMs);
      const before = kept.length;
      kept.push(now);
      hits.set(key, kept);
      return before;
    },
  };
}

const driver = DATABASE_URL ? createPostgresDriver(DATABASE_URL) : createFileDriver();

if (!DATABASE_URL && ON_VERCEL) {
  console.error(
    "FATAL CONFIG: running on Vercel without DATABASE_URL. Appointments cannot be " +
      "saved — set DATABASE_URL in Project Settings -> Environment Variables."
  );
}

module.exports = Object.assign({ isPostgres: !!DATABASE_URL }, driver);
