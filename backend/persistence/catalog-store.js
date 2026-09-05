// Live catalogue: services, doctors and FAQs.
//
// The JSON files in backend/data are seed data, not the source of truth. When
// DATABASE_URL is set the tables are created and seeded from those files on
// first use, and every read afterwards comes from the database — so the clinic
// can change a price or add a dentist with an UPDATE and the AI agent picks it
// up without a redeploy. Without DATABASE_URL (local dev) the JSON files are
// read directly.
//
// Reads are memoised for CATALOG_TTL_MS per instance. The catalogue changes a
// few times a year; hitting Postgres for it on every chat turn would add a
// round trip to each of the agent's tool calls for no benefit.

const pg = require("../pg");

const SEED_SERVICES = require("../data/services.json");
const SEED_DOCTORS = require("../data/doctors.json");
const SEED_FAQS = require("../data/faqs.json");

const CATALOG_TTL_MS = Number(process.env.CATALOG_TTL_MS || 60000);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS services (
    id             text PRIMARY KEY,
    name           text NOT NULL,
    description    text NOT NULL DEFAULT '',
    starting_price numeric,
    price_label    text NOT NULL DEFAULT '',
    duration_minutes int,
    keywords       text[] NOT NULL DEFAULT '{}',
    active         boolean NOT NULL DEFAULT true,
    sort_order     int NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS doctors (
    id             text PRIMARY KEY,
    name           text NOT NULL,
    title          text NOT NULL DEFAULT '',
    specialties    text[] NOT NULL DEFAULT '{}',
    qualifications text NOT NULL DEFAULT '',
    experience_years int,
    languages      text[] NOT NULL DEFAULT '{}',
    bio            text NOT NULL DEFAULT '',
    active         boolean NOT NULL DEFAULT true,
    sort_order     int NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS faqs (
    id         text PRIMARY KEY,
    question   text NOT NULL,
    answer     text NOT NULL,
    tags       text[] NOT NULL DEFAULT '{}',
    active     boolean NOT NULL DEFAULT true,
    sort_order int NOT NULL DEFAULT 0
  );
`;

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

function createPostgresCatalog() {
  const pool = pg.getPool();

  // ON CONFLICT DO NOTHING means the seed only ever fills gaps: a price the
  // clinic edited in the database is never overwritten by the JSON file.
  const init = pg.once(async () => {
    await pool.query(SCHEMA);

    for (const s of SEED_SERVICES) {
      await pool.query(
        `INSERT INTO services
           (id, name, description, starting_price, price_label, duration_minutes, keywords, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [s.id, s.name, s.description || "", s.startingPrice, s.priceLabel || "",
         s.durationMinutes || null, s.keywords || [], SEED_SERVICES.indexOf(s) + 1]
      );
    }
    for (const d of SEED_DOCTORS) {
      await pool.query(
        `INSERT INTO doctors
           (id, name, title, specialties, qualifications, experience_years, languages, bio, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [d.id, d.name, d.title || "", d.specialties || [], d.qualifications || "",
         d.experienceYears || null, d.languages || [], d.bio || "", d.sortOrder || 0]
      );
    }
    for (const f of SEED_FAQS) {
      await pool.query(
        `INSERT INTO faqs (id, question, answer, tags, sort_order)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [f.id, f.question, f.answer, f.tags || [], f.sortOrder || 0]
      );
    }
  });

  async function query(text, params) {
    await init();
    return pool.query(text, params);
  }

  return {
    async listServices() {
      const { rows } = await query(
        `SELECT id, name, description, starting_price, price_label, duration_minutes, keywords
         FROM services WHERE active ORDER BY sort_order, name`
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        startingPrice: r.starting_price === null ? null : Number(r.starting_price),
        priceLabel: r.price_label,
        durationMinutes: r.duration_minutes,
        keywords: r.keywords || [],
      }));
    },

    async listDoctors() {
      const { rows } = await query(
        `SELECT id, name, title, specialties, qualifications, experience_years, languages, bio
         FROM doctors WHERE active ORDER BY sort_order, name`
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        title: r.title,
        specialties: r.specialties || [],
        qualifications: r.qualifications,
        experienceYears: r.experience_years,
        languages: r.languages || [],
        bio: r.bio,
      }));
    },

    async listFaqs() {
      const { rows } = await query(
        `SELECT id, question, answer, tags FROM faqs WHERE active ORDER BY sort_order, id`
      );
      return rows.map((r) => ({ id: r.id, question: r.question, answer: r.answer, tags: r.tags || [] }));
    },
  };
}

// ---------------------------------------------------------------------------
// JSON seed files (local development)
// ---------------------------------------------------------------------------

function createFileCatalog() {
  return {
    async listServices() {
      return SEED_SERVICES.map((s) => ({ keywords: [], durationMinutes: null, ...s }));
    },
    async listDoctors() {
      return SEED_DOCTORS.map((d) => ({ ...d }));
    },
    async listFaqs() {
      return SEED_FAQS.map((f) => ({ ...f }));
    },
  };
}

const backing = pg.isPostgres ? createPostgresCatalog() : createFileCatalog();

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map();

function cached(key, load) {
  return async function read() {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.value;
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  };
}

const getServices = cached("services", () => backing.listServices());
const getDoctors = cached("doctors", () => backing.listDoctors());
const getFaqs = cached("faqs", () => backing.listFaqs());

function clearCache() {
  cache.clear();
}

module.exports = { getServices, getDoctors, getFaqs, clearCache, isPostgres: pg.isPostgres };
