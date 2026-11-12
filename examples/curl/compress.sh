#!/usr/bin/env bash
# Compress a PDF with the editpdf.tools Compress PDF API (curl).
#
#   EDITPDF_API_KEY=ept_... ./compress.sh input.pdf [light|recommended|strong]
#
# Free plan: 30 files per month, up to 10 MB each, 1 file per minute.
# Docs: https://editpdf.tools/compress-pdf-api
set -euo pipefail

API="${EDITPDF_API_BASE:-https://api.editpdf.tools}/v1/compress"
IN="${1:?Usage: ./compress.sh input.pdf [level]}"
LEVEL="${2:-recommended}"
OUT="${IN%.*}-compressed.pdf"
: "${EDITPDF_API_KEY:?Set EDITPDF_API_KEY first (free key: https://api.editpdf.tools/signup)}"

# -D - prints the response headers (sizes and quota); -o saves the PDF.
status=$(curl -sS -X POST "$API" \
  -H "X-API-Key: $EDITPDF_API_KEY" \
  -F "file=@${IN};type=application/pdf" \
  -F "level=${LEVEL}" \
  -D headers.txt -o "$OUT" -w '%{http_code}')

if [ "$status" != "200" ]; then
  echo "Error $status: $(cat "$OUT")" >&2   # errors come back as JSON
  rm -f "$OUT" headers.txt
  exit 1
fi
grep -iE '^x-(original-size|compressed-size|quota-remaining):' headers.txt
rm -f headers.txt
echo "Saved $OUT"
