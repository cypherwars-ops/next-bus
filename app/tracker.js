// Trip logger: GPS + screen wake lock + on-phone storage (IndexedDB).
// Everything stays on the device; nothing is uploaded.
import { keepPoint } from "./logic.js";

// ---- IndexedDB: one object store "trips", keyed by trip id ----------------
const DB_NAME = "nextbus";
let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("trips", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("trips", mode);
    const result = fn(t.objectStore("trips"));
    t.oncomplete = () => resolve(result.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export const store = {
  put: (trip) => tx("readwrite", (s) => s.put(trip)),
  delete: (id) => tx("readwrite", (s) => s.delete(id)),
  all: () => tx("readonly", (s) => s.getAll()),
};

// ---- Logging session -------------------------------------------------------
// Only one trip logs at a time. Its id is remembered in localStorage so a
// reload (or Android killing the tab) resumes the same trip.
const ACTIVE_KEY = "nextbus-active-trip";
const SAVE_EVERY_MS = 15000;   // write to IndexedDB at most this often
const GAP_MS = 30000;          // silence longer than this counts as a gap

let trip = null;        // the trip being logged
let watchId = null;     // navigator.geolocation watch handle
let wakeLock = null;    // screen wake lock sentinel
let lastFix = null;     // latest raw fix (for the accuracy display)
let lastSave = 0;
let listeners = [];

export const session = {
  get trip() { return trip; },
  get lastFix() { return lastFix; },
  onChange(fn) { listeners.push(fn); },
};
const changed = () => listeners.forEach((fn) => fn());

/** Start logging a new trip. `sched` describes the timetable trip, or null. */
export async function startTrip(dir, sched) {
  if (trip) return;
  const now = Date.now();
  trip = { id: new Date(now).toISOString(), dir, sched, start: now, end: null,
           points: [], marks: [], gaps: [] };
  try { localStorage.setItem(ACTIVE_KEY, trip.id); } catch {}
  // Ask Android not to evict our storage when space runs low.
  try { await navigator.storage?.persist?.(); } catch {}
  await store.put(trip);
  begin();
}

/** Resume an unfinished trip after a reload. Returns true if one was found. */
export async function resumeTrip() {
  let id = null;
  try { id = localStorage.getItem(ACTIVE_KEY); } catch {}
  if (!id) return false;
  const all = await store.all();
  const found = all.find((t) => t.id === id && !t.end);
  if (!found) { clearActive(); return false; }
  trip = found;
  const lastT = trip.points.at(-1)?.[0] ?? trip.start;
  if (Date.now() - lastT > GAP_MS) trip.gaps.push({ from: lastT, to: Date.now() });
  begin();
  return true;
}

/** Drop a pin at the current position (e.g. a bus stop). */
export async function markStop(label) {
  if (!trip || !lastFix) return false;
  trip.marks.push({ t: Date.now(), lat: lastFix[1], lon: lastFix[2],
                    label: label || `Stop ${trip.marks.length + 1}` });
  await save(true);
  return true;
}

/** Finish the trip: record the end time, stop GPS, release the screen. */
export async function endTrip() {
  if (!trip) return;
  trip.end = Date.now();
  await save(true);
  stopSensors();
  trip = null;
  clearActive();
  changed();
}

/** Throw away the trip being logged (e.g. started by mistake). */
export async function cancelTrip() {
  if (!trip) return;
  const id = trip.id;
  stopSensors();
  trip = null;
  clearActive();
  await store.delete(id);
  changed();
}

// ---- internals -------------------------------------------------------------
function clearActive() { try { localStorage.removeItem(ACTIVE_KEY); } catch {} }

function begin() {
  if (!("geolocation" in navigator)) {
    alert("This browser has no GPS access.");
    return;
  }
  watchId = navigator.geolocation.watchPosition(onFix, onGpsError, {
    enableHighAccuracy: true,   // use real GPS, not just cell towers / Wi-Fi
    maximumAge: 0,
    timeout: 30000,
  });
  keepAwake();
  document.addEventListener("visibilitychange", onVisibility);
  changed();
}

function stopSensors() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  document.removeEventListener("visibilitychange", onVisibility);
}

function onFix(pos) {
  if (!trip) return;               // a late fix after endTrip()
  const c = pos.coords;
  const fix = [pos.timestamp || Date.now(),
    Math.round(c.latitude * 1e6) / 1e6,     // ~0.1 m precision is plenty
    Math.round(c.longitude * 1e6) / 1e6,
    Math.round(c.accuracy)];
  lastFix = fix;
  const last = trip.points.at(-1);
  if (last && fix[0] - last[0] > GAP_MS) trip.gaps.push({ from: last[0], to: fix[0] });
  if (keepPoint(last, fix)) {
    trip.points.push(fix);
    save(false);
  }
  changed();
}

function onGpsError(err) {
  lastFix = null;
  // 1 = permission denied: logging can't work, so tell the user.
  if (err.code === 1) alert("Location permission is off. Allow location for this app in Android settings.");
  changed();
}

async function save(force) {
  if (!trip) return;
  const now = Date.now();
  if (!force && now - lastSave < SAVE_EVERY_MS) return;
  lastSave = now;
  await store.put(trip);
}

// The screen must stay on: a web app loses GPS once the screen sleeps.
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { wakeLock = null; }
}

function onVisibility() {
  if (!trip) return;
  if (document.visibilityState === "hidden") {
    save(true);                    // app going to background: save now
  } else {
    keepAwake();                   // wake locks are dropped when hidden
  }
}
