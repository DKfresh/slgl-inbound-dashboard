# SLGL Inbound Control Tower

Static, client-side dashboard for Serena & Lily inbound container/booking visibility. No backend server required — hosted as a static site on GitHub Pages.

## How it's built

- `index.html`, `style.css`, `app.js` — the dashboard itself (plain HTML/CSS/JS, no build step, no framework).
- `data/slgl-data.json` — the data the dashboard reads. Generated from the source Excel workbook.
- `scripts/build-dashboard-data.py` — the importer. Reads `source-data/current/SLGL Daily Current.xlsx` and writes `data/slgl-data.json`. Looks up sheets by name, so it keeps working even if sheet order changes; it fails loudly (with a clear message) if an expected sheet or header column is missing.
- `scripts/refresh-from-inbox.py` — the refresh helper. Looks for any `.xlsx` file dropped in the repo root, promotes it to `source-data/current/SLGL Daily Current.xlsx`, archives the previous version to `source-data/archive/`, and reruns the importer. Safe to run repeatedly — it keeps track of what it already processed in `source-data/.last-processed.json` and does nothing if there's no new file.

## Updating the data

1. Drop the new daily Excel export anywhere in this folder (any filename ending in `.xlsx` works).
2. Run: `python3 scripts/refresh-from-inbox.py`
3. Commit and push the updated `data/slgl-data.json` (and the new `source-data/current/...` file) to GitHub.
4. GitHub Actions (`.github/workflows/deploy.yml`) automatically redeploys the Pages site on every push to `main`.

When Claude has access to this folder, it can do steps 1–3 for you automatically on a schedule.

## Local preview

Just open `index.html` in a browser, or serve the folder with any static file server, e.g.:

```
python3 -m http.server 8000
```

then visit `http://localhost:8000`.
