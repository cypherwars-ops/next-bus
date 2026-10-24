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
- Blockers / Notes: started 2026-10-25

## Task: Host it so the phone can install it
- Status: pending
- Domain: coding
- Effort: low
- Dependencies: choice of host (GitHub Pages / Netlify / home server). Phones need HTTPS to install a PWA.
- Acceptance Criteria: installed on the user's phone and works in airplane mode

## Task: Measure terminus -> my stop offset
- Status: pending
- Domain: coding
- Effort: low
- Dependencies: time a few real trips
- Acceptance Criteria: offset set in the app; "~" times match reality within a few minutes

## Ideas
- Auto-check gabs.co.za for a new PDF (the filename contains the date range)
- Public-holiday handling (the PDF doesn't say which timetable applies)
