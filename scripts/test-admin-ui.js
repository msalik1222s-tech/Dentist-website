// Admin dashboard suite: public/admin.html against the real API.
//
//   npm run test:admin-ui
//
// There is no browser and no test framework here, so the page's own script is
// extracted from admin.html and run in a vm context against a small DOM double
// (below). The script is never copied into this file — it is read from the
// page, so a change to admin.html is a change to what these tests exercise.
// fetch is real and points at a real server on loopback, so responses come
// from backend/app.js rather than from a mock.
//
// What the double cannot tell you: layout, CSS, and whether a click actually
// lands on the button. Those are for a browser. What it does tell you is that
// the right request goes out, the right row changes, and nothing renders a
// patient's name as markup.
//
// Runs on the JSON-file driver against a scratch data file, which is backed up
// and restored. The admin key is generated per run and never printed.

const path = require("path");
const fs = require("fs");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const PAGE = path.join(ROOT, "public", "admin.html");
const DATA_FILE = path.join(ROOT, "backend", "data", "appointments.json");

delete process.env.DATABASE_URL;
delete process.env.TRUST_PROXY;
delete process.env.SMTP_HOST;
delete process.env.CLINIC_EMAIL;

const TEST_KEY = "test-key-" + Math.random().toString(36).slice(2, 12);
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

// ---------------------------------------------------------------------------
// The DOM double
// ---------------------------------------------------------------------------

function El(tag) {
  this.tagName = String(tag || "").toUpperCase();
  this.attrs = {};
  this.childNodes = [];
  this.listeners = {};
  this._text = "";
  this.className = "";
  this.hidden = false;
  this.disabled = false;
  this.value = "";
  this.open = false;
}
Object.defineProperty(El.prototype, "textContent", {
  get() {
    if (this.childNodes.length) return this.childNodes.map((c) => c.textContent).join("");
    return this._text;
  },
  set(v) {
    this.childNodes = [];
    this._text = String(v);
  },
});
El.prototype.appendChild = function (child) {
  if (this._text !== "") {
    const text = new El("#text");
    text._text = this._text;
    this._text = "";
    this.childNodes.push(text);
  }
  this.childNodes.push(child);
  return child;
};
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
El.prototype.getAttribute = function (k) {
  return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
};
El.prototype.removeAttribute = function (k) { delete this.attrs[k]; };
El.prototype.addEventListener = function (ev, fn) {
  (this.listeners[ev] = this.listeners[ev] || []).push(fn);
};
El.prototype.click = function () {
  const e = { currentTarget: this, target: this };
  (this.listeners.click || []).forEach((fn) => fn(e));
};
El.prototype.dispatch = function (ev, extra) {
  const e = Object.assign({ currentTarget: this, target: this }, extra || {});
  (this.listeners[ev] || []).forEach((fn) => fn(e));
};
El.prototype.focus = function () {};
El.prototype.showModal = function () { this.open = true; };
El.prototype.close = function () { this.open = false; };
El.prototype.descendants = function (out) {
  const acc = out || [];
  for (const child of this.childNodes) {
    acc.push(child);
    child.descendants(acc);
  }
  return acc;
};

// A page instance: fresh elements, fresh script run — the equivalent of
// reloading the browser tab.
let currentPage = null;

