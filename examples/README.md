# Compress PDF API examples

Runnable examples for the free [editpdf.tools Compress PDF API](https://editpdf.tools/compress-pdf-api).
Walkthrough with explanations: https://chanbuilsdai.github.io/compress-pdf-api/

| Folder | What it does |
|---|---|
| [curl](curl/compress.sh) | One file from the shell; prints sizes and quota |
| [python](python/compress_pdf.py) | One file or a whole folder; waits on `Retry-After` |
| [node](node/compress-pdf.mjs) | Node.js 20+, no packages; retries on 429/503 |
| [php](php/compress-pdf.php) | PHP 8 with cURL |
| [github-actions](github-actions/compress-pdfs.yml) | Compress PDFs changed in a push, upload them as an artifact |

All examples read the key from `EDITPDF_API_KEY`. Get a free key at https://api.editpdf.tools/signup (email sign-in, no card).

Free plan: 30 files per month, up to 10 MB per file, 1 file per minute.
