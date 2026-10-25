// UI layer: reads settings, asks logic.js for trips, renders the list.
import { CORRIDORS, plan, fmt, summariseTrip, departureStats, toGPX,
  serviceDay, holidayName, weeklyValidTo, ymd, HOLIDAY } from "./logic.js";
import { store, session, startTrip, resumeTrip, markStop, endTrip, cancelTrip } from "./tracker.js";

// ---- settings (remembered per device; app still works if storage fails)
const DEFAULTS = {
  mode: "work",
  corridors: Object.keys(CORRIDORS),
  workStop: "CAPE TOWN",   // where you get off going to work
  homeStop: "CAPE TOWN",   // where you board going home
  offset: 0,               // minutes from Nyanga Terminus to your stop
  day: 0,                  // 0 = today, else ISO weekday to preview
  expressOnly: false,      // work: hide buses that stop at Mowbray / use the N2
  skipMowbray: false,      // home: hide buses that go via Mowbray
};
let s = { ...DEFAULTS };
try { Object.assign(s, JSON.parse(localStorage.getItem("nextbus") || "{}")); } catch {}
const save = () => { try { localStorage.setItem("nextbus", JSON.stringify(s)); } catch {} };

let data = null;
let showPast = false;
let shown = [];          // rows currently listed, so a tap can find its trip
const $ = (id) => document.getElementById(id);

// ---- controls
for (const name of Object.keys(CORRIDORS)) {
  const b = document.createElement("button");
  b.className = "chip"; b.dataset.v = name; b.textContent = name;
  $("corr").append(b);
}
$("mode").onclick = (e) => { if (e.target.dataset.v) { s.mode = e.target.dataset.v; showPast = false; update(); } };
$("corr").onclick = (e) => {
  const v = e.target.dataset.v; if (!v) return;
  const on = new Set(s.corridors);
  on.has(v) ? on.delete(v) : on.add(v);
  if (on.size) s.corridors = [...on];   // never allow zero routes
  update();
};
$("stop").onclick = (e) => {
  const v = e.target.dataset.v; if (!v) return;
  s.mode === "work" ? (s.workStop = v) : (s.homeStop = v);
  update();
};
$("express").onclick = () => {
  s.mode === "work" ? (s.expressOnly = !s.expressOnly) : (s.skipMowbray = !s.skipMowbray);
  update();
};
$("day").onchange = (e) => { s.day = Number(e.target.value); update(); };
$("offset").oninput = (e) => { s.offset = Math.max(0, Number(e.target.value) || 0); update(); };

function pressed(container, value) {
  for (const b of container.querySelectorAll("button")) {
    const v = b.dataset.v;
    b.setAttribute("aria-pressed", String(Array.isArray(value) ? value.includes(v) : v === value));
  }
}

// ---- rendering
const esc = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
// "CAPE TOWN" -> "Cape Town", but keep road codes like "NY 3A" as printed.
const title = (t) => t.split(" ").map((w) => (/\d|^NY$/.test(w) ? w
  : w[0] + w.slice(1).toLowerCase())).join(" ");

