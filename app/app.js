// UI layer: reads settings, asks logic.js for trips, renders the list.
import { CORRIDORS, plan, fmt, isoDay } from "./logic.js";

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
  const today = isoDay(now);
  const day = s.day || today;
  const nowMin = s.day && s.day !== today ? -1 : now.getHours() * 60 + now.getMinutes();
  const dir = data.directions[s.mode === "work" ? 0 : 1];
  const rows = plan(dir, day, { mode: s.mode, stop, corridors: s.corridors, offset: s.offset,
    expressOnly: s.expressOnly, skipMowbray: s.skipMowbray && stop !== "MOWBRAY" });

  const upcoming = rows.filter((r) => r.board >= nowMin);
  const past = rows.filter((r) => r.board < nowMin);
  const dayName = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day];
  $("sub").textContent = `· ${dayName}`;

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
  for (const r of showPast ? rows : upcoming) html.push(tripRow(r, r.board < nowMin, stop));
  if (!rows.length) html.push(`<div class="empty">No buses on these routes for ${dayName}.</div>`);
  $("list").innerHTML = html.join("");
  const more = $("more"); if (more) more.onclick = () => { showPast = true; update(); };

  $("foot").innerHTML =
    `${esc(dir.name)} · timetable ${esc(dir.timetable_number || "")}, effective ${esc(dir.effective || "?")}.<br>` +
    (s.offset ? "~ times are estimates using your offset from the terminus. " : "") +
    "Times are scheduled, not live. Check public holidays with GABS (0800 656 463).";
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

function tripRow(r, isPast, stop) {
  const roads = r.trip.calls.filter((c) => !c.time).map((c) => title(c.at)).join(", ");
  const note = !r.boardExact && s.mode === "home"
    ? `No time printed at ${title(stop)}; shown time is the first timed stop. ` : "";
  return `<div class="trip${isPast ? " past" : ""}">
    <div class="t">${fmt(r.board)}${r.boardExact ? "" : "~"}</div>
    <div>${tags(r)}</div>
    <div class="arr">${arrivalText(r, stop)}</div>
    <div class="via">${note}via ${esc(roads || "direct")}</div>
  </div>`;
}

// ---- data + offline
try { data = await (await fetch("timetable.json")).json(); } catch { /* offline + no cache */ }
update();
setInterval(update, 30_000); // keep the countdown fresh

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
