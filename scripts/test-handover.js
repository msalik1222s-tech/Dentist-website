// End-to-end handover suite: does the clinic actually get a working booking
// desk out of this?
//
//   npm run test:handover
//
// The other suites prove the admin route is guarded (test:admin) and that its
// write actions behave (test:admin-write). This one joins the two ends
// together and checks the journey a clinic depends on:
//
//   a patient books on the website  ->  the booking appears in the dashboard
//   the AI assistant books          ->  it appears in the SAME dashboard
//   staff confirm / move / cancel   ->  the change survives a server restart
//
// Runs against the JSON-file driver on a scratch data file, so it never
// touches a real database and never sends mail. The real data file is backed
// up and restored around the run. The admin key is generated per run and is
// never printed.
//
// Every booking this suite creates is named "TEST — ..." with a +0000 phone
// number, so a row that ever escaped into a real list is obvious at a glance.

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
    console.log("  PASS  " + label);
    pass++;
  } else {
    console.log("  FAIL  " + label + (detail ? "\n        " + detail : ""));
    fail++;
  }
}

// A "restart" here means exactly what it means on the server: the process
// forgets everything it held in memory and reads storage back from scratch.
// Dropping backend/* from the require cache and rebuilding the app is that,
// minus the process spawn — the JSON file (or the database) is the only thing
// that carries across. It also resets the rate-limit counters, which is what
// lets this suite make more than 20 admin calls.
let PORT = 8870;
let server = null;
let store = null;
let chatTools = null;

async function restart() {
  if (server) await new Promise((r) => server.close(r));
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join(ROOT, "backend"))) delete require.cache[k];
  }
  const { createApp } = require(path.join(ROOT, "backend", "app"));
  store = require(path.join(ROOT, "backend", "store"));
  chatTools = require(path.join(ROOT, "backend", "chat-tools"));
  const app = createApp({ serveStatic: false });
  PORT += 1;
  server = await new Promise((r) => {
    const s = app.listen(PORT, "127.0.0.1", () => r(s));
  });
}

const call = (p, opts = {}) =>
  fetch("http://127.0.0.1:" + PORT + p, opts).then(async (r) => ({
    status: r.status,
    body: (r.headers.get("content-type") || "").includes("json") ? await r.json() : await r.text(),
  }));

const adminList = (headers = { "x-admin-key": TEST_KEY }) => call("/api/appointments", { headers });

const patch = (ref, body) =>
  call("/api/appointments/" + ref, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-admin-key": TEST_KEY },
    body: JSON.stringify(body),
  });

