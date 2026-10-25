#!/usr/bin/env python3
"""Convert a Golden Arrow Bus Services (GABS) timetable PDF into JSON.

How the PDF is laid out (one page per direction):

    NYANGA - MOWBRAY - CAPE TOWN                 <- direction header
    MONDAYS TO FRIDAYS ... EFFECTIVE DATE: ... TIMETABLE NUMBER: ...
    | NYANGA TERM  |05:00 |05:15 | ...           <- one row per stop/road
    | NY 108       |via   | --   | ...
    | CAPE TOWN    |06:00 |06:00 | ...
    |-------------------------------|            <- next block of columns
    SATURDAYS / SUNDAYS                          <- next day group

Each COLUMN is one bus trip, read top to bottom. A cell is one of:
    "HH:MM"  - timed stop        "via" - passes here, no time printed
    "--"     - doesn't go here
A time may carry a suffix: "a" = Mon-Thu only, "b" = Friday only.

The PDF has no extractable table structure, but `pdftotext -layout`
keeps the '|' separators and every row has exactly 22 cells, so
splitting on '|' recovers the columns reliably.

GABS publishes one file per timetable number (e.g. ..._004301 and
..._004302) but each file holds BOTH directions, so the pair is a
duplicate. Weekly files are named ..._from_YYYYMMDD_to_YYYYMMDD_...;
public-holiday files ..._PH_YYYYMMDD_... . Pass any mix of them: trips
are merged per direction and exact duplicates dropped.

Usage:
    python3 parse_gabs.py pdfs/*.pdf -o app/timetable.json
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

# ISO weekday numbers (Mon=1 ... Sun=7) for each day-group heading.
DAY_GROUPS = {
    "MONDAYS TO FRIDAYS": [1, 2, 3, 4, 5],
    "SATURDAYS": [6],
    "SUNDAYS": [7],
    "PUBLIC HOLIDAYS": [8],   # 8 = pseudo-day used by the app for holidays
}
HOLIDAY_GROUP = "PUBLIC HOLIDAYS"
FILE_WEEKLY_RE = re.compile(r"_from_(\d{8})_to_(\d{8})_")
FILE_PH_RE = re.compile(r"_PH_(\d{8})_")
# Footnote letters printed after a time, narrowing the day group.
SUFFIX_DAYS = {"a": [1, 2, 3, 4], "b": [5]}

TIME_RE = re.compile(r"^(\d{2}:\d{2})([ab]?)$")
DIRECTION_RE = re.compile(r"^[A-Z ]+( - [A-Z ]+)+$")
META_RE = re.compile(
    r"EFFECTIVE DATE:\s*(\S+)\s+TIMETABLE NUMBER:\s*(.+)$")


def pdf_to_text(pdf_path):
    """Run pdftotext in layout mode and return the text."""
    result = subprocess.run(
        ["pdftotext", "-layout", str(pdf_path), "-"],
        capture_output=True, text=True, check=True)
    return result.stdout


def to_minutes(hhmm):
    """Convert 'HH:MM' to minutes after midnight (for sanity checks)."""
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def parse_block(rows, days, warnings, label):
    """Turn one block of rows into a list of trips.

    rows: list of (stop_name, [22 cell strings]) in printed order.
    """
    trips = []
    n_cols = len(rows[0][1])
    for col in range(n_cols):
        calls = []
        suffixes = set()
        for name, cells in rows:
            cell = cells[col]
            if cell == "--" or cell == "":
                continue
            if cell == "via":
                calls.append({"at": name, "time": None})
                continue
            match = TIME_RE.match(cell)
            if not match:
                warnings.append(f"{label} col {col + 1}: odd cell {cell!r}")
                continue
            calls.append({"at": name, "time": match.group(1)})
            if match.group(2):
                suffixes.add(match.group(2))

        timed = [c["time"] for c in calls if c["time"]]
        if not timed:
            continue  # empty padding column

        if len(suffixes) > 1:
            warnings.append(f"{label} col {col + 1}: mixed suffixes "
                            f"{sorted(suffixes)}")
        trip_days = SUFFIX_DAYS[suffixes.pop()] if suffixes else days

        # Times should increase along the route; flag it if not.
        mins = [to_minutes(t) for t in timed]
        if mins != sorted(mins):
            warnings.append(f"{label} col {col + 1}: times not in order "
                            f"{timed}")
        if len(timed) == 1:
            warnings.append(f"{label} col {col + 1}: only one timed stop "
                            f"({calls})")

        trips.append({"days": trip_days, "calls": calls})
    return trips


def parse(text):
    """Parse the full pdftotext output into a timetable dict."""
    directions = []
    warnings = []
    current = None      # direction being filled
    days = None         # weekday list for current day group
    group = None        # day-group heading text
    block = []          # rows collected for the current block

    def flush():
        if block and current is not None:
            label = f"{current['name']} / {group}"
            current["trips"].extend(parse_block(block, days, warnings, label))
        block.clear()

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("| "):
            cells = [c.strip() for c in line.strip("|").split("|")]
            block.append((cells[0], cells[1:]))
            continue
        flush()  # any non-row line ends the current block
        if DIRECTION_RE.match(line) and line not in DAY_GROUPS:
            current = {"name": line, "trips": []}
            directions.append(current)
            continue
        for heading, weekdays in DAY_GROUPS.items():
            if line.startswith(heading):
                group, days = heading, weekdays
                meta = META_RE.search(line)
                if meta and current is not None:
                    kind = "holiday" if heading == HOLIDAY_GROUP else "weekly"
                    current.setdefault("effective", {})[kind] = meta.group(1)
                    current["timetable_number"] = meta.group(2).strip()
    flush()

    # Order trips by first timed departure so the app needn't sort.
    for d in directions:
        d["trips"].sort(key=first_time)
    return {"operator": "Golden Arrow Bus Services",
            "directions": directions}, warnings


def first_time(trip):
    """Minutes of the trip's first timed stop (sort key)."""
    return to_minutes(next(c["time"] for c in trip["calls"] if c["time"]))


