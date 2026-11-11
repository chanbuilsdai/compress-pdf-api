# editpdf.tools Compress PDF API

Free PDF compression API by [editpdf.tools](https://editpdf.tools/).

- `compress-service/`: Node + Ghostscript service (runs on Render free).
- `api-worker/`: Cloudflare Worker at api.editpdf.tools (API keys, quotas, user dashboard, admin).

Get a key and docs: https://api.editpdf.tools/ · Support: https://editpdf.tools/contact

## Quick example
```
curl -X POST https://api.editpdf.tools/v1/compress \
  -H "X-API-Key: YOUR_KEY" -F "file=@input.pdf" -F "level=recommended" -o compressed.pdf
```

## License
AGPL-3.0-only. Uses the unmodified Ghostscript binary (AGPL, Artifex Software) and qpdf (Apache-2.0).