function newPage(baseUrlRef, opts) {
  const html = fs.readFileSync(PAGE, "utf8");
  const options = opts || {};

  const byId = {};
  for (const m of html.matchAll(/<([a-z]+)([^>]*)id="([^"]+)"([^>]*)>/g)) {
    const el = new El(m[1]);
    el.hidden = /shidden(s|$)/.test(m[2] + m[4]);
    byId[m[3]] = el;
  }
  byId.rows = new El("tbody");
  byId.load = new El("button");
  byId.refresh = new El("button");
  byId.key = new El("input");
  byId.newDate = new El("input");
  byId.newTime = new El("select");
  byId.rescheduleDialog = new El("dialog");

  // The filter buttons as the static HTML declares them, in document order.
  const filters = [];
  for (const m of html.matchAll(/class="filter" data-filter="([a-z]+)"/g)) {
    const b = new El("button");
    b.className = "filter";
    b.setAttribute("data-filter", m[1]);
    filters.push(b);
  }

  const requests = [];
  const document = {
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => new El(tag),
    querySelectorAll(selector) {
      if (selector === ".filter") return filters;
      if (selector === "#rows button, #refresh, #load") {
        return byId.rows.descendants().filter((el) => el.tagName === "BUTTON")
          .concat([byId.refresh, byId.load]);
      }
      throw new Error("the DOM double does not model the selector: " + selector);
    },
  };

  const storage = new Map();
  if (options.savedKey) storage.set("adminKey", options.savedKey);


  const ctx = {
    document,
    console,
    Date,
    setTimeout,
    sessionStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    confirm: (message) => {
      page.confirmations.push(message);
      return page.confirmAnswer;
    },
    fetch: (url, init) => {
      requests.push({ url, init: init || {} });
      const delay = page.delayNextRequest;
      page.delayNextRequest = 0;
      const send = () => fetch(baseUrlRef.value + url, init);
      const p = delay ? new Promise((r) => setTimeout(r, delay)).then(send) : send();
      page.pending.push(p);
      return p;
    },
  };

  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const page = {
    el: byId,
    filters,
    requests,
    storage,
    confirmations: [],
    confirmAnswer: true,
    delayNextRequest: 0,
    pending: [],
    rowCells() {
      return byId.rows.childNodes.map((tr) => tr.childNodes.map((td) => td.textContent));
    },
    rowButtons(rowIndex) {
      const tr = byId.rows.childNodes[rowIndex];
      return tr ? tr.descendants().filter((el) => el.tagName === "BUTTON") : [];
    },
    buttonLabels(rowIndex) {
      return this.rowButtons(rowIndex).map((b) => b.textContent);
    },
    rowFor(ref) {
      const rows = byId.rows.childNodes;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].childNodes[0] && rows[i].childNodes[0].textContent.indexOf(ref) === 0) return i;
      }
      return -1;
    },
    clickButton(ref, label) {
      const i = this.rowFor(ref);
      const b = this.rowButtons(i).find((x) => x.textContent === label);
      if (!b) throw new Error(`no "${label}" button on the row for ${ref}`);
      b.click();
      return b;
    },
    run: () => vm.runInNewContext(script, ctx),
  };
  currentPage = page;
  page.run();
  return page;
}

// ---------------------------------------------------------------------------

// Waits for whatever the page actually set in motion: each round of pending
// requests is drained, then a tick lets the .then chains that follow it run,
// which can start more requests. A fixed sleep would be a race.
async function settle() {
  for (let round = 0; round < 20; round++) {
    const inFlight = currentPage.pending.splice(0);
    if (!inFlight.length) break;
    await Promise.allSettled(inFlight);
    await new Promise((r) => setTimeout(r, 15));
  }
  await new Promise((r) => setTimeout(r, 15));
}
const baseUrl = { value: "" };

let PORT = 8840;
let server = null;
async function freshServer() {
  if (server) await new Promise((r) => server.close(r));
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join(ROOT, "backend"))) delete require.cache[k];
  }
  const { createApp } = require(path.join(ROOT, "backend", "app"));
  const app = createApp({ serveStatic: true });
  PORT += 1;
  baseUrl.value = `http://127.0.0.1:${PORT}`;
  server = await new Promise((r) => {
    const s = app.listen(PORT, "127.0.0.1", () => r(s));
  });
}

async function book({ date, time, status, name }) {
  const appt = await store.createAppointment({
    name: name || "Test Patient",
    phone: "0500000001",
    service: "Teeth Whitening",
    date,
    time,
    message: "please call before",
    source: "form",
    status,
  });
  return appt.ref;
}

