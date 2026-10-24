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
