// Admin authentication regression suite.
//
//   npm run test:admin
//
// Read-only: it starts the app on a loopback port and only ever sends GET
// requests to the admin route, so no appointment is created and nothing is
// written to disk.
//
// Every check here corresponds to a property the admin route must keep: the
// key travels in a header and nowhere else, a wrong or missing key is
// rejected, guesses are rate limited, and an unset ADMIN_KEY closes the door
// rather than opening it.
//
// No real secret appears in this file or in its output. The key below is
// generated per run and is never printed — a test that logs the credential it
// is testing would leak that credential into CI output.

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");

// The JSON-file driver keeps its rate-limit counters in memory, which is what
// lets the throttling checks below start from a clean slate. Postgres would
// share counters with whatever else has been talking to that database.
delete process.env.DATABASE_URL;
delete process.env.TRUST_PROXY;

const TEST_KEY = "test-key-" + Math.random().toString(36).slice(2, 12);
const WRONG_KEY = "wrong-key-" + Math.random().toString(36).slice(2, 12);

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}${detail ? "\n        " + detail : ""}`);
    fail++;
  }
}

// A fresh module graph per phase: ADMIN_KEY is read once when backend/app.js
// is required, and the in-memory rate-limit counters live in backend/db.js.
function freshApp(port, adminKey) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join(ROOT, "backend"))) delete require.cache[k];
  }
  if (adminKey === undefined) delete process.env.ADMIN_KEY;
  else process.env.ADMIN_KEY = adminKey;

  const { createApp } = require(path.join(ROOT, "backend", "app"));
  const app = createApp({ serveStatic: false });
  return new Promise((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const call = (port, p, opts = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, opts).then(async (r) => ({
    status: r.status,
    ct: r.headers.get("content-type") || "",
    body: (r.headers.get("content-type") || "").includes("json") ? await r.json() : await r.text(),
  }));

async function main() {
  const ADMIN = "/api/appointments";

  console.log("\n=== 1. The header key is the only way in ===");
  const PORT = 8811;
  let server = await freshApp(PORT, TEST_KEY);

  const ok = await call(PORT, ADMIN, { headers: { "x-admin-key": TEST_KEY } });
  check("valid x-admin-key -> 200", ok.status === 200, `got ${ok.status}`);
  check(
    "200 body is the appointment list",
    ok.body && ok.body.ok === true && Array.isArray(ok.body.appointments)
  );

  const none = await call(PORT, ADMIN);
  check("no key -> 401", none.status === 401, `got ${none.status}`);

  const wrong = await call(PORT, ADMIN, { headers: { "x-admin-key": WRONG_KEY } });
  check("wrong x-admin-key -> 401", wrong.status === 401, `got ${wrong.status}`);

  const empty = await call(PORT, ADMIN, { headers: { "x-admin-key": "" } });
  check("empty x-admin-key -> 401", empty.status === 401, `got ${empty.status}`);

  console.log("\n=== 2. ?key= no longer authenticates ===");
  const q = await call(PORT, `${ADMIN}?key=${encodeURIComponent(TEST_KEY)}`);
  check("correct key in the query string -> 401", q.status === 401, `got ${q.status}`);
  check("query-string attempt leaks no appointments", !(q.body && q.body.appointments));

  const qPlusBadHeader = await call(PORT, `${ADMIN}?key=${encodeURIComponent(TEST_KEY)}`, {
    headers: { "x-admin-key": WRONG_KEY },
  });
  check(
    "query string cannot rescue a wrong header -> 401",
    qPlusBadHeader.status === 401,
    `got ${qPlusBadHeader.status}`
  );

  const goodHeaderBadQuery = await call(PORT, `${ADMIN}?key=${encodeURIComponent(WRONG_KEY)}`, {
    headers: { "x-admin-key": TEST_KEY },
  });
  check(
    "a junk ?key= is simply ignored when the header is right -> 200",
    goodHeaderBadQuery.status === 200,
    `got ${goodHeaderBadQuery.status}`
  );

  console.log("\n=== 3. The 401 gives nothing away ===");
  const body401 = JSON.stringify(none.body || {});
  check("401 is JSON", none.ct.includes("json"), none.ct);
  check(
    "401 says only 'Unauthorized.'",
    none.body && none.body.ok === false && none.body.error === "Unauthorized.",
    body401
  );
  check("401 does not echo the configured key", !body401.includes(TEST_KEY));
  check("401 does not echo the attempted key", !JSON.stringify(wrong.body || {}).includes(WRONG_KEY));

  server.close();

  console.log("\n=== 4. An unset ADMIN_KEY denies everyone ===");
  const PORT_NOKEY = 8812;
  server = await freshApp(PORT_NOKEY, undefined);
  check("ADMIN_KEY unset, no key sent -> 401", (await call(PORT_NOKEY, ADMIN)).status === 401);
  check(
    "ADMIN_KEY unset, empty key sent -> 401",
    (await call(PORT_NOKEY, ADMIN, { headers: { "x-admin-key": "" } })).status === 401
  );
  check(
    "ADMIN_KEY unset, some key sent -> 401",
    (await call(PORT_NOKEY, ADMIN, { headers: { "x-admin-key": TEST_KEY } })).status === 401
  );
  server.close();

  const PORT_BLANK = 8813;
  server = await freshApp(PORT_BLANK, "");
  check(
    "ADMIN_KEY set to an empty string -> still 401",
    (await call(PORT_BLANK, ADMIN, { headers: { "x-admin-key": "" } })).status === 401
  );
  server.close();

  console.log("\n=== 5. Guesses are rate limited ===");
  // LIMITS.admin allows 20 per 10 minutes per client. The limiter sits in
  // front of the auth check, so wrong keys must consume the allowance too —
  // otherwise a brute-force attempt would never be throttled at all.
  const PORT_RL = 8814;
  server = await freshApp(PORT_RL, TEST_KEY);

  let allowed = 0;
  let limitedAt = 0;
  for (let i = 1; i <= 25; i++) {
    const r = await call(PORT_RL, ADMIN, { headers: { "x-admin-key": WRONG_KEY } });
    if (r.status === 429) {
      limitedAt = i;
      break;
    }
    if (r.status === 401) allowed++;
  }
  check("wrong keys eventually hit 429", limitedAt > 0, "25 guesses were all allowed through");
  check(
    "the allowance is 20 guesses, then 429",
    allowed === 20 && limitedAt === 21,
    `${allowed} allowed, limited at ${limitedAt}`
  );

  const afterLimit = await call(PORT_RL, ADMIN, { headers: { "x-admin-key": TEST_KEY } });
  check(
    "even the correct key is throttled once the bucket is empty",
    afterLimit.status === 429,
    `got ${afterLimit.status}`
  );
  check(
    "429 is a generic JSON message",
    afterLimit.ct.includes("json") &&
      afterLimit.body.ok === false &&
      /try again later/i.test(afterLimit.body.error || ""),
    JSON.stringify(afterLimit.body)
  );
  check(
    "429 leaks no appointments and no key",
    !afterLimit.body.appointments && !JSON.stringify(afterLimit.body).includes(TEST_KEY)
  );

  console.log("\n=== 6. Public routes are untouched by the admin bucket ===");
  const day = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
  const avail = await call(PORT_RL, `/api/availability?date=${day}`);
  check("availability still 200 after the admin bucket is exhausted", avail.status === 200, `got ${avail.status}`);
  check("availability still returns slots", avail.body && avail.body.ok === true && Array.isArray(avail.body.slots));

  const chatBadBody = await call(PORT_RL, "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  check("chat still validates its own body (400, not 401/429)", chatBadBody.status === 400, `got ${chatBadBody.status}`);

  const bookingBadBody = await call(PORT_RL, "/api/appointments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  check(
    "form booking still validates its own body (400, not 401/429)",
    bookingBadBody.status === 400,
    `got ${bookingBadBody.status}`
  );
  server.close();

  console.log("\n=== 7. The source itself has no query-string fallback ===");
  const src = fs.readFileSync(path.join(ROOT, "backend", "app.js"), "utf8");
  check("app.js reads no key from req.query", !/req\.query\.key/.test(src));
  check("app.js still reads the x-admin-key header", /req\.headers\["x-admin-key"\]/.test(src));
  check(
    "the admin route is wrapped in a limiter",
    /api\.get\("\/appointments",\s*limiter\("admin"\),\s*requireAdmin/.test(src)
  );
  check("ADMIN_KEY is never logged", !/console\.\w+\([^)]*ADMIN_KEY/.test(src));

  const adminPage = fs.readFileSync(path.join(ROOT, "public", "admin.html"), "utf8");
  check("admin.html sends the key as a header", /x-admin-key/i.test(adminPage));
  check("admin.html puts no key in a URL", !/[?&]key=/.test(adminPage));

  console.log(`\n${"=".repeat(46)}\nRESULT: ${pass} passed, ${fail} failed\n${"=".repeat(46)}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
