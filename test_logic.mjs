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
