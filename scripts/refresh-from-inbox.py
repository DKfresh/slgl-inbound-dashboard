#!/usr/bin/env python3
"""
Watches the repo root for a newly-dropped Excel workbook and, if found,
promotes it to source-data/current/SLGL Daily Current.xlsx, rebuilds
data/slgl-data.json, and archives the dropped file.

Usage:
    python3 scripts/refresh-from-inbox.py

Intended to be run periodically (e.g. by a scheduled task) against the
same folder the user drops a new "...xlsx" export into. Any .xlsx file
sitting directly in the repo root (not inside source-data/) is treated
as a candidate replacement, picking the most recently modified one if
there are several. Files already processed are moved into
source-data/archive/ so they aren't reprocessed.
"""
import json
import subprocess
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CURRENT = ROOT / "source-data/current/SLGL Daily Current.xlsx"
ARCHIVE_DIR = ROOT / "source-data/archive"
BUILD_SCRIPT = ROOT / "scripts/build-dashboard-data.py"
STATE_FILE = ROOT / "source-data/.last-processed.json"


def find_dropped_workbook():
    candidates = sorted(
        [p for p in ROOT.glob("*.xlsx") if p.is_file()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def main():
    dropped = find_dropped_workbook()
    if dropped is None:
        print("No new workbook found in repo root. Nothing to do.")
        return 0

    stat = dropped.stat()
    fingerprint = f"{dropped.name}:{stat.st_size}:{int(stat.st_mtime)}"
    state = load_state()
    if state.get("last_fingerprint") == fingerprint:
        print(f"'{dropped.name}' was already processed (unchanged since last run). Nothing to do.")
        return 0

    print(f"Found dropped workbook: {dropped.name}")
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    CURRENT.parent.mkdir(parents=True, exist_ok=True)

    # Archive whatever was previously "current" before overwriting it.
    if CURRENT.exists():
        import datetime
        stamp = datetime.date.today().isoformat()
        archived_old = ARCHIVE_DIR / f"SLGL Daily {stamp}.xlsx"
        i = 1
        while archived_old.exists():
            archived_old = ARCHIVE_DIR / f"SLGL Daily {stamp} ({i}).xlsx"
            i += 1
        shutil.copy2(CURRENT, archived_old)

    shutil.copy2(dropped, CURRENT)
    print(f"Promoted '{dropped.name}' to {CURRENT}")

    result = subprocess.run([sys.executable, str(BUILD_SCRIPT)])
    if result.returncode != 0:
        print("build-dashboard-data.py failed; leaving dropped file in place for inspection.", file=sys.stderr)
        return result.returncode

    # Record that this exact file (by name+size+mtime) has been processed,
    # so we don't reprocess it again on the next check. We try to remove
    # the inbox copy too, but the connected folder may not allow deletes
    # from here -- that's fine, the fingerprint check above prevents
    # re-processing either way.
    save_state({"last_fingerprint": fingerprint, "source_name": dropped.name})
    try:
        dropped.unlink()
        print(f"Removed processed inbox file '{dropped.name}'.")
    except PermissionError:
        print(f"Note: could not delete '{dropped.name}' from this folder (not permitted); "
              f"leaving it in place. It will not be reprocessed since it's now recorded as done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