function update() {
  save();
  pressed($("mode"), s.mode);
  pressed($("corr"), s.corridors);
  const stop = s.mode === "work" ? s.workStop : s.homeStop;
  pressed($("stop"), stop);
  $("stopLabel").textContent = s.mode === "work" ? "Get off" : "Board at";
  $("day").value = String(s.day);
  $("offset").value = s.offset;
  // One filter chip, meaning depends on direction. Pointless when boarding at Mowbray.
  const filterOn = s.mode === "work" ? s.expressOnly : s.skipMowbray;
  $("express").textContent = s.mode === "work" ? "Express only" : "Skip Mowbray";
  $("express").hidden = s.mode === "home" && stop === "MOWBRAY";
  $("express").setAttribute("aria-pressed", String(filterOn));
  if (!data) return;

  const now = new Date();
  const today = serviceDay(now);         // 8 on a public holiday
  const day = s.day || today;
  const nowMin = s.day && s.day !== today ? -1 : now.getHours() * 60 + now.getMinutes();
  const dir = data.directions[s.mode === "work" ? 0 : 1];
  const rows = plan(dir, day, { mode: s.mode, stop, corridors: s.corridors, offset: s.offset,
    expressOnly: s.expressOnly, skipMowbray: s.skipMowbray && stop !== "MOWBRAY" });

  const upcoming = rows.filter((r) => r.board >= nowMin);
  const past = rows.filter((r) => r.board < nowMin);
  const dayName = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Public holiday"][day];
  const hol = !s.day && day === HOLIDAY ? holidayName(now) : null;
  $("sub").textContent = hol ? `· ${hol} (holiday timetable)` : `· ${dayName}`;

  // Big "next bus" card
  const n = upcoming[0];
  if (n && nowMin >= 0) {
    const mins = n.board - nowMin;
    const inTxt = mins < 1 ? "now" : mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)} h ${mins % 60} min`;
    $("next").innerHTML = `<div class="next">
      <div class="big">${fmt(n.board)}${n.boardExact ? "" : "<small style='font-size:1rem'>~</small>"}</div>
      <div><span class="in">${inTxt}</span> · ${tags(n)} ${arrivalText(n, stop)}</div>
      ${nextExpress(n, upcoming, nowMin, stop)}
    </div>`;
  } else {
    $("next").innerHTML = nowMin >= 0 && rows.length
      ? `<div class="next">No more buses today on these routes.</div>` : "";
  }

  // Full list
  const html = [];
  if (past.length && !showPast) html.push(`<button class="link" id="more">Show ${past.length} earlier</button>`);
  shown = showPast ? rows : upcoming;
  shown.forEach((r, i) => html.push(tripRow(r, r.board < nowMin, stop, i)));
  if (!rows.length) html.push(`<div class="empty">No buses on these routes for ${dayName}.</div>`);
  $("list").innerHTML = html.join("");
  const more = $("more"); if (more) more.onclick = () => { showPast = true; update(); };

  // Weekly PDFs carry an end date in their filename; warn once it has passed.
  const validTo = weeklyValidTo(data.sources);
  const stale = validTo && ymd(now) > validTo
    ? `<b>⚠ This timetable was published for the week ending ${validTo}. Check gabs.co.za for a newer one.</b><br>` : "";
  const eff = (dir.effective || {})[day === HOLIDAY ? "holiday" : "weekly"] || "?";
  $("foot").innerHTML = stale +
    `${esc(dir.name)} · timetable ${esc(dir.timetable_number || "")}, effective ${esc(eff)}.<br>` +
    (s.offset ? "~ times are estimates using your offset from the terminus. " : "") +
    "Times are scheduled, not live. Public holidays switch to the holiday timetable automatically. GABS: 0800 656 463.";
}

function tags(r) {
  const homeTag = s.mode === "home" && r.viaMowbray && s.homeStop !== "MOWBRAY"
    ? `<span class="tag">Via Mowbray</span>` : "";
  return (r.express ? `<span class="tag x">Express</span>` : "") + homeTag
    + r.corridors.map((c) => `<span class="tag">${esc(c)}</span>`).join("");
}

// If the very next bus isn't an Express, also point out the next one that is.
function nextExpress(n, upcoming, nowMin, stop) {
  if (s.mode !== "work" || n.express) return "";
  const x = upcoming.find((r) => r.express);
  if (!x) return `<div class="alt">No more Express buses today.</div>`;
  return `<div class="alt">Next Express: <b>${fmt(x.board)}</b> (in ${x.board - nowMin} min) · ${arrivalText(x, stop)}</div>`;
}

function arrivalText(r, stop) {
  if (s.mode === "work") {
    return r.alight !== null ? `${title(stop)} ${fmt(r.alight)}` : `passes ${title(stop)} (no time)`;
  }
  return `home ${r.alightExact ? "" : "~"}${fmt(r.alight)}`;
}

function tripRow(r, isPast, stop, i) {
  const roads = r.trip.calls.filter((c) => !c.time).map((c) => title(c.at)).join(", ");
  const note = !r.boardExact && s.mode === "home"
    ? `No time printed at ${title(stop)}; shown time is the first timed stop. ` : "";
  return `<div class="trip${isPast ? " past" : ""}" data-i="${i}">
    <div class="t">${fmt(r.board)}${r.boardExact ? "" : "~"}</div>
    <div>${tags(r)}</div>
    <div class="arr">${arrivalText(r, stop)}</div>
    <div class="via">${note}via ${esc(roads || "direct")}</div>
  </div>`;
}

// ---- trip logging UI -------------------------------------------------------
// Tap a bus in the list -> confirm -> start logging that scheduled trip.
$("list").addEventListener("click", async (e) => {
  const el = e.target.closest(".trip"); if (!el) return;
  const r = shown[Number(el.dataset.i)]; if (!r) return;
  if (session.trip) { alert("Already logging a trip. Tap 'Got off' first."); return; }
  const label = `${fmt(r.board)} ${s.mode === "work" ? "to work" : "home"}`;
  if (!confirm(`Log your trip on the ${label} bus?\n\nTap this when you board. The screen will stay on while logging.`)) return;
  await startTrip(s.mode, {
    board: fmt(r.board),
    alight: r.alight !== null ? fmt(r.alight) : null,
    express: r.express,
    corridors: r.corridors,
  });
});

function renderLogbar() {
  const tr = session.trip;
  $("logbar").hidden = !tr;
  if (!tr) return;
  const mins = Math.floor((Date.now() - tr.start) / 60000);
  const fix = session.lastFix;
  const gps = fix ? `GPS ±${fix[3]} m` : "waiting for GPS…";
  const what = tr.sched ? `${tr.sched.board} bus` : "unscheduled trip";
  $("logbar").innerHTML = `
    <div class="stat"><b>● Logging ${esc(what)}</b> · ${mins} min · ${tr.points.length} pts · ${tr.marks.length} stop${tr.marks.length === 1 ? "" : "s"} · ${gps}</div>
    <div class="row">
      <button class="pin" id="pinBtn">📍 Stop here</button>
      <button class="off" id="offBtn">Got off</button>
      <button class="x" id="xBtn" title="Discard">✕</button>
    </div>`;
  $("pinBtn").onclick = async () => {
    const name = prompt("Name this stop (optional):", "");
    if (name === null) return;
    if (!(await markStop(name.trim()))) alert("No GPS fix yet. Try again in a moment.");
    renderLogbar();
  };
  $("offBtn").onclick = async () => { await endTrip(); if (!$("tripsView").hidden) renderTrips(); };
  $("xBtn").onclick = async () => { if (confirm("Discard this trip log?")) await cancelTrip(); };
}
session.onChange(renderLogbar);
setInterval(() => session.trip && renderLogbar(), 15_000); // tick the minute counter

// ---- "My trips" screen
$("tripsBtn").onclick = () => {
  const open = $("tripsView").hidden;
  $("tripsView").hidden = !open;
  $("planner").hidden = open;
  $("tripsBtn").textContent = open ? "Timetable" : "My trips";
  if (open) renderTrips();
};

const signed = (n) => (n === null ? "" : n > 0 ? `<span class="late">+${n} min</span>`
  : n < 0 ? `<span class="early">${n} min</span>` : "on time");

async function renderTrips() {
  const trips = (await store.all()).filter((t) => t.end).sort((a, b) => b.start - a.start);
  const stats = departureStats(trips);
  const dirName = (d) => (d === "work" ? "To work" : "Home");
  const html = [];

  html.push(`<h2>Usual times</h2><div class="card">`);
  if (!stats.length) html.push(`<div class="empty">Log a few trips and averages per departure appear here.</div>`);
  for (const st of stats) {
    html.push(`<div class="logged">
      <div><b>${dirName(st.dir)} ${st.board}</b> ${st.express ? '<span class="tag x">Express</span>' : ""}
        <span class="meta">· ${st.n} trip${st.n > 1 ? "s" : ""}</span></div>
      <div class="meta">Usually arrives <b>${st.avgArrive}</b> ${st.avgAlightLate !== null ? `(${signed(st.avgAlightLate)} vs timetable)` : ""} · ${st.avgDuration} min on the bus</div>
    </div>`);
  }
  html.push(`</div>`);

  html.push(`<h2>Logged trips</h2><div class="card">`);
  if (!trips.length) html.push(`<div class="empty">No trips yet. In the timetable, tap the bus you're boarding.</div>`);
  for (const tr of trips) {
    const sm = summariseTrip(tr);
    const day = new Date(tr.start).toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" });
    const clock = (ms) => new Date(ms).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
    html.push(`<div class="logged">
      <div><b>${day}</b> · ${dirName(tr.dir)} ${tr.sched ? esc(tr.sched.board) : "(unscheduled)"}</div>
      <div class="meta">Boarded ${clock(tr.start)} ${signed(sm.boardLate)} · off ${clock(tr.end)} ${signed(sm.alightLate)}</div>
      <div class="meta">${sm.durationMin} min · ${sm.distanceKm} km · ${tr.points.length} pts · ${tr.marks.length} stop${tr.marks.length === 1 ? "" : "s"}${sm.gapMin ? ` · ${sm.gapMin} min GPS gap` : ""}</div>
      <div class="acts">
        <button class="chip" data-gpx="${esc(tr.id)}">GPX</button>
        <button class="chip" data-del="${esc(tr.id)}">Delete</button>
      </div>
    </div>`);
  }
  html.push(`</div>`);

  html.push(`<h2>Backup</h2><div class="row">
    <button class="chip" id="unschedBtn">Log trip without timetable</button>
    <button class="chip" id="exportBtn">Export all (JSON)</button>
    <label class="chip">Import<input id="importIn" type="file" accept=".json,application/json" hidden></label>
  </div>
  <p class="note">Trips are stored only on this phone. Export a backup now and then: uninstalling the app or clearing Chrome's data deletes them.</p>`);

  $("tripsView").innerHTML = html.join("");
  $("tripsView").onclick = async (e) => {
    const g = e.target.dataset.gpx, d = e.target.dataset.del;
    if (g) {
      const tr = trips.find((x) => x.id === g);
      download(`nextbus-${tr.id.slice(0, 16).replace(/[:T]/g, "-")}.gpx`, toGPX(tr), "application/gpx+xml");
    } else if (d && confirm("Delete this trip log?")) {
      await store.delete(d); renderTrips();
    }
  };
  $("unschedBtn").onclick = async () => {
    if (session.trip) { alert("Already logging a trip."); return; }
    if (confirm(`Start logging an unscheduled ${s.mode === "work" ? "to-work" : "home"} trip now?`)) await startTrip(s.mode, null);
  };
  $("exportBtn").onclick = async () => {
    const all = await store.all();
    download(`nextbus-trips-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(all), "application/json");
  };
  $("importIn").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const list = JSON.parse(await file.text());
      for (const tr of list) if (tr.id && tr.points) await store.put(tr);
      alert(`Imported ${list.length} trips.`);
    } catch { alert("That file isn't a Next Bus backup."); }
    renderTrips();
  };
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- data + offline
try { data = await (await fetch("timetable.json")).json(); } catch { /* offline + no cache */ }
update();
resumeTrip().catch(() => {});
setInterval(update, 30_000); // keep the countdown fresh

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
