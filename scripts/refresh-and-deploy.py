#!/usr/bin/env python3
"""
Full refresh pipeline:
  1. Look for a newly-dropped .xlsx in the repo root (scripts/refresh-from-inbox.py).
  2. If a new file was found, rebuild data/slgl-data.json.
  3. Mirror the deployable files into a scratch git working copy, commit, and
     push to GitHub. GitHub Actions then redeploys the Pages site.

Requires a GitHub personal access token in a local file named ".github-token"
in the repo root (gitignored, never committed). Requires a git-capable
scratch directory (SCRATCH_DIR below) since this connected folder's
filesystem does not support the delete/rename operations git needs.

Usage:
    python3 scripts/refresh-and-deploy.py
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKEN_FILE = ROOT / ".github-token"
REMOTE_URL = "https://github.com/DKfresh/slgl-inbound-dashboard.git"
GITHUB_USER = "DKfresh"
SCRATCH_DIR = Path("/tmp/slgl-repo")

DEPLOY_PATHS = [
    ".github", ".gitignore", ".nojekyll", "README.md",
    "app.js", "data", "index.html", "scripts", "style.css",
]


def run(cmd, **kw):
    print("+", " ".join(cmd))
    return subprocess.run(cmd, cwd=str(SCRATCH_DIR), check=True, **kw)


def main():
    # Step 1 + 2: pull in any newly dropped workbook and rebuild the data file.
    refresh_result = subprocess.run(
        [sys.executable, str(ROOT / "scripts/refresh-from-inbox.py")]
    )
    if refresh_result.returncode != 0:
        print("refresh-from-inbox.py failed; aborting before touching git.", file=sys.stderr)
        return refresh_result.returncode

    if not TOKEN_FILE.exists():
        print(f"No token file at {TOKEN_FILE}; skipping git push. "
              f"(Data was still rebuilt locally in {ROOT / 'data/slgl-data.json'}.)")
        return 0
    token = TOKEN_FILE.read_text().strip()

    # Step 3: mirror deployable files into the scratch repo.
    if not (SCRATCH_DIR / ".git").exists():
        print(f"No git repo at {SCRATCH_DIR}; cloning from GitHub first.")
        SCRATCH_DIR.parent.mkdir(parents=True, exist_ok=True)
        push_url = f"https://{GITHUB_USER}:{token}@github.com/DKfresh/slgl-inbound-dashboard.git"
        subprocess.run(["git", "clone", push_url, str(SCRATCH_DIR)], check=True)

    for name in DEPLOY_PATHS:
        src = ROOT / name
        dst = SCRATCH_DIR / name
        if not src.exists():
            continue
        if dst.exists():
            if dst.is_dir():
                shutil.rmtree(dst)
            else:
                dst.unlink()
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)

    run(["git", "add", "-A"])
    status = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=str(SCRATCH_DIR))
    if status.returncode == 0:
        print("No changes to deploy - data is already up to date on GitHub.")
        return 0

    import datetime
    msg = f"Refresh dashboard data ({datetime.date.today().isoformat()})"
    run(["git", "-c", "user.email=doug.kim@serenaandlily.com", "-c", "user.name=Doug Kim",
         "commit", "-q", "-m", msg])

    push_url = f"https://{GITHUB_USER}:{token}@github.com/DKfresh/slgl-inbound-dashboard.git"
    run(["git", "push", push_url, "main:main"])
    print("Pushed to GitHub. GitHub Actions will redeploy the Pages site shortly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
