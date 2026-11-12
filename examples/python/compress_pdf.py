#!/usr/bin/env python3
"""Compress PDF files with the editpdf.tools Compress PDF API.

Usage:
  export EDITPDF_API_KEY=ept_...
  python compress_pdf.py input.pdf                 # writes input-compressed.pdf
  python compress_pdf.py ./invoices --level strong  # every PDF in a folder

Free plan: 30 files per month, up to 10 MB each, 1 file per minute.
The script waits when the API asks it to (HTTP 429 / 503 with Retry-After).
Docs: https://editpdf.tools/compress-pdf-api
Requires: pip install requests
"""
import argparse
import os
import sys
import time
from pathlib import Path

import requests

API = os.environ.get("EDITPDF_API_BASE", "https://api.editpdf.tools") + "/v1/compress"
MAX_BYTES = 10 * 1024 * 1024
LEVELS = ("light", "recommended", "strong")


def compress(path: Path, key: str, level: str, max_tries: int = 5) -> Path:
    if path.stat().st_size > MAX_BYTES:
        raise SystemExit(f"{path.name}: larger than 10 MB, skipped")
    out = path.with_name(path.stem + "-compressed.pdf")
    for attempt in range(1, max_tries + 1):
        with path.open("rb") as fh:
            res = requests.post(
                API,
                headers={"X-API-Key": key},
                files={"file": (path.name, fh, "application/pdf")},
                data={"level": level},
                timeout=180,  # large scanned PDFs can take a while
            )
        if res.status_code == 200:
            out.write_bytes(res.content)
            before = int(res.headers.get("X-Original-Size", path.stat().st_size))
            after = int(res.headers.get("X-Compressed-Size", len(res.content)))
            saved = round((1 - after / before) * 100, 1) if before else 0
            left = res.headers.get("X-Quota-Remaining", "?")
            print(f"{path.name}: {before:,} -> {after:,} bytes ({saved}% smaller), {left} files left this month")
            return out
        try:
            err = res.json()
        except ValueError:
            err = {"error": f"HTTP {res.status_code}"}
        if res.status_code in (429, 503) and err.get("error") != "monthly_quota_reached":
            wait = int(res.headers.get("Retry-After", 60))
            print(f"{path.name}: {err.get('error')}, waiting {wait}s (try {attempt}/{max_tries})")
            time.sleep(wait)
            continue
        raise SystemExit(f"{path.name}: {err.get('message') or err.get('error')}")
    raise SystemExit(f"{path.name}: gave up after {max_tries} tries")


def main() -> None:
    ap = argparse.ArgumentParser(description="Compress PDFs with the editpdf.tools API")
    ap.add_argument("target", help="a PDF file or a folder of PDFs")
    ap.add_argument("--level", choices=LEVELS, default="recommended")
    args = ap.parse_args()

    key = os.environ.get("EDITPDF_API_KEY")
    if not key:
        sys.exit("Set EDITPDF_API_KEY first (free key: https://api.editpdf.tools/signup)")

    target = Path(args.target)
    files = sorted(p for p in target.glob("*.pdf") if not p.stem.endswith("-compressed")) if target.is_dir() else [target]
    for p in files:
        compress(p, key, args.level)


if __name__ == "__main__":
    main()