// The website form: an ordinary POST with no key, exactly what
// public/index.html sends.
const bookViaForm = (payload) =>
  call("/api/appointments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

const rowFor = (list, ref) => (list || []).find((a) => a.ref === ref) || null;

// The columns admin.html renders. A booking that reaches the dashboard
// missing any of them is a booking a receptionist cannot act on.
const DASHBOARD_FIELDS = ["ref", "name", "phone", "service", "date", "time", "status"];

function missingFields(row) {
  if (!row) return "no row";
  const gone = DASHBOARD_FIELDS.filter((f) => row[f] === undefined || row[f] === null || row[f] === "");
  return gone.length ? gone.join(", ") + " missing" : "";
}

async function main() {
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
  await restart();

  const today = store.getClinicNow().dateStr;
  const dayOf = (n) =>
    new Date(Date.parse(today + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  const day = dayOf(9);
  const otherDay = dayOf(10);

  const open = await store.getAvailableSlots(day);
  const openOther = await store.getAvailableSlots(otherDay);
  if (open.length < 3 || openOther.length < 1) throw new Error("not enough open slots to run the suite");

  // ---------------------------------------------------------------------
  console.log("\n=== 1. An unauthorized visitor gets nothing ===");

  const noKey = await adminList({});
  check("no key -> 401", noKey.status === 401, "got " + noKey.status);
  check("no key returns no appointments", !noKey.body.appointments);

  const wrongKey = await adminList({ "x-admin-key": WRONG_KEY });
  check("wrong key -> 401", wrongKey.status === 401, "got " + wrongKey.status);
  check("wrong key returns no appointments", !wrongKey.body.appointments);
  check(
    "the 401 body says only 'Unauthorized.'",
    wrongKey.body && wrongKey.body.error === "Unauthorized." && Object.keys(wrongKey.body).length === 2
  );

  const noKeyWrite = await call("/api/appointments/ABC123", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "cancel" }),
  });
  check("an unauthorized cancel -> 401", noKeyWrite.status === 401, "got " + noKeyWrite.status);

  // ---------------------------------------------------------------------
  console.log("\n=== 2. A booking from the website form reaches the dashboard ===");

  const formBooking = {
    name: "TEST — Website Form Patient",
    phone: "+000000000001",
    service: "Teeth Whitening",
    date: day,
    time: open[0],
    message: "TEST DATA — please ignore",
  };
  const formRes = await bookViaForm(formBooking);
  check(
    "the form booking is accepted -> 201",
    formRes.status === 201,
    "got " + formRes.status + " " + JSON.stringify(formRes.body)
  );
  const formRef = formRes.body && formRes.body.reference;
  check("the patient is given a booking reference", !!formRef);
  check("the reference is the 6-character clinic format", /^[23456789A-HJ-NP-Z]{6}$/.test(formRef || ""), formRef);

  await restart(); // the admin limiter allows only 20 requests per 10 minutes
  const afterForm = await adminList();
  check("the dashboard loads -> 200", afterForm.status === 200, "got " + afterForm.status);
  const formRow = rowFor(afterForm.body.appointments, formRef);
  check("the form booking is in the dashboard list", !!formRow);
  check("it carries every column the dashboard shows", !missingFields(formRow), missingFields(formRow));
  check("the patient name is right", formRow && formRow.name === formBooking.name);
  check("the phone number is there for the callback", formRow && formRow.phone === formBooking.phone);
  check("the service is right", formRow && formRow.service === formBooking.service);
  check("the date is right", formRow && formRow.date === day);
  check("the time is right", formRow && formRow.time === open[0]);
  check("a form booking arrives as 'pending' for staff to confirm", formRow && formRow.status === "pending");
  check("the patient's note is shown to staff", formRow && formRow.message === formBooking.message);
  check("staff can see it came from the website form", formRow && formRow.source === "form");

  // ---------------------------------------------------------------------
  console.log("\n=== 3. A booking from the AI assistant reaches the SAME dashboard ===");

  // runTool is the exact entry point the chat adapters call, so this is the
  // assistant's own booking path and not a shortcut around it.
  const aiResult = await chatTools.runTool("book_appointment", {
    name: "TEST — AI Assistant Patient",
    phone: "+000000000002",
    service: "Dental Implants",
    date: day,
    time: open[1],
    message: "TEST DATA — booked via assistant",
  });
  check("the assistant's booking succeeds", aiResult && aiResult.success === true, JSON.stringify(aiResult));
  const aiRef = aiResult && aiResult.appointment && aiResult.appointment.ref;
  check("the assistant is given a reference to read out", !!aiRef);

  const afterAi = await adminList();
  const aiRow = rowFor(afterAi.body.appointments, aiRef);
  check("the assistant's booking is in the same dashboard list", !!aiRow);
  check("it too carries every dashboard column", !missingFields(aiRow), missingFields(aiRow));
  check("staff can see it came from the assistant", aiRow && aiRow.source === "chat");
  check("both bookings are in one list", afterAi.body.appointments.length === 2);
  check(
    "the two bookings hold different slots",
    formRow && aiRow && !(formRow.date === aiRow.date && formRow.time === aiRow.time)
  );

  // ---------------------------------------------------------------------
  console.log("\n=== 4. The status filters have something to filter ===");

  const statuses = afterAi.body.appointments.map((a) => a.status);
  check(
    "every row has a status the filters know",
    statuses.every((s) => ["pending", "confirmed", "cancelled"].includes(s)),
    statuses.join(",")
  );
  check("the Pending filter would show the form booking", statuses.filter((s) => s === "pending").length >= 1);

  // ---------------------------------------------------------------------
  console.log("\n=== 5. Staff confirm a booking, and it sticks ===");

  const confirmed = await patch(formRef, { action: "confirm" });
  check(
    "confirm -> 200",
    confirmed.status === 200,
    "got " + confirmed.status + " " + JSON.stringify(confirmed.body)
  );
  check("the server reports a real change", confirmed.body.changed === true);
  check("the booking is now confirmed", confirmed.body.appointment.status === "confirmed");

  await restart();
  const afterConfirm = rowFor((await adminList()).body.appointments, formRef);
  check("it is still confirmed after a restart", afterConfirm && afterConfirm.status === "confirmed");
  check("the phone number survived the change", afterConfirm && afterConfirm.phone === formBooking.phone);

  // ---------------------------------------------------------------------
  console.log("\n=== 6. Rescheduling respects availability ===");

  // The assistant's booking is sitting on open[1]. Moving the form booking
  // onto it must be refused, or the clinic has double-booked the chair.
  const clash = await patch(formRef, { action: "reschedule", date: day, time: open[1] });
  check(
    "moving onto a taken slot -> 409",
    clash.status === 409,
    "got " + clash.status + " " + JSON.stringify(clash.body)
  );
  check("the refusal explains itself to staff", /already booked/i.test((clash.body && clash.body.error) || ""));

  const listAfterClash = (await adminList()).body.appointments;
  check("the refused move changed nothing", rowFor(listAfterClash, formRef).time === open[0]);
  check("the other patient keeps their slot", rowFor(listAfterClash, aiRef).time === open[1]);

  const pastMove = await patch(formRef, { action: "reschedule", date: dayOf(-3), time: open[0] });
  check("moving into the past -> 400", pastMove.status === 400, "got " + pastMove.status);

  const badTime = await patch(formRef, { action: "reschedule", date: otherDay, time: "03:00" });
  check("moving outside clinic hours -> 400", badTime.status === 400, "got " + badTime.status);

  await restart();
  const moved = await patch(formRef, { action: "reschedule", date: otherDay, time: openOther[0] });
  check(
    "moving to a free slot -> 200",
    moved.status === 200,
    "got " + moved.status + " " + JSON.stringify(moved.body)
  );
  check("the new date stuck", moved.body.appointment.date === otherDay);
  check("the new time stuck", moved.body.appointment.time === openOther[0]);
  check("a move does not silently un-confirm the booking", moved.body.appointment.status === "confirmed");

  check("the old slot is free again", (await store.getAvailableSlots(day)).includes(open[0]));
  check("the new slot is now held", !(await store.getAvailableSlots(otherDay)).includes(openOther[0]));

  // ---------------------------------------------------------------------
  console.log("\n=== 7. Staff cancel a booking, and the slot comes back ===");

  const cancelled = await patch(aiRef, { action: "cancel" });
  check("cancel -> 200", cancelled.status === 200, "got " + cancelled.status);
  check("the booking is cancelled", cancelled.body.appointment.status === "cancelled");
  check("the cancelled slot is bookable again", (await store.getAvailableSlots(day)).includes(open[1]));

  const cancelAgain = await patch(aiRef, { action: "cancel" });
  check("a second cancel is a no-op, not an error", cancelAgain.status === 200 && cancelAgain.body.changed === false);

  const unknown = await patch("ZZZZZZ", { action: "cancel" });
  check("an unknown reference -> 404", unknown.status === 404, "got " + unknown.status);

  const nonsense = await patch(formRef, { action: "delete-everything" });
  check("an action the server does not know -> 400", nonsense.status === 400, "got " + nonsense.status);

  // ---------------------------------------------------------------------
  console.log("\n=== 8. Everything survives a restart ===");

  await restart();
  const final = await adminList();
  check("the dashboard still loads after a restart", final.status === 200);
  check("both bookings are still there", final.body.appointments.length === 2);

  const finalForm = rowFor(final.body.appointments, formRef);
  const finalAi = rowFor(final.body.appointments, aiRef);
  check("the confirmed booking kept its status", finalForm && finalForm.status === "confirmed");
  check("it kept the rescheduled date", finalForm && finalForm.date === otherDay);
  check("it kept the rescheduled time", finalForm && finalForm.time === openOther[0]);
  check("it kept its reference", finalForm && finalForm.ref === formRef);
  check("it kept the patient's phone number", finalForm && finalForm.phone === formBooking.phone);
  check("the cancelled booking is still cancelled", finalAi && finalAi.status === "cancelled");
  check("a cancelled booking is kept as a record, not deleted", !!finalAi);

  // ---------------------------------------------------------------------
  console.log("\n=== 9. The admin list is still the only way to see any of this ===");

  const sneak = await adminList({ "x-admin-key": WRONG_KEY });
  check("a wrong key still gets nothing after all of the above", sneak.status === 401 && !sneak.body.appointments);
  const asQuery = await call("/api/appointments?key=" + encodeURIComponent(TEST_KEY));
  check("the key in a query string is not accepted -> 401", asQuery.status === 401, "got " + asQuery.status);
  check("that attempt leaked no appointments", !asQuery.body.appointments);
}

main()
  .then(() => {
    console.log("\n==============================================");
    console.log("RESULT: " + pass + " passed, " + fail + " failed");
    console.log("==============================================");
  })
  .catch((err) => {
    console.error("\nSUITE ERROR:", err);
    fail++;
  })
  .then(async () => {
    if (server) await new Promise((r) => server.close(r));
    restore();
    process.exit(fail ? 1 : 0);
  });
