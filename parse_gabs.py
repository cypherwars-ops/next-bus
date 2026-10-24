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

Usage:
    python3 parse_gabs.py pdfs/<file>.pdf -o app/timetable.json
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
}
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
                    current["effective"] = meta.group(1)
                    current["timetable_number"] = meta.group(2).strip()
    flush()

    # Order trips by first timed departure so the app needn't sort.
    for d in directions:
        d["trips"].sort(key=lambda t: to_minutes(
            next(c["time"] for c in t["calls"] if c["time"])))
    return {"operator": "Golden Arrow Bus Services",
            "directions": directions}, warnings


def main():
    """Command-line entry point."""
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("pdf", type=Path)
    ap.add_argument("-o", "--output", type=Path, default=None,
                    help="write JSON here (default: stdout)")
    args = ap.parse_args()

    data, warnings = parse(pdf_to_text(args.pdf))
    data["source"] = args.pdf.name
    out = json.dumps(data, indent=1)
    if args.output:
        args.output.write_text(out + "\n")
    else:
        print(out)

    for d in data["directions"]:
        print(f"{len(d['trips']):4d} trips  {d['name']}", file=sys.stderr)
    for w in warnings:
        print("WARNING:", w, file=sys.stderr)


if __name__ == "__main__":
    main()
