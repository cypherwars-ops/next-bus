# Work Package — Next Bus (GABS Nyanga ↔ Cape Town)

Offline phone app (PWA) built from Golden Arrow's PDF timetable, route 0043.

```
bus-timetable/
├── pdfs/              source PDFs from gabs.co.za
├── parse_gabs.py      PDF -> app/timetable.json (stdlib + pdftotext only)
├── test_logic.mjs     node tests for app/logic.js against known trips
└── app/               the PWA (static files, no build step)
    ├── index.html  app.js  logic.js  sw.js  manifest.webmanifest  icon.svg
    └── timetable.json
```

Update the timetable:
`python3 parse_gabs.py pdfs/<new>.pdf -o app/timetable.json && node test_logic.mjs`
Read the trip counts and WARNING lines it prints, and update the test
expectations if GABS changed the times.

Publish: `git commit -am "..." && git push`. GitHub Actions tests, then deploys (about 30 s).

Run locally: `cd app && python3 -m http.server 8000`, then open http://localhost:8000.

## Task: Parse GABS PDF to JSON
- Status: completed
- Domain: coding
- Effort: low
- Dependencies: pdftotext (poppler-utils)
- Acceptance Criteria: trip counts match the PDF; spot-checked trips match
- Blockers / Notes: one quirk in the source PDF: a Friday 15:20b trip from Mowbray via NY 108 has no Nyanga time. Confirmed by checking the PDF's word coordinates, so it's not a parse error. The app hides it because no arrival can be computed. (The Mowbray 15:30a/b -> 16:15 trips are separate columns and parse correctly.)
- Outcome: 87 trips to Cape Town (62 weekday / 19 Sat / 6 Sun), 79 home (62 / 16 / 1). The a = Mon–Thu and b = Fri suffixes are handled.

## Task: Build PWA
- Status: completed
- Domain: coding
- Effort: medium
- Dependencies: parser output
- Acceptance Criteria: next bus + countdown, route corridors, Express flag, works offline
- Blockers / Notes: corridors are NY 108 and Steve Biko (NY1) = NY 3 + NY 3A + STEVE BIKO DRV. Express = no Mowbray and no N2 Freeway (the user's definition, to work only). Homebound has no Express; the distinction is via Mowbray or not ("Skip Mowbray" filter). Firefox `--screenshot` fires before async JS runs, so render tests use a bundled copy in the scratchpad.
- Outcome: tested headless at a pinned Tue 06:20 in both directions

## Task: User field test
- Status: in-progress
- Domain: coding
- Effort: low
- Dependencies: none
- Acceptance Criteria: user confirms times and filters match real buses
- Blockers / Notes: started 2026-10-25. First GPS trip-logging ride: Mon 2026-10-26. Checklist in docs/USER_GUIDE.md (local).

## Task: Host it so the phone can install it
- Status: completed
- Domain: coding
- Effort: low
- Dependencies: choice of host (GitHub Pages / Netlify / home server). Phones need HTTPS to install a PWA.
- Acceptance Criteria: installed on the user's phone and works in airplane mode
- Outcome: live at https://cypherwars-ops.github.io/next-bus/ (repo cypherwars-ops/next-bus, public). Every push to main runs test_logic.mjs, then publishes app/. Phone install pending the user's test.

## Task: Trip logging with GPS (roadmap 3a)
- Status: completed
- Domain: coding
- Effort: medium
- Dependencies: HTTPS hosting (geolocation needs it), Android Chrome
- Acceptance Criteria: tap a bus to log it; mark stops; Got off; history shows scheduled vs actual times; GPX/JSON export; survives a reload
- Blockers / Notes: a PWA only gets GPS while the screen is on, so it holds a Screen Wake Lock while logging. Data is in IndexedDB on the phone only. Tested headless with faked GPS (start, stop pin, got off, history, resume after reload).
- Outcome: app/tracker.js (GPS, wake lock, storage) + maths in logic.js (summariseTrip, departureStats, toGPX), with unit tests. The user's field test is pending.

## Task: Public holiday timetable
- Status: completed
- Domain: coding
- Effort: low
- Dependencies: GABS PH PDFs (NYANGA___CAPE_TOWN___PH_20261104_*)
- Acceptance Criteria: holiday trips parsed; app switches automatically on SA public holidays; manual "Public holiday" option
- Blockers / Notes: the _01/_02 files are identical (each holds both directions); the parser skips duplicate sections. Weekly files are named from/to dates, so the app warns once the week has passed. Gazetted one-off holidays go in EXTRA_HOLIDAYS in logic.js.
- Outcome: holiday = 14 trips to town, 7 home, no Express. Holiday rules from the Public Holidays Act 36 of 1994 (fixed dates, Easter-based days, Sunday -> Monday), unit-tested for 2024-2027.

## Task: Measure terminus -> my stop offset
- Status: pending
- Domain: coding
- Effort: low
- Dependencies: time a few real trips
- Acceptance Criteria: offset set in the app; "~" times match reality within a few minutes

## Ideas
- Auto-check gabs.co.za for a new PDF (the filename contains the date range)
- Public-holiday handling (the PDF doesn't say which timetable applies)
