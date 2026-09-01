#!/usr/bin/env python3
"""
Single reusable importer for the SLGL Inbound Control Tower dashboard.

Reads `source-data/current/SLGL Daily Current.xlsx` and rebuilds every
collection in `public/slgl-data.json`:

  - bookings          (from "Booking Details")
  - activeContainers  (derived from allContainers)
  - allContainers     (from "Container Details")
  - canRows           (derived from allContainers)
  - originDashboard   (from "Origin Dashboard")

Worksheets are located BY NAME (via workbook.xml + its rels), never by a
hardcoded sheetN.xml number, so re-ordering tabs in the workbook does not
silently break the import. Required headers are validated before any row
is read; a changed/renamed column fails loudly with the sheet name and the
headers that were actually found, instead of quietly producing bad data.

Usage:
    python3 scripts/build-dashboard-data.py
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
    "dcterms": "http://purl.org/dc/terms/",
}

SOURCE = Path(__file__).resolve().parents[1] / "source-data/current/SLGL Daily Current.xlsx"
TARGET = Path(__file__).resolve().parents[1] / "data/slgl-data.json"


class ImporterError(RuntimeError):
    """Raised for any workbook-layout problem; message is meant to be read by a human."""


def colnum(ref):
    n = 0
    for c in ref:
        n = n * 26 + (ord(c) - 64)
    return n


def number(v):
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def excel_day(v):
    if v in (None, ""):
        return None
    try:
        return (datetime(1899, 12, 30) + timedelta(days=float(v))).date().isoformat()
    except (TypeError, ValueError):
        return None


class Workbook:
    """Thin, dependency-free reader over the raw OOXML parts we need."""

    def __init__(self, path):
        if not path.exists():
            raise ImporterError(
                f"Source workbook not found at {path}. Replace it with the latest "
                f"'SLGL Daily Current.xlsx' export before running the importer."
            )
        self.zip = zipfile.ZipFile(path)
        self.shared_strings = self._load_shared_strings()
        self.sheet_file_by_name = self._load_sheet_map()

    def _load_shared_strings(self):
        try:
            root = ET.fromstring(self.zip.read("xl/sharedStrings.xml"))
        except KeyError:
            return []
        out = []
        for si in root:
            out.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
        return out

    def _load_sheet_map(self):
        workbook_xml = ET.fromstring(self.zip.read("xl/workbook.xml"))
        rels_xml = ET.fromstring(self.zip.read("xl/_rels/workbook.xml.rels"))
        rid_to_target = {
            rel.attrib["Id"]: rel.attrib["Target"]
            for rel in rels_xml
            if rel.attrib.get("Type", "").endswith("/worksheet")
        }
        name_to_file = {}
        for sheet in workbook_xml.find("m:sheets", NS):
            name = sheet.attrib["name"]
            rid = sheet.attrib[f"{{{NS['r']}}}id"]
            target = rid_to_target.get(rid)
            if target is None:
                continue
            name_to_file[name] = "xl/" + target.lstrip("/")
        return name_to_file

    def asof_date(self):
        try:
            core = ET.fromstring(self.zip.read("docProps/core.xml"))
        except KeyError:
            return None
        modified = core.find("dcterms:modified", NS)
        if modified is None or not modified.text:
            return None
        # e.g. "2026-08-17T20:38:18Z"
        return modified.text[:10]

    def raw_rows(self, sheet_name):
        """Return {row_number: {col_letter: value}} for a worksheet, looked up by name."""
        path = self.sheet_file_by_name.get(sheet_name)
        if path is None:
            available = ", ".join(sorted(self.sheet_file_by_name))
            raise ImporterError(
                f"Worksheet '{sheet_name}' was not found in {SOURCE.name}. "
                f"Available worksheets: {available}"
            )
        root = ET.fromstring(self.zip.read(path))
        rows = {}
        for row in root.findall(".//m:sheetData/m:row", NS):
            values = {}
            for c in row.findall("m:c", NS):
                col = re.match(r"[A-Z]+", c.attrib["r"]).group()
                v = c.find("m:v", NS)
                if v is None:
                    continue
                values[col] = self.shared_strings[int(v.text)] if c.attrib.get("t") == "s" else v.text
            rows[int(row.attrib["r"])] = values
        return rows

    def table(self, sheet_name, required_headers):
        """
        Read a worksheet as a header-keyed table: row 1 supplies column names,
        every following row becomes {header_name: value}.
        """
        raw = self.raw_rows(sheet_name)
        if not raw:
            raise ImporterError(f"Worksheet '{sheet_name}' has no rows.")
        header_row_num = min(raw)
        header_cols = {colnum(col): name for col, name in raw[header_row_num].items()}
        found_headers = set(header_cols.values())
        missing = [h for h in required_headers if h not in found_headers]
        if missing:
            raise ImporterError(
                f"Worksheet '{sheet_name}' is missing expected column(s): {missing}. "
                f"Headers actually present: {sorted(found_headers)}. "
                f"The workbook layout may have changed — update build-dashboard-data.py "
                f"if this column was intentionally renamed."
            )
        name_to_colnum = {name: cn for cn, name in header_cols.items()}
        rows = []
        for row_num in sorted(raw):
            if row_num == header_row_num:
                continue
            raw_row = raw[row_num]
            row = {}
            for name, cn in name_to_colnum.items():
                col_letter = _colnum_to_letter(cn)
                row[name] = raw_row.get(col_letter)
            rows.append(row)
        return rows


def _colnum_to_letter(n):
    letters = ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


# ---------------------------------------------------------------------------
# Container Details -> allContainers
# ---------------------------------------------------------------------------

CONTAINER_DETAILS_REQUIRED = [
    "Container Number", "Status", "Shipment Status Type", "Shipment Status",
    "ORG", "POL", "POD", "POA", "DEST", "FLEX-ID", "Shipment Name",
    "Container Size", "Container Location", "Ctns", "Container Utilization",
    "Days Transit", "Days\nOut", "Days at DC",
    "Arrival Port Estimated Arrival Date", "Arrival Port Actual Arrival Date",
    "Destination Estimated Arrival Date", "Origin Actual Departure Date",
    "Shipper", "Freight Carriers", "PO (Shipment Tag)",
    "Master Bill of Lading Number", "House Bill of Lading Numbers",
    "CAN Rate", "CAN Rate Mod", "NAC/FAK", "FCL / LCL", "Container Volume (CBM)",
]


def build_all_containers(wb):
    rows = wb.table("Container Details", CONTAINER_DETAILS_REQUIRED)
    out = []
    for r in rows:
        container = r.get("Container Number")
        if not container:
            continue
        out.append({
            "status": r.get("Status") or "",
            "shipmentStatusType": r.get("Shipment Status Type") or "",
            "shipmentStatus": r.get("Shipment Status") or "",
            "origin": r.get("ORG") or "",
            "pol": r.get("POL") or "",
            "pod": r.get("POD") or "",
            "poa": r.get("POA") or "",
            "destination": r.get("DEST") or "",
            "flexId": r.get("FLEX-ID") or "",
            "shipment": r.get("Shipment Name") or "",
            "container": container,
            "containerSize": r.get("Container Size") or "",
            "containerLocation": r.get("Container Location") or "",
            "cartons": number(r.get("Ctns")),
            "utilization": number(r.get("Container Utilization")),
            "daysTransit": number(r.get("Days Transit")),
            "daysOut": number(r.get("Days\nOut")),
            "daysAtDc": number(r.get("Days at DC")),
            "arrivalEta": excel_day(r.get("Arrival Port Estimated Arrival Date")),
            "arrivalAta": excel_day(r.get("Arrival Port Actual Arrival Date")),
            "destinationEta": excel_day(r.get("Destination Estimated Arrival Date")),
            "originAtd": excel_day(r.get("Origin Actual Departure Date")),
            "shipper": r.get("Shipper") or "",
            "carrier": r.get("Freight Carriers") or "",
            "po": r.get("PO (Shipment Tag)") or "",
            "mbl": r.get("Master Bill of Lading Number") or "",
            "hbl": r.get("House Bill of Lading Numbers") or "",
            "canRate": number(r.get("CAN Rate")),
            "canRateMod": number(r.get("CAN Rate Mod")),
            "rateType": r.get("NAC/FAK") or "",
            "fclLcl": r.get("FCL / LCL") or "",
            "cbm": number(r.get("Container Volume (CBM)")),
        })
    return out


# ---------------------------------------------------------------------------
# Derived collections: activeContainers, canRows
# ---------------------------------------------------------------------------

def build_active_containers(all_containers):
    return [c for c in all_containers if c["shipmentStatusType"] == "Active"]


def build_can_rows(all_containers, asof_year):
    """
    CAN page = FCL containers landing at the GDC hub in the current workbook
    year. LCL child shipments and non-GDC destinations stay out of container
    cost metrics per the CAN business rule in CLAUDE_HANDOFF.md.
    """
    def arrival_year(c):
        d = c["arrivalAta"] or c["arrivalEta"]
        return d[:4] if d else None

    return [
        c for c in all_containers
        if c["fclLcl"] == "FCL" and c["destination"] == "GDC" and arrival_year(c) == str(asof_year)
    ]


# ---------------------------------------------------------------------------
# Port status by day
# ---------------------------------------------------------------------------

# "At port" = the 4 destination-port statuses already used for the AT PORT
# KPI elsewhere in the dashboard (app.js computeDerived()). Keep in sync.
AT_PORT_STATUSES = {"POD Available", "POD Outgate", "POD Discharge", "Arrived POD"}


def build_port_by_date(active_containers):
    """
    Groups containers currently sitting at the destination port (per
    AT_PORT_STATUSES) by arrival-PORT date (Arrival Port Actual Arrival Date
    if known, else Arrival Port Estimated Arrival Date), with per-day totals
    for container count, cartons, and CBM volume.

    Takes activeContainers (shipmentStatusType == "Active"), the same
    population the Summary/Inbound Status "AT PORT" KPI is built from, so
    the totals here match those KPIs. Uses the current workbook snapshot
    only - there's no stored history of past daily snapshots, so this
    reflects "as of today" grouped by each container's arrival-port date,
    not a day-over-day trend.
    """
    by_date = {}
    for c in active_containers:
        if c["status"] not in AT_PORT_STATUSES:
            continue
        date = c["arrivalAta"] or c["arrivalEta"]
        if not date:
            date = "Unknown"
        else:
            date = date[:10]
        bucket = by_date.setdefault(date, {"date": date, "containers": 0, "cartons": 0, "cbm": 0.0})
        bucket["containers"] += 1
        bucket["cartons"] += c["cartons"] or 0
        bucket["cbm"] += c["cbm"] or 0

    return sorted(by_date.values(), key=lambda x: x["date"], reverse=True)


# ---------------------------------------------------------------------------
# Origin Dashboard
# ---------------------------------------------------------------------------

ORIGIN_DASHBOARD_SECTIONS = [
    # (origin, first data row of the 12 weekly rows, expected origin label or None)
    ("All Origins", 4, None),
    ("VN", 20, "VN"),
    ("ID", 36, "ID"),
    ("PH", 52, "PH"),
    ("IN", 68, "IN"),
    ("CN", 84, "CN"),
]
WEEK_ROWS_PER_SECTION = 12
ORIGIN_DASHBOARD_HEADER = [
    "CRD Mon", "CRD Wk", "Container Count", "% Confirmed", "% Departed",
    "Space Confirmed", "Containers Departed", "Pending Space", "Pending Depart",
    "Avg Days CRD-ETD",
]


def build_origin_dashboard(wb):
    rows = wb.raw_rows("Origin Dashboard")

    def cell(row_num, col_letter):
        return rows.get(row_num, {}).get(col_letter)

    out = []
    for origin, start, expected_label in ORIGIN_DASHBOARD_SECTIONS:
        # Each section repeats the same two-row preamble: an origin-label row
        # (start-2) followed by a column-header row (start-1). Validate both
        # before trusting the 12 data rows that follow.
        header_row_num = start - 1
        header_labels = [cell(header_row_num, c) for c in ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K"]]
        if header_labels != ORIGIN_DASHBOARD_HEADER:
            raise ImporterError(
                f"'Origin Dashboard' header row {header_row_num} (section '{origin}') no "
                f"longer matches the expected layout.\nExpected: {ORIGIN_DASHBOARD_HEADER}\n"
                f"Found:    {header_labels}\nThe pivot layout in this sheet has likely "
                f"shifted rows/columns; update ORIGIN_DASHBOARD_SECTIONS in "
                f"build-dashboard-data.py."
            )
        if expected_label is not None:
            label_row_num = start - 2
            found_label = cell(label_row_num, "D")
            if found_label != expected_label:
                raise ImporterError(
                    f"'Origin Dashboard' row {label_row_num} was expected to label origin "
                    f"'{expected_label}' but found '{found_label}'. The sheet's section "
                    f"layout has likely changed."
                )

        weeks = []
        for r in range(start, start + WEEK_ROWS_PER_SECTION):
            x = rows.get(r, {})
            count = number(x.get("D"))
            confirmed = number(x.get("G"))
            departed = number(x.get("H"))
            weeks.append({
                "crdDate": excel_day(x.get("B")),
                "crdWeek": int(number(x.get("C"))),
                "containerCount": count,
                "confirmedPct": confirmed / count if count else 0,
                "departedPct": departed / count if count else 0,
                "spaceConfirmed": confirmed,
                "containersDeparted": departed,
                "pendingSpace": number(x.get("I")),
                "pendingDepart": number(x.get("J")),
                "avgDays": number(x.get("K")),
                "bucket1to9": number(x.get("L")),
                "bucket10to14": number(x.get("M")),
                "bucket14to20": number(x.get("N")),
                "bucketOver20": number(x.get("O")),
            })
        t = rows.get(start + WEEK_ROWS_PER_SECTION, {})
        total = number(t.get("D"))
        confirmed = number(t.get("G"))
        departed = number(t.get("H"))
        out.append({
            "origin": origin,
            "weeks": weeks,
            # Recomputed rather than read from column E: that cell is a raw
            # formula in the workbook and is prone to #REF! errors.
            "total": {
                "containerCount": total,
                "confirmedPct": confirmed / total if total else 0,
                "departedPct": departed / total if total else 0,
                "spaceConfirmed": confirmed,
                "containersDeparted": departed,
                "pendingSpace": number(t.get("I")),
                "pendingDepart": number(t.get("J")),
                "avgDays": number(t.get("K")),
                "bucket1to9": number(t.get("L")),
                "bucket10to14": number(t.get("M")),
                "bucket14to20": number(t.get("N")),
                "bucketOver20": number(t.get("O")),
            },
        })
    return out


# ---------------------------------------------------------------------------
# Booking Details -> bookings
# ---------------------------------------------------------------------------

BOOKING_DETAILS_REQUIRED = [
    "Booking Status", "Destination", "Origin", "POL", "POD", "CRD Wk",
    "CRD - ETD", "Container Ct", "Total Cartons", "Total Volume (CBM)",
    "FLEX-ID", "Shipment Name", "Shipper", "Purchase Order Numbers (CI)",
    "Master Bill of Lading Number", "House Bill of Lading Numbers",
    "Origin Planned Cargo Ready Date", "Origin Actual Cargo Ready Date",
    "Origin Estimated Departure Date", "Origin Actual Departure Date",
    "Discharge Port Estimated Arrival Date", "Booking Confirmed Date",
    "service_level (Shipment Tag)", "FCL / LCL",
]


def build_bookings(wb, crd_weeks_in_scope):
    """
    Bookings tracks the same rolling CRD-week window shown on the Origin
    Dashboard, restricted to FCL bookings (LCL child shipments are excluded
    from container-level metrics elsewhere in the dashboard too).
    """
    rows = wb.table("Booking Details", BOOKING_DETAILS_REQUIRED)
    out = []
    for r in rows:
        if r.get("FCL / LCL") != "FCL":
            continue
        try:
            crd_week = int(float(r.get("CRD Wk")))
        except (TypeError, ValueError):
            continue
        if crd_week not in crd_weeks_in_scope:
            continue
        crd_date = excel_day(r.get("Origin Actual Cargo Ready Date")) or excel_day(r.get("Origin Planned Cargo Ready Date"))
        actual_departure = excel_day(r.get("Origin Actual Departure Date"))
        out.append({
            "status": r.get("Booking Status") or "",
            "destination": r.get("Destination") or "",
            "origin": r.get("Origin") or "",
            "pol": r.get("POL") or "",
            "pod": r.get("POD") or "",
            "crdWeek": crd_week,
            "crdDate": crd_date,
            "estimatedDeparture": excel_day(r.get("Origin Estimated Departure Date")),
            "actualDeparture": actual_departure,
            "etaPort": excel_day(r.get("Discharge Port Estimated Arrival Date")),
            "crdToEtd": number(r.get("CRD - ETD")),
            "containerCount": number(r.get("Container Ct")),
            "cartons": number(r.get("Total Cartons")),
            "cbm": number(r.get("Total Volume (CBM)")),
            "flexId": r.get("FLEX-ID") or "",
            "shipment": r.get("Shipment Name") or "",
            "shipper": r.get("Shipper") or "",
            "po": r.get("Purchase Order Numbers (CI)") or "",
            "mbl": r.get("Master Bill of Lading Number") or "",
            "hbl": r.get("House Bill of Lading Numbers") or "",
            "confirmed": bool(r.get("Booking Confirmed Date")),
            "departed": bool(actual_departure),
            "serviceLevel": r.get("service_level (Shipment Tag)") or "",
        })
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    wb = Workbook(SOURCE)

    all_containers = build_all_containers(wb)
    print(f"allContainers: {len(all_containers)} rows "
          f"({Counter(c['status'] for c in all_containers).most_common()})")

    active_containers = build_active_containers(all_containers)
    print(f"activeContainers: {len(active_containers)} rows")

    asof = wb.asof_date()
    if asof is None:
        raise ImporterError("Could not read the workbook's last-modified date from docProps/core.xml.")
    can_rows = build_can_rows(all_containers, asof[:4])
    print(f"canRows: {len(can_rows)} rows (FCL, destination GDC, arrival year {asof[:4]})")

    origin_dashboard = build_origin_dashboard(wb)
    all_origins_total = next(o for o in origin_dashboard if o["origin"] == "All Origins")["total"]
    print(f"originDashboard: {len(origin_dashboard)} origins, "
          f"All Origins CRD confirmed {all_origins_total['spaceConfirmed']:.0f}/"
          f"{all_origins_total['containerCount']:.0f}")

    crd_weeks_in_scope = {
        w["crdWeek"] for o in origin_dashboard if o["origin"] == "All Origins" for w in o["weeks"]
    }
    bookings = build_bookings(wb, crd_weeks_in_scope)
    print(f"bookings: {len(bookings)} rows (CRD weeks {sorted(crd_weeks_in_scope)})")

    port_by_date = build_port_by_date(active_containers)
    print(f"portByDate: {len(port_by_date)} dates, "
          f"{sum(x['containers'] for x in port_by_date)} at-port containers total")

    data = {
        "asOf": asof,
        "bookings": bookings,
        "activeContainers": active_containers,
        "canRows": can_rows,
        "originDashboard": origin_dashboard,
        "allContainers": all_containers,
        "portByDate": port_by_date,
    }
    TARGET.write_text(json.dumps(data, separators=(",", ":")))
    print(f"Wrote {TARGET}")


if __name__ == "__main__":
    try:
        main()
    except ImporterError as e:
        print(f"\nERROR: {e}\n", file=sys.stderr)
        sys.exit(1)