def iso_date(yyyymmdd):
    """'20261025' -> '2026-10-25'."""
    return f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:]}"


def source_info(path):
    """Describe a PDF from its filename: kind and validity dates."""
    weekly = FILE_WEEKLY_RE.search(path.name)
    if weekly:
        return {"file": path.name, "kind": "weekly",
                "from": iso_date(weekly.group(1)),
                "to": iso_date(weekly.group(2))}
    ph = FILE_PH_RE.search(path.name)
    if ph:
        return {"file": path.name, "kind": "holiday",
                "from": iso_date(ph.group(1))}
    return {"file": path.name, "kind": "unknown"}


def merge(parsed):
    """Merge directions from several parsed files.

    A direction section identical to one already merged (GABS's duplicate
    _01/_02 files) is skipped as a whole. Individual trips are never
    de-duplicated: two identical columns can be two real buses.

    parsed: list of (data, warnings) tuples from parse().
    Returns (directions, number of duplicate sections skipped).
    """
    merged = {}          # direction name -> direction dict
    seen = set()         # fingerprints of direction sections already used
    dupes = 0
    for data, _ in parsed:
        for d in data["directions"]:
            key = json.dumps([d["name"], d["trips"]], sort_keys=True)
            if key in seen:
                dupes += 1
                continue
            seen.add(key)
            target = merged.setdefault(d["name"], {
                "name": d["name"], "effective": {}, "trips": []})
            target["effective"].update(d.get("effective", {}))
            if "timetable_number" in d:
                target["timetable_number"] = d["timetable_number"]
            target["trips"].extend(d["trips"])
    for d in merged.values():
        d["trips"].sort(key=first_time)
    return list(merged.values()), dupes


def main():
    """Command-line entry point."""
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("pdf", type=Path, nargs="+")
    ap.add_argument("-o", "--output", type=Path, default=None,
                    help="write JSON here (default: stdout)")
    args = ap.parse_args()

    parsed = [parse(pdf_to_text(pdf)) for pdf in args.pdf]
    directions, dupes = merge(parsed)
    warnings = sorted({w for _, ws in parsed for w in ws})
    data = {"operator": "Golden Arrow Bus Services",
            "sources": [source_info(pdf) for pdf in args.pdf],
            "directions": directions}
    out = json.dumps(data, indent=1)
    if args.output:
        args.output.write_text(out + "\n")
    else:
        print(out)

    for d in data["directions"]:
        groups = {}
        for trip in d["trips"]:
            kind = "holiday" if trip["days"] == [8] else "weekly"
            groups[kind] = groups.get(kind, 0) + 1
        print(f"{len(d['trips']):4d} trips  {d['name']}  {groups}",
              file=sys.stderr)
    if dupes:
        print(f"     ({dupes} duplicate direction sections skipped: same "
              "timetable in more than one file)", file=sys.stderr)
    for w in warnings:
        print("WARNING:", w, file=sys.stderr)


if __name__ == "__main__":
    main()