async function main() {
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
  await freshServer();

  const today = store.getClinicNow().dateStr;
  const day = new Date(Date.parse(today + "T00:00:00Z") + 8 * 86400000).toISOString().slice(0, 10);
  const day2 = new Date(Date.parse(today + "T00:00:00Z") + 9 * 86400000).toISOString().slice(0, 10);
  const slots = await store.getAvailableSlots(day);

  const refPending = await book({ date: day, time: slots[0], status: "pending" });
  const refConfirmed = await book({ date: day, time: slots[1], status: "confirmed" });
  const refCancelled = await book({ date: day, time: slots[2], status: "pending" });
  await store.adminCancelAppointment(refCancelled);
  const refXss = await book({ date: day, time: slots[3], status: "pending", name: '<img src=x onerror="alert(1)">' });

  console.log("\n=== 1. Loading the list ===");
  let page = newPage(baseUrl);
  page.el.key.value = TEST_KEY;
  page.el.load.click();
  await settle();

  check("the table is shown after a successful load", page.el.results.hidden === false);
  check("the filter toolbar is shown", page.el.toolbar.hidden === false);
  check("every appointment is rendered", page.el.rows.childNodes.length === 4, `${page.el.rows.childNodes.length} rows`);
  check("the status line reports the count", /4 appointment\(s\) loaded\./.test(page.el.status.textContent), page.el.status.textContent);

  const row = page.rowCells()[page.rowFor(refPending)];
  check("the row has all eight columns", row.length === 8, `${row.length} columns`);
  check("reference is shown", row[0].indexOf(refPending) === 0, row[0]);
  check("patient name is shown", row[1].indexOf("Test Patient") === 0, row[1]);
  check("phone is shown", row[2] === "0500000001", row[2]);
  check("service is shown", row[3] === "Teeth Whitening", row[3]);
  check("date is shown", row[4] === day, row[4]);
  check("time is shown", row[5] === slots[0], row[5]);
  check("status is shown", row[6] === "pending", row[6]);

  console.log("\n=== 2. Which actions each status offers ===");
  check("pending: Confirm, Reschedule, Cancel", page.buttonLabels(page.rowFor(refPending)).join(",") === "Confirm,Reschedule,Cancel", page.buttonLabels(page.rowFor(refPending)).join(","));
  check("confirmed: Reschedule, Cancel (no Confirm)", page.buttonLabels(page.rowFor(refConfirmed)).join(",") === "Reschedule,Cancel", page.buttonLabels(page.rowFor(refConfirmed)).join(","));
  check("cancelled: no actions", page.buttonLabels(page.rowFor(refCancelled)).length === 0, page.buttonLabels(page.rowFor(refCancelled)).join(","));

  console.log("\n=== 3. Patient data is text, never markup ===");
  const xssRow = page.el.rows.childNodes[page.rowFor(refXss)];
  const nameCell = xssRow.childNodes[1];
  check("the name renders verbatim as text", nameCell.textContent.indexOf('<img src=x onerror="alert(1)">') === 0, nameCell.textContent);
  check("no element was created from it", nameCell.descendants().every((el) => el.tagName === "SPAN" || el.tagName === "#TEXT"), nameCell.descendants().map((e) => e.tagName).join(","));
  check("the page still escapes when it builds markup", /function escapeHtml/.test(fs.readFileSync(PAGE, "utf8")));

  console.log("\n=== 4. Filters ===");
  const labels = page.filters.map((f) => f.textContent);
  check("filter labels carry counts", labels.join(" ") === "All (4) Pending (2) Confirmed (1) Cancelled (1)", labels.join(" "));
  check("All is pressed by default", page.filters[0].getAttribute("aria-pressed") === "true");

  page.filters[1].click();
  check("Pending shows only pending rows", page.el.rows.childNodes.length === 2, `${page.el.rows.childNodes.length} rows`);
  check("Pending is now the pressed filter", page.filters[1].getAttribute("aria-pressed") === "true" && page.filters[0].getAttribute("aria-pressed") === "false");

  page.filters[2].click();
  check("Confirmed shows one row", page.el.rows.childNodes.length === 1);
  check("and it is the confirmed one", page.rowFor(refConfirmed) === 0);

  page.filters[3].click();
  check("Cancelled shows one row", page.el.rows.childNodes.length === 1 && page.rowFor(refCancelled) === 0);

  page.filters[0].click();
  check("All shows everything again", page.el.rows.childNodes.length === 4);

  console.log("\n=== 5. Confirm ===");
  page.confirmAnswer = false;
  page.requests.length = 0;
  page.clickButton(refPending, "Confirm");
  await settle();
  check("declining the browser prompt sends nothing", page.requests.length === 0, JSON.stringify(page.requests.map((r) => r.url)));
  check("the prompt named the appointment", page.confirmations[0].indexOf(refPending) > -1, page.confirmations[0]);

  page.confirmAnswer = true;
  page.requests.length = 0;
  page.clickButton(refPending, "Confirm");
  await settle();
  const confirmReq = page.requests[0];
  check("one PATCH is sent", page.requests.length === 1 && confirmReq.init.method === "PATCH", JSON.stringify(page.requests.map((r) => r.url + " " + (r.init.method || "GET"))));
  check("to the reference's own URL", confirmReq.url === "/api/appointments/" + refPending, confirmReq.url);
  check('with body {"action":"confirm"}', confirmReq.init.body === JSON.stringify({ action: "confirm" }), String(confirmReq.init.body));
  check("the key travels in the header", confirmReq.init.headers["x-admin-key"] === TEST_KEY);
  check("the row now reads confirmed", page.rowCells()[page.rowFor(refPending)][6] === "confirmed", page.rowCells()[page.rowFor(refPending)][6]);
  check("the Confirm button is gone from that row", page.buttonLabels(page.rowFor(refPending)).indexOf("Confirm") === -1);
  check("a success message is shown", /confirmed\./.test(page.el.status.textContent) && page.el.status.className === "success", page.el.status.textContent + " / " + page.el.status.className);
  check("the filter counts followed the change", page.filters[1].textContent === "Pending (1)", page.filters[1].textContent);
  check("the server agrees", (await store.loadAppointments()).find((a) => a.ref === refPending).status === "confirmed");

  console.log("\n=== 6. Cancel frees the slot ===");
  await freshServer(); // a clean rate-limit allowance
  page = newPage(baseUrl, { savedKey: TEST_KEY });
  await settle();
  check("a saved key loads the list automatically", page.el.rows.childNodes.length === 4, `${page.el.rows.childNodes.length} rows`);

  check("the slot is taken before cancelling", !(await store.getAvailableSlots(day)).includes(slots[1]));
  page.requests.length = 0;
  page.clickButton(refConfirmed, "Cancel");
  await settle();
  check('the body is {"action":"cancel"}', page.requests[0].init.body === JSON.stringify({ action: "cancel" }), String(page.requests[0].init.body));
  check("the row now reads cancelled", page.rowCells()[page.rowFor(refConfirmed)][6] === "cancelled");
  check("the row offers no further actions", page.buttonLabels(page.rowFor(refConfirmed)).length === 0);
  check("the slot is free again", (await store.getAvailableSlots(day)).includes(slots[1]), `${day} ${slots[1]} still taken`);

  console.log("\n=== 7. Reschedule ===");
  await freshServer();
  page = newPage(baseUrl, { savedKey: TEST_KEY });
  await settle();

  page.clickButton(refXss, "Reschedule");
  await settle();
  check("the dialog opens", page.el.rescheduleDialog.open === true);
  check("it names the appointment", page.el.dialogFor.textContent.indexOf(refXss) === 0, page.el.dialogFor.textContent);
  check("the date defaults to the current one", page.el.newDate.value === day, page.el.newDate.value);
  check("open times are offered for that date", page.el.newTime.childNodes.length > 1, `${page.el.newTime.childNodes.length} options`);

  page.el.newDate.value = day2;
  page.el.newDate.dispatch("change");
  await settle();
  const offered = page.el.newTime.childNodes.map((o) => o.value);
  check("changing the date reloads the times", offered.length > 1 && offered.indexOf("") === -1, offered.slice(0, 3).join(","));

  page.el.newTime.value = offered[0];
  page.requests.length = 0;
  page.el.dialogSave.click();
  await settle();
  const resReq = page.requests[0];
  check("the reschedule body carries action, date and time", resReq.init.body === JSON.stringify({ action: "reschedule", date: day2, time: offered[0] }), String(resReq.init.body));
  check("the dialog closes on success", page.el.rescheduleDialog.open === false);
  check("the row shows the new date", page.rowCells()[page.rowFor(refXss)][4] === day2, page.rowCells()[page.rowFor(refXss)][4]);
  check("the row shows the new time", page.rowCells()[page.rowFor(refXss)][5] === offered[0]);
  check("the status is unchanged by a move", page.rowCells()[page.rowFor(refXss)][6] === "pending");
  check("the old slot is free again", (await store.getAvailableSlots(day)).includes(slots[3]));

  console.log("\n=== 8. A taken slot is reported, not swallowed ===");
  const blocker = await book({ date: day2, time: offered[1], status: "confirmed" });
  page.clickButton(refPending, "Reschedule");
  await settle();
  page.el.newDate.value = day2;
  page.el.newDate.dispatch("change");
  await settle();
  // Ask for the slot the blocker just took — it is no longer in the list, so
  // this is exactly the race a receptionist hits with a stale page.
  page.el.newTime.value = offered[1];
  page.el.dialogSave.click();
  await settle();
  check("the dialog stays open", page.el.rescheduleDialog.open === true);
  check("the dialog explains the clash", /already booked/i.test(page.el.dialogError.textContent), page.el.dialogError.textContent);
  check("the appointment did not move", (await store.loadAppointments()).find((a) => a.ref === refPending).date === day, "it moved");
  check("the blocker still holds its slot", (await store.loadAppointments()).find((a) => a.ref === blocker).time === offered[1]);

  page.el.dialogCancel.click();
  check("closing the dialog works", page.el.rescheduleDialog.open === false);

  console.log("\n=== 9. Missing and rejected keys ===");
  await freshServer();
  page = newPage(baseUrl);
  page.el.load.click();
  await settle();
  check("no key entered -> asks for one, sends nothing", page.requests.length === 0 && /Enter the admin key/i.test(page.el.status.textContent), page.el.status.textContent);

  page.el.key.value = "not-the-admin-key";
  page.el.load.click();
  await settle();
  check("a wrong key -> the 401 is explained", /rejected/i.test(page.el.status.textContent), page.el.status.textContent);
  check("the error is styled as an error", page.el.status.className === "error");
  check("the table is hidden again", page.el.results.hidden === true);
  check("the rejected key is dropped from session storage", page.storage.get("adminKey") === undefined, String(page.storage.get("adminKey")));

  page.el.key.value = TEST_KEY;
  page.el.load.click();
  await settle();
  check("the right key recovers", page.el.results.hidden === false && page.el.rows.childNodes.length === 5, `${page.el.rows.childNodes.length} rows`);

  console.log("\n=== 10. Controls are disabled while a request is in flight ===");
  page.delayNextRequest = 120;
  const busyRow = page.rowFor(refCancelled) === 0 ? 1 : 0;
  const someButton = page.rowButtons(busyRow)[0];
  page.el.refresh.click();
  check("Refresh is disabled during the request", page.el.refresh.disabled === true);
  check("Load is disabled during the request", page.el.load.disabled === true);
  if (someButton) check("row action buttons are disabled during the request", someButton.disabled === true);
  await new Promise((r) => setTimeout(r, 260));
  check("everything is re-enabled afterwards", page.el.refresh.disabled === false && page.el.load.disabled === false);

  console.log("\n=== 11. The key never leaves the header ===");
  const urls = page.requests.map((r) => r.url).join(" ");
  check("no request URL contains the key", urls.indexOf(TEST_KEY) === -1);
  check("no request URL carries a key parameter", !/[?&]key=/.test(urls), urls);
  const bodies = page.requests.map((r) => String(r.init.body || "")).join(" ");
  check("no request body contains the key", bodies.indexOf(TEST_KEY) === -1);
  check("the key is never rendered in the table", page.el.rows.textContent.indexOf(TEST_KEY) === -1);
  check("the key is never rendered in the status line", page.el.status.textContent.indexOf(TEST_KEY) === -1);

  const pageSource = fs.readFileSync(PAGE, "utf8");
  check("admin.html sends the key as a header", /"x-admin-key"/.test(pageSource));
  check("admin.html builds no URL with a key in it", !/[?&]key=/.test(pageSource));
  check("admin.html logs nothing", !/console\.(log|info|warn|error)/.test(pageSource));
  check("admin.html keeps the noindex directive", /noindex/.test(pageSource));

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
