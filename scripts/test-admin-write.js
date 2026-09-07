// Admin write suite: PATCH /api/appointments/:ref
//
//   npm run test:admin-write
//
// Runs against the JSON-file driver on a scratch data file, so it never
// touches a real database and never sends mail (SMTP_HOST is cleared, which
// is what mailer.js checks before it will send anything). The data file is
// backed up and restored around the run.
//
// The admin key used here is generated per run and is never printed.

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const DATA_FILE = path.join(ROOT, "backend", "data", "appointments.json");

delete process.env.DATABASE_URL;
delete process.env.TRUST_PROXY;
delete process.env.SMTP_HOST; // no mail from the booking path
delete process.env.CLINIC_EMAIL;

const TEST_KEY = "test-key-" + Math.random().toString(36).slice(2, 12);
const WRONG_KEY = "wrong-key-" + Math.random().toString(36).slice(2, 12);
process.env.ADMIN_KEY = TEST_KEY;

const hadData = fs.existsSync(DATA_FILE);
const backup = hadData ? fs.readFileSync(DATA_FILE, "utf8") : null;
function restore() {
  if (hadData) fs.writeFileSync(DATA_FILE, backup);
  else if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
}

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

const store = require(path.join(ROOT, "backend", "store"));

// The admin limiter allows 20 requests per 10 minutes and this suite needs far
// more than that, so each phase gets its own app instance: the file driver
// keeps its rate-limit counters in memory, and a fresh require of backend/db.js
// starts them empty. Appointments live in the JSON file, so they carry across
// instances untouched — only the counters reset.
let PORT = 8820;
let server = null;
async function freshApp() {
  if (server) await new Promise((r) => server.close(r));
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join(ROOT, "backend"))) delete require.cache[k];
  }
  const { createApp } = require(path.join(ROOT, "backend", "app"));
  const app = createApp({ serveStatic: false });
  PORT += 1;
  server = await new Promise((r) => {
    const s = app.listen(PORT, "127.0.0.1", () => r(s));
  });
}

const call = (p, opts = {}) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, opts).then(async (r) => ({
    status: r.status,
    ct: r.headers.get("content-type") || "",
    body: (r.headers.get("content-type") || "").includes("json") ? await r.json() : await r.text(),
  }));

