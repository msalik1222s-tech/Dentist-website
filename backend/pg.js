// Single shared Postgres pool for every module that needs one.
//
// Each serverless instance gets exactly one connection (max: 1). Handing every
// module its own Pool would multiply that by the number of modules, and a few
// hundred concurrent instances would exhaust the database's connection limit.
//
// Schema creation is per-module and memoised through `once()` so a cold start
// runs each CREATE TABLE block at most once, not once per request.

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const isPostgres = !!DATABASE_URL;

let pool = null;

function getPool() {
  if (!isPostgres) return null;
  if (pool) return pool;

  const { Pool } = require("pg");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);

  pool = new Pool({
    connectionString: DATABASE_URL,
    // Managed providers (Neon, Supabase, Railway) terminate TLS with chains
    // Node doesn't always trust, so only verify when the URL asks us to.
    ssl: isLocal || /sslmode=/.test(DATABASE_URL) ? undefined : { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });

  return pool;
}

// Runs `fn` once per process. A rejection clears the memo so the next request
// retries instead of the module staying permanently broken after one blip.
function once(fn) {
  let promise = null;
  return function run() {
    if (!promise) {
      promise = Promise.resolve()
        .then(fn)
        .catch((err) => {
          promise = null;
          throw err;
        });
    }
    return promise;
  };
}

module.exports = { isPostgres, getPool, once, DATABASE_URL };
