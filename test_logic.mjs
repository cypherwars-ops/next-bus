// Quick checks of app/logic.js against known trips in the PDF.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { plan, fmt } from "./app/logic.js";

const data = JSON.parse(readFileSync("app/timetable.json", "utf8"));
const [toWork, home] = data.directions;
const all = ["NY 108", "Steve Biko (NY1)"];

// Friday, to Cape Town, NY 108 only: the 07:00b trip arrives 08:50.
let rows = plan(toWork, 5, { mode: "work", stop: "CAPE TOWN", corridors: ["NY 108"], offset: 0 });
assert.ok(rows.some((r) => fmt(r.board) === "07:00" && fmt(r.alight) === "08:50"));
// ...and the Mon-Thu 07:00a (arr 08:30) must NOT appear on a Friday,
// except the plain weekday 07:00 which also arrives 08:30.
assert.equal(rows.filter((r) => fmt(r.board) === "07:00").length, 2);

// 05:50 weekday terminates at Mowbray: absent for Cape Town, present for Mowbray.
rows = plan(toWork, 1, { mode: "work", stop: "CAPE TOWN", corridors: all, offset: 0 });
assert.ok(!rows.some((r) => fmt(r.board) === "05:50"));
rows = plan(toWork, 1, { mode: "work", stop: "MOWBRAY", corridors: all, offset: 0 });
assert.ok(rows.some((r) => fmt(r.board) === "05:50" && fmt(r.alight) === "06:45"));

// Steve Biko corridor picks up the NY 3A-only 06:00 trip.
rows = plan(toWork, 2, { mode: "work", stop: "CAPE TOWN", corridors: ["Steve Biko (NY1)"], offset: 0 });
assert.ok(rows.some((r) => fmt(r.board) === "06:00"));

// Offset shifts boarding time: 05:00 departure + 7 min.
rows = plan(toWork, 3, { mode: "work", stop: "CAPE TOWN", corridors: ["NY 108"], offset: 7 });
assert.equal(fmt(rows[0].board), "05:07");

// Home, Mon, board Cape Town via Steve Biko: 14:00a via NY 3/3A -> 15:20.
rows = plan(home, 1, { mode: "home", stop: "CAPE TOWN", corridors: ["Steve Biko (NY1)"], offset: 0 });
assert.ok(rows.some((r) => fmt(r.board) === "14:00" && fmt(r.alight) === "15:20"));

// Sunday home: exactly one bus.
rows = plan(home, 7, { mode: "home", stop: "CAPE TOWN", corridors: all, offset: 0 });
assert.equal(rows.length, 1);

console.log("all logic tests passed");

// Express = no Mowbray, no N2. Weekday mornings: 06:30, 06:40, 07:10 via NY 108.
rows = plan(toWork, 2, { mode: "work", stop: "CAPE TOWN", corridors: all, offset: 0, expressOnly: true });
assert.deepEqual(rows.map((r) => fmt(r.board)), ["06:30", "06:40", "07:10", "08:10"]);
assert.ok(rows.every((r) => r.express && fmt(r.alight) <= "09:35"));
console.log("express tests passed");

// Homebound: never Express; skipMowbray drops via-Mowbray trips.
rows = plan(home, 1, { mode: "home", stop: "CAPE TOWN", corridors: all, offset: 0 });
assert.ok(rows.every((r) => !r.express));
const direct = plan(home, 1, { mode: "home", stop: "CAPE TOWN", corridors: all, offset: 0, skipMowbray: true });
assert.ok(direct.length > 0 && direct.every((r) => !r.viaMowbray));
assert.ok(direct.some((r) => fmt(r.board) === "06:20" && fmt(r.alight) === "07:10"));
// Mowbray 15:30 a and b both reach Nyanga 16:15 (Mon and Fri).
for (const d of [1, 5]) {
  rows = plan(home, d, { mode: "home", stop: "MOWBRAY", corridors: all, offset: 0 });
  assert.ok(rows.some((r) => fmt(r.board) === "15:30" && fmt(r.alight) === "16:15"), `day ${d}`);
}
console.log("homebound tests passed");

// ---- trip logging maths
import { distanceM, keepPoint, summariseTrip, departureStats, toGPX } from "./app/logic.js";

// Nyanga terminus -> Cape Town is roughly 17 km as the crow flies.
const d = distanceM(-33.9946, 18.5803, -33.9249, 18.4241);
assert.ok(d > 15000 && d < 19000, `distance ${d}`);

// keepPoint: drop inaccurate, keep after 5 s or 25 m.
const p0 = [0, -33.99, 18.58, 10];
assert.equal(keepPoint(null, p0), true);
assert.equal(keepPoint(p0, [2000, -33.99, 18.58, 10]), false);      // too soon, not moved
assert.equal(keepPoint(p0, [6000, -33.99, 18.58, 10]), true);       // 6 s later
assert.equal(keepPoint(p0, [1000, -33.9897, 18.58, 10]), true);     // ~33 m moved
assert.equal(keepPoint(p0, [9000, -33.99, 18.58, 400]), false);     // poor accuracy

// A fake logged trip: scheduled 06:30 -> 08:00, boarded 06:32, off 07:56.
const at = (h, m) => new Date(2026, 9, 27, h, m).getTime();
const fake = (h1, m1, h2, m2) => ({
  id: "x", dir: "work",
  sched: { board: "06:30", alight: "08:00", express: true, corridors: ["NY 108"] },
  start: at(h1, m1), end: at(h2, m2),
  points: [[at(h1, m1), -33.9946, 18.5803, 8], [at(h2, m2), -33.9249, 18.4241, 8]],
  marks: [{ t: at(7, 0), lat: -33.98, lon: 18.55, label: "My <stop>" }], gaps: [],
});
const sum = summariseTrip(fake(6, 32, 7, 56));
assert.equal(sum.durationMin, 84);
assert.equal(sum.boardLate, 2);
assert.equal(sum.alightLate, -4);

const stats = departureStats([fake(6, 32, 7, 56), fake(6, 30, 8, 4)]);
assert.equal(stats.length, 1);
assert.equal(stats[0].n, 2);
assert.equal(stats[0].avgArrive, "08:00");
assert.equal(stats[0].avgAlightLate, 0);

const gpx = toGPX(fake(6, 32, 7, 56));
assert.ok(gpx.includes("<trkpt") && gpx.includes("My &#60;stop&#62;"));
console.log("trip logging tests passed");
