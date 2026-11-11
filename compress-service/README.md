# editpdf.tools Compress PDF API: compression service

Small Node service that compresses PDFs with Ghostscript. It runs on Google Cloud Run.
Public users never call it directly: the Cloudflare Worker at api.editpdf.tools checks the
API key and quota, then forwards the request here with the `X-Internal-Secret` header.

## Endpoint
`POST /v1/compress` (multipart/form-data)
- `file`: the PDF (max 30 MB)
- `level`: `light` | `recommended` (default) | `strong`

Returns the compressed PDF. Headers: `X-Original-Size`, `X-Compressed-Size`, `X-Compressed`
(`false` means the original was smaller, so the original is returned), `X-Level`.

Errors (JSON): 401 unauthorized, 400 missing_file / bad_level, 413 file_too_large,
415 not_a_pdf, 422 pdf_is_password_protected / could_not_read_pdf / could_not_process_pdf,
504 processing_timeout.

## Safety
- Ghostscript runs with `-dSAFER`, via execFile (no shell), 120 s timeout, max 2 jobs per instance.
- File must start with `%PDF-`; password-protected PDFs are refused (checked with qpdf).
- The output must have the same page count as the input, or the request fails.
- Input and output files are deleted right after the response. Nothing is stored.
- Runs as a non-root user in the container.

## Env vars
- `INTERNAL_SECRET` (required, 32+ chars): shared with the Cloudflare Worker. Set it as a secret, never in code.
- `MAX_PARALLEL_JOBS` (default 2)

## License
This wrapper: AGPL-3.0-only. It calls the unmodified Ghostscript binary (AGPL, Artifex Software)
and qpdf (Apache-2.0).
