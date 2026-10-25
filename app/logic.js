// Pure timetable logic: no DOM, so it can be unit-tested with node.
// Data shape comes from parse_gabs.py:
//   trip = { days: [1..7], calls: [{ at: "NY 108", time: null | "HH:MM" }] }

// Roads you can board on, grouped by how *you* experience them.
// NY 3 / NY 3A turn onto Steve Biko (NY1) before the shared stops, so
// for someone boarding on Steve Biko they are all the same bus.
// Split a group apart here if your stop is on NY 3 or NY 3A itself.
export const CORRIDORS = {
  "NY 108": ["NY 108"],
  "Steve Biko (NY1)": ["STEVE BIKO DRV", "NY 3", "NY 3A"],
};

export const TERMINUS = "NYANGA TERM";

/** "HH:MM" -> minutes after midnight. */
export function toMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** minutes after midnight -> "HH:MM". */
export function fmt(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** ISO weekday (Mon=1 .. Sun=7) for a JS Date. */
export function isoDay(date) {
  return ((date.getDay() + 6) % 7) + 1;
}

/** Corridor names this trip passes through (may be empty). */
export function corridorsOf(trip) {
  const roads = new Set(trip.calls.map((c) => c.at));
  return Object.entries(CORRIDORS)
    .filter(([, members]) => members.some((r) => roads.has(r)))
    .map(([name]) => name);
}

// Going to work, commuters call a bus an "Express" when it skips both of
// these. Homebound there's no Express: what matters is via Mowbray or not.
export const EXPRESS_SKIPS = ["MOWBRAY", "N2 FREEWAY"];

/** True when the trip runs the full route without Mowbray or the N2. */
export function isExpress(trip) {
  const roads = new Set(trip.calls.map((c) => c.at));
  return roads.has(TERMINUS) && roads.has("CAPE TOWN")
    && !EXPRESS_SKIPS.some((r) => roads.has(r));
}

function callAt(trip, stop) {
  return trip.calls.find((c) => c.at === stop);
}

/**
 * Build the list of usable trips for one direction and day.
 *
 * opts.mode    "work": board near the terminus, alight at opts.stop
 *              "home": board at opts.stop, alight near the terminus
 * opts.stop    "CAPE TOWN" | "MOWBRAY"
 * opts.corridors  corridor names to include
 * opts.offset  minutes between the terminus and your own stop
 * opts.expressOnly  (work) drop trips that aren't Express
 * opts.skipMowbray  (home) drop trips that go via Mowbray
 *
 * Returns rows sorted by boarding time:
 *   { board, alight, boardExact, alightExact, corridors, express, viaMowbray, trip }
 * board/alight are minutes (null when the PDF prints no time there).
 */
export function plan(direction, day, opts) {
  const rows = [];
  for (const trip of direction.trips) {
    if (!trip.days.includes(day)) continue;
    const corridors = corridorsOf(trip);
    if (!corridors.some((c) => opts.corridors.includes(c))) continue;
    const express = opts.mode === "work" && isExpress(trip);
    const viaMowbray = trip.calls.some((c) => c.at === "MOWBRAY");
    if (opts.mode === "work" && opts.expressOnly && !express) continue;
    if (opts.mode === "home" && opts.skipMowbray && viaMowbray) continue;

    const term = callAt(trip, TERMINUS);
    const stop = callAt(trip, opts.stop);
    if (!term || !term.time || !stop) continue;

    if (opts.mode === "work") {
      // Bus leaves the terminus, reaches your stop `offset` min later.
      rows.push({
        board: toMin(term.time) + opts.offset,
        boardExact: opts.offset === 0,
        alight: stop.time ? toMin(stop.time) : null,
        alightExact: true,
        corridors,
        express,
        viaMowbray,
        trip,
      });
    } else {
      // Bus arrives at the terminus; your stop is `offset` min before it.
      // If the boarding stop has no printed time we can't place it on the
      // clock, so fall back to the first timed stop before it.
      let board = stop.time ? toMin(stop.time) : null;
      if (board === null) {
        const first = trip.calls.find((c) => c.time);
        if (first.at === TERMINUS) continue; // never reaches our stop timed
        board = toMin(first.time);
      }
      rows.push({
        board,
        boardExact: Boolean(stop.time),
        alight: toMin(term.time) - opts.offset,
        alightExact: opts.offset === 0,
        corridors,
        express,
        viaMowbray,
        trip,
      });
    }
  }
  return rows.sort((a, b) => a.board - b.board);
}

// ---------------------------------------------------------------------------
// Trip logging maths (GPS logs recorded on the phone; see tracker.js).
// A logged trip:
//   { id, dir: "work"|"home", sched: { board, alight, express, corridors } | null,
//     start, end (epoch ms), points: [[t, lat, lon, accuracy_m]],
//     marks: [{ t, lat, lon, label }], gaps: [{ from, to }] }

const EARTH_R = 6371000; // mean Earth radius, metres

/** Great-circle distance in metres between two lat/lon points (haversine). */
export function distanceM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

/**
 * Decide whether a new GPS fix is worth storing.
 * Keeps a point every `everyMs`, or sooner if we moved `everyM` metres.
 * Drops fixes too inaccurate to be useful.
 */
export function keepPoint(last, fix, everyMs = 5000, everyM = 25, maxAcc = 150) {
  if (fix[3] > maxAcc) return false;
  if (!last) return true;
  return fix[0] - last[0] >= everyMs
    || distanceM(last[1], last[2], fix[1], fix[2]) >= everyM;
}

/** minutes after midnight (local) for an epoch-ms time. */
export function minOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/**
 * Summarise one logged trip.
 * Returns { durationMin, distanceKm, boardLate, alightLate, gapMin }
 * where *Late are minutes vs the timetable (+ late, - early, null if unknown).
 */
export function summariseTrip(trip) {
  let dist = 0;
  for (let i = 1; i < trip.points.length; i++) {
    const [, la1, lo1] = trip.points[i - 1];
    const [, la2, lo2] = trip.points[i];
    dist += distanceM(la1, lo1, la2, lo2);
  }
  const end = trip.end ?? trip.points.at(-1)?.[0] ?? trip.start;
  const s = trip.sched;
  const late = (ms, hhmm) => (s && hhmm ? Math.round(minOfDay(ms) - toMin(hhmm)) : null);
  return {
    durationMin: Math.round((end - trip.start) / 60000),
    distanceKm: Math.round(dist / 100) / 10,
    boardLate: late(trip.start, s?.board),
    alightLate: trip.end ? late(trip.end, s?.alight) : null,
    gapMin: Math.round((trip.gaps || []).reduce((m, g) => m + (g.to - g.from), 0) / 60000),
  };
}

/**
 * Group finished trips by scheduled departure and average them.
 * Returns [{ key, dir, board, express, n, avgDuration, avgArrive, avgAlightLate }]
 * sorted by direction then departure time. avgArrive is "HH:MM".
 */
export function departureStats(trips) {
  const groups = new Map();
  for (const t of trips) {
    if (!t.sched || !t.end) continue;
    const key = `${t.dir} ${t.sched.board}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return [...groups.entries()].map(([key, ts]) => {
    const sums = ts.map(summariseTrip);
    const lates = sums.map((x) => x.alightLate).filter((x) => x !== null);
    return {
      key,
      dir: ts[0].dir,
      board: ts[0].sched.board,
      express: ts.some((t) => t.sched.express),
      n: ts.length,
      avgDuration: Math.round(avg(sums.map((x) => x.durationMin))),
      avgArrive: fmt(Math.round(avg(ts.map((t) => minOfDay(t.end))))),
      avgAlightLate: lates.length ? Math.round(avg(lates)) : null,
    };
  }).sort((a, b) => a.dir.localeCompare(b.dir) || toMin(a.board) - toMin(b.board));
}

/** GPX 1.1 text for one trip: the track plus stop marks as waypoints. */
export function toGPX(trip) {
  const iso = (ms) => new Date(ms).toISOString();
  const x = (s) => String(s).replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const name = trip.sched ? `${trip.dir} ${trip.sched.board}` : `${trip.dir} unscheduled`;
  const wpts = trip.marks.map((m) =>
    `  <wpt lat="${m.lat}" lon="${m.lon}"><time>${iso(m.t)}</time><name>${x(m.label)}</name></wpt>`);
  const trkpts = trip.points.map(([t, la, lo]) =>
    `      <trkpt lat="${la}" lon="${lo}"><time>${iso(t)}</time></trkpt>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Next Bus" xmlns="http://www.topografix.com/GPX/1/1">',
    ...wpts,
    `  <trk><name>${x(name)} ${iso(trip.start).slice(0, 10)}</name><trkseg>`,
    ...trkpts,
    "  </trkseg></trk>",
    "</gpx>",
    "",
  ].join("\n");
}