// Every admin write in this suite goes through here, so the key is sent as a
// header and only as a header.
const patch = (ref, body, headers = { "x-admin-key": TEST_KEY }) =>
  call(`/api/appointments/${ref}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const slotsFor = (date) => store.getAvailableSlots(date);
const isFree = async (date, time) => (await slotsFor(date)).includes(time);

async function book({ date, time, status }) {
  const appt = await store.createAppointment({
    name: "Test Patient",
    phone: "0500000001",
    service: "Teeth Whitening",
    date,
    time,
    message: "private note",
    source: "form",
    status,
  });
  return appt.ref;
}

async function main() {
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);

  await freshApp();

  const today = store.getClinicNow().dateStr;
  const day = new Date(Date.parse(today + "T00:00:00Z") + 6 * 86400000).toISOString().slice(0, 10);
  const day2 = new Date(Date.parse(today + "T00:00:00Z") + 7 * 86400000).toISOString().slice(0, 10);
  const slots = await slotsFor(day);

  console.log("\n=== 1. The write endpoint is behind the admin key ===");
  const refAuth = await book({ date: day, time: slots[0], status: "pending" });

  const noKey = await patch(refAuth, { action: "confirm" }, {});
  check("no admin key -> 401", noKey.status === 401, `got ${noKey.status}`);

  const badKey = await patch(refAuth, { action: "confirm" }, { "x-admin-key": WRONG_KEY });
  check("wrong admin key -> 401", badKey.status === 401, `got ${badKey.status}`);

  const inQuery = await call(`/api/appointments/${refAuth}?key=${encodeURIComponent(TEST_KEY)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "confirm" }),
  });
  check("key in the query string -> 401", inQuery.status === 401, `got ${inQuery.status}`);

  const inBody = await patch(refAuth, { action: "confirm", key: TEST_KEY, adminKey: TEST_KEY }, {});
  check("key in the request body -> 401", inBody.status === 401, `got ${inBody.status}`);

  const stillPending = await store.findAppointmentsByPhone("0500000001", refAuth);
  check(
    "none of those unauthorized attempts changed anything",
    stillPending[0] && stillPending[0].status === "pending",
    JSON.stringify(stillPending[0])
  );

  const authed = await patch(refAuth, { action: "confirm" });
  check("valid x-admin-key works -> 200", authed.status === 200, `got ${authed.status}`);

  console.log("\n=== 2. Confirm ===");
  const refConfirm = await book({ date: day, time: slots[1], status: "pending" });
  const c1 = await patch(refConfirm, { action: "confirm" });
  check("confirm a pending booking -> 200", c1.status === 200, `got ${c1.status}`);
  check("status is now confirmed", c1.body.appointment && c1.body.appointment.status === "confirmed", JSON.stringify(c1.body));
  check("changed: true the first time", c1.body.changed === true);
  check("the reference is preserved", c1.body.appointment.ref === refConfirm);

  const c2 = await patch(refConfirm, { action: "confirm" });
  check("confirming again -> 200, not an error", c2.status === 200, `got ${c2.status}`);
  check("still confirmed", c2.body.appointment.status === "confirmed");
  check("changed: false the second time", c2.body.changed === false, JSON.stringify(c2.body));

  console.log("\n=== 3. Cancel ===");
  const refCancelPending = await book({ date: day, time: slots[2], status: "pending" });
  const cp = await patch(refCancelPending, { action: "cancel" });
  check("cancel a pending booking -> 200", cp.status === 200, `got ${cp.status}`);
  check("status is now cancelled", cp.body.appointment.status === "cancelled", JSON.stringify(cp.body));
  check("changed: true", cp.body.changed === true);

  const refCancelConfirmed = await book({ date: day, time: slots[3], status: "confirmed" });
  const cc = await patch(refCancelConfirmed, { action: "cancel" });
  check("cancel a confirmed booking -> 200", cc.status === 200, `got ${cc.status}`);
  check("status is now cancelled", cc.body.appointment.status === "cancelled");

  const cAgain = await patch(refCancelConfirmed, { action: "cancel" });
  check("cancelling again -> 200, not an error", cAgain.status === 200, `got ${cAgain.status}`);
  check("still cancelled", cAgain.body.appointment.status === "cancelled");
  check("changed: false the second time", cAgain.body.changed === false, JSON.stringify(cAgain.body));

  check("the cancelled slot is free again", await isFree(day, slots[2]), `${day} ${slots[2]} still taken`);
  check("the other cancelled slot is free again", await isFree(day, slots[3]));

  console.log("\n=== 4. A cancelled appointment cannot be revived ===");
  const revive = await patch(refCancelPending, { action: "confirm" });
  check("confirm on a cancelled appointment -> 409", revive.status === 409, `got ${revive.status}`);
  check("it stays cancelled", (await store.findAppointmentsByPhone("0500000001", refCancelPending)).length === 0);

  const reschedCancelled = await patch(refCancelPending, {
    action: "reschedule",
    date: day2,
    time: slots[0],
  });
  check("reschedule of a cancelled appointment -> 409", reschedCancelled.status === 409, `got ${reschedCancelled.status}`);
  check("the slot it was asked to move to is untouched", await isFree(day2, slots[0]));

  console.log("\n=== 5. Reschedule ===");
  const refResPending = await book({ date: day, time: slots[4], status: "pending" });
  const rp = await patch(refResPending, { action: "reschedule", date: day2, time: slots[5] });
  check("reschedule a pending booking -> 200", rp.status === 200, `got ${rp.status} ${JSON.stringify(rp.body)}`);
  check("it moved to the new slot", rp.body.appointment.date === day2 && rp.body.appointment.time === slots[5], JSON.stringify(rp.body.appointment));
  check("the reference is preserved", rp.body.appointment.ref === refResPending);
  check("a pending booking stays pending", rp.body.appointment.status === "pending", JSON.stringify(rp.body.appointment));
  check("the old slot is free again", await isFree(day, slots[4]));
  check("the new slot is now taken", !(await isFree(day2, slots[5])));

  const refResConfirmed = await book({ date: day, time: slots[6], status: "confirmed" });
  const rc = await patch(refResConfirmed, { action: "reschedule", date: day2, time: slots[7] });
  check("reschedule a confirmed booking -> 200", rc.status === 200, `got ${rc.status}`);
  check("a confirmed booking stays confirmed", rc.body.appointment.status === "confirmed", JSON.stringify(rc.body.appointment));
  check("the old slot is free again", await isFree(day, slots[6]));
  check("the new slot is now taken", !(await isFree(day2, slots[7])));

  console.log("\n=== 6. Double booking is refused ===");
  const refClash = await book({ date: day, time: slots[8], status: "pending" });
  const clash = await patch(refClash, { action: "reschedule", date: day2, time: slots[5] });
  check("reschedule onto a taken slot -> 409", clash.status === 409, `got ${clash.status}`);
  check("409 says the slot is booked, nothing more", /already booked/i.test(clash.body.error || ""), JSON.stringify(clash.body));
  check("the clashing appointment did not move", (await store.findAppointmentsByPhone("0500000001", refClash))[0].time === slots[8]);
  check("the slot's original holder still has it", (await store.findAppointmentsByPhone("0500000001", refResPending))[0].time === slots[5]);

  // A fresh allowance: the phases above have spent part of this one.
  await freshApp();
  console.log("\n=== 7. Validation ===");
  const bad = [
    ["missing action", { }, 400],
    ["unknown action", { action: "delete" }, 400],
    ["empty action", { action: "" }, 400],
    ["action is not a string", { action: { confirm: true } }, 400],
    ["reschedule with no date/time", { action: "reschedule" }, 400],
    ["malformed date", { action: "reschedule", date: "12-03-2026", time: slots[9] }, 400],
    ["impossible date", { action: "reschedule", date: "2026-02-30", time: slots[9] }, 400],
    ["out-of-hours time", { action: "reschedule", date: day2, time: "03:00" }, 400],
    ["malformed time", { action: "reschedule", date: day2, time: "9am" }, 400],
    ["date in the past", { action: "reschedule", date: "2020-01-02", time: slots[9] }, 400],
  ];
  for (const [label, body, expected] of bad) {
    const r = await patch(refClash, body);
    check(`${label} -> ${expected}`, r.status === expected, `got ${r.status} ${JSON.stringify(r.body)}`);
  }

  const unknownRef = await patch("ZZZZZZ", { action: "confirm" });
  check("unknown reference -> 404", unknownRef.status === 404, `got ${unknownRef.status}`);
  const junkRef = await patch("!!!", { action: "confirm" });
  check("junk reference -> 404", junkRef.status === 404, `got ${junkRef.status}`);
  check("404 mentions no internal detail", /booking reference/i.test(unknownRef.body.error || ""), JSON.stringify(unknownRef.body));

  const lower = await patch(refConfirm.toLowerCase(), { action: "confirm" });
  check("a lower-case reference still resolves", lower.status === 200, `got ${lower.status}`);

  console.log("\n=== 8. Responses leak nothing ===");
  const leaky = [c1, cp, rp, rc, unknownRef, clash];
  for (const r of leaky) {
    const text = JSON.stringify(r.body);
    check(`no internal id in the ${r.status} response`, !/"id"\s*:/.test(text), text.slice(0, 160));
    check(`no phone number in the ${r.status} response`, !text.includes("0500000001"), text.slice(0, 160));
    check(`no private note in the ${r.status} response`, !text.includes("private note"), text.slice(0, 160));
    check(`no admin key in the ${r.status} response`, !text.includes(TEST_KEY));
  }
  const errText = JSON.stringify([unknownRef.body, clash.body, (await patch(refClash, { action: "nope" })).body]);
  check("no SQL or stack traces in error bodies", !/(SELECT|UPDATE|INSERT|at\s+\w+\s+\()/i.test(errText), errText.slice(0, 200));

  console.log("\n=== 9. Patient endpoints are unchanged ===");
  const refPatient = await book({ date: day2, time: slots[10], status: "confirmed" });
  const wrongPhone = await store
    .rescheduleAppointment({ phone: "0509999999", ref: refPatient, newDate: day2, newTime: slots[11] })
    .then(() => null, (e) => e);
  check("patients still need phone + reference to reschedule", wrongPhone && wrongPhone.status === 404, String(wrongPhone && wrongPhone.message));
  const rightPhone = await store.rescheduleAppointment({
    phone: "0500000001",
    ref: refPatient,
    newDate: day2,
    newTime: slots[11],
  });
  check("the patient path still works", rightPhone.time === slots[11], JSON.stringify(rightPhone));
  check("the patient path still redacts", !("phone" in rightPhone) && !("id" in rightPhone), Object.keys(rightPhone).join(","));

  const patientCancel = await store.cancelAppointment({ phone: "0500000001", ref: refPatient });
  check("the patient cancel path still works", patientCancel.status === "cancelled");
  const doubleCancel = await store
    .cancelAppointment({ phone: "0500000001", ref: refPatient })
    .then(() => null, (e) => e);
  check("patient double-cancel still 409s (unchanged behaviour)", doubleCancel && doubleCancel.status === 409, String(doubleCancel && doubleCancel.status));

  const availability = await call(`/api/availability?date=${day}`);
  check("public availability still 200", availability.status === 200);
  const publicBooking = await call("/api/appointments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Walk In", phone: "0500000002", date: day, time: slots[4] }),
  });
  check("public booking still works", publicBooking.status === 201, JSON.stringify(publicBooking.body));
  check("public booking still returns only a reference", !!publicBooking.body.reference && !publicBooking.body.appointment);

  await freshApp();
  console.log("\n=== 10. The write route shares the admin rate limiter ===");
  // The GET above and the PATCHes here draw on one bucket of 20 per 10
  // minutes, so guessing references is throttled exactly like guessing keys.
  let limited = false;
  for (let i = 0; i < 40; i++) {
    const r = await patch("ZZZZZZ", { action: "confirm" }, { "x-admin-key": WRONG_KEY });
    if (r.status === 429) { limited = true; break; }
  }
  check("PATCH is rate limited", limited, "40 unauthenticated writes were all allowed through");
  const getAfter = await call("/api/appointments", { headers: { "x-admin-key": TEST_KEY } });
  check("the admin list shares that bucket", getAfter.status === 429, `got ${getAfter.status}`);

  server.close();
  restore();
  console.log(`\n${"=".repeat(46)}\nRESULT: ${pass} passed, ${fail} failed\n${"=".repeat(46)}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  restore();
  process.exit(1);
});
