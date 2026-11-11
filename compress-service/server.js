// editpdf.tools Compress PDF API - compression service (runs on Google Cloud Run)
// Calls the UNMODIFIED Ghostscript binary (AGPL). This wrapper is published under AGPL-3.0.
// Public traffic never reaches this service directly: the Cloudflare Worker at
// api.editpdf.tools checks the API key and quota, then forwards the request here
// with a shared secret header.

'use strict';

const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 8080;
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB (Render free has 0.1 CPU)
const GS_TIMEOUT_MS = 150 * 1000;
const MAX_PARALLEL_JOBS = Number(process.env.MAX_PARALLEL_JOBS || 2);
const GS_BIN = process.env.GS_BIN || 'gs';
const QPDF_BIN = process.env.QPDF_BIN || 'qpdf';

// Compression levels. Image resolution is what changes the size most.
const LEVELS = {
  light: { preset: '/printer', dpi: 300 },       // best quality, smallest saving
  recommended: { preset: '/ebook', dpi: 150 },   // default
  strong: { preset: '/screen', dpi: 72 },        // smallest file, lower image quality
};

if (!INTERNAL_SECRET || INTERNAL_SECRET.length < 32) {
  console.error('INTERNAL_SECRET env var missing or too short (min 32 chars). Refusing to start.');
  process.exit(1);
}

const workDir = path.join(os.tmpdir(), 'editpdf-compress');
fs.mkdirSync(workDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: workDir,
    filename: (_req, _file, cb) => cb(null, `in_${crypto.randomUUID()}.pdf`),
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, parts: 6 },
});

const app = express();
app.disable('x-powered-by');

// --- simple job limiter so one instance never runs too many Ghostscript jobs ---
let running = 0;
const queue = [];
function acquire() {
  if (running < MAX_PARALLEL_JOBS) { running++; return Promise.resolve(); }
  return new Promise((resolve) => queue.push(resolve));
}
function release() {
  const next = queue.shift();
  if (next) next(); else running--;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireInternal(req, res, next) {
  const got = req.get('X-Internal-Secret') || '';
  if (!safeEqual(got, INTERNAL_SECRET)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

async function rm(p) { if (p) await fsp.unlink(p).catch(() => {}); }

async function isPdf(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, 1024, 0);
    return buf.subarray(0, bytesRead).includes(Buffer.from('%PDF-'));
  } finally { await fh.close(); }
}

// qpdf (Apache-2.0) is used only to inspect the file before and after Ghostscript.
function qpdf(args) {
  return new Promise((resolve) => {
    execFile(QPDF_BIN, args, { timeout: 30 * 1000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout || '').trim() }));
  });
}
async function needsPassword(file) { return (await qpdf(['--requires-password', file])).code === 0; }
async function pageCount(file) {
  const r = await qpdf(['--show-npages', file]);
  const n = parseInt(r.out, 10);
  return (r.code === 0 || r.code === 3) && n > 0 ? n : 0; // 3 = warnings only
}

function runGhostscript(input, output, level) {
  const { preset, dpi } = LEVELS[level];
  const args = [
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-dNOPROMPT',
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.5',
    `-dPDFSETTINGS=${preset}`,
    '-dDetectDuplicateImages=true',
    '-dCompressFonts=true',
    '-dDownsampleColorImages=true', `-dColorImageResolution=${dpi}`,
    '-dDownsampleGrayImages=true', `-dGrayImageResolution=${dpi}`,
    '-dDownsampleMonoImages=true', `-dMonoImageResolution=${Math.max(dpi, 150)}`,
    // For "recommended" and "strong", always store photos as JPEG (Ghostscript's
    // auto filter sometimes keeps them lossless, which defeats the downsampling).
    ...(level === 'light' ? [] : [
      '-dAutoFilterColorImages=false', '-dColorImageFilter=/DCTEncode',
      '-dAutoFilterGrayImages=false', '-dGrayImageFilter=/DCTEncode',
    ]),
    `-sOutputFile=${output}`,
    '-f', input,
  ];
  return new Promise((resolve, reject) => {
    execFile(GS_BIN, args, { timeout: GS_TIMEOUT_MS, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
      (err, _stdout, stderr) => {
        if (err) {
          const msg = String(stderr || '');
          err.kind = /password|encrypt/i.test(msg) ? 'encrypted' : (err.killed ? 'timeout' : 'gs_failed');
          return reject(err);
        }
        resolve();
      });
  });
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/v1/compress', requireInternal, (req, res) => {
  upload.single('file')(req, res, async (uploadErr) => {
    const input = req.file && req.file.path;
    let output = null;
    let acquired = false;
    try {
      if (uploadErr) {
        if (uploadErr.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large', max_mb: 10 });
        return res.status(400).json({ error: 'bad_upload' });
      }
      if (!input) return res.status(400).json({ error: 'missing_file', hint: 'send multipart/form-data with field "file"' });

      const level = String((req.body && req.body.level) || req.query.level || 'recommended').toLowerCase();
      if (!LEVELS[level]) return res.status(400).json({ error: 'bad_level', allowed: Object.keys(LEVELS) });
      if (!(await isPdf(input))) return res.status(415).json({ error: 'not_a_pdf' });
      if (await needsPassword(input)) return res.status(422).json({ error: 'pdf_is_password_protected' });
      const inPages = await pageCount(input);
      if (!inPages) return res.status(422).json({ error: 'could_not_read_pdf' });

      output = path.join(workDir, `out_${crypto.randomUUID()}.pdf`);
      await acquire(); acquired = true;
      await runGhostscript(input, output, level);
      // Safety check: the result must have the same number of pages.
      if ((await pageCount(output)) !== inPages) {
        const e = new Error('page count mismatch'); e.kind = 'gs_failed'; throw e;
      }

      const inSize = (await fsp.stat(input)).size;
      let outSize = (await fsp.stat(output)).size;
      let sendPath = output;
      let compressed = true;
      // Never return a bigger file than the user sent.
      if (outSize <= 0 || outSize >= inSize) { sendPath = input; outSize = inSize; compressed = false; }

      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="compressed.pdf"',
        'Cache-Control': 'no-store',
        'X-Original-Size': String(inSize),
        'X-Compressed-Size': String(outSize),
        'X-Compressed': compressed ? 'true' : 'false',
        'X-Level': level,
      });
      await new Promise((resolve, reject) => {
        const s = fs.createReadStream(sendPath);
        s.on('error', reject);
        res.on('finish', resolve);
        res.on('close', resolve);
        s.pipe(res);
      });
    } catch (err) {
      if (!res.headersSent) {
        if (err.kind === 'encrypted') res.status(422).json({ error: 'pdf_is_password_protected' });
        else if (err.kind === 'timeout') res.status(504).json({ error: 'processing_timeout' });
        else res.status(422).json({ error: 'could_not_process_pdf' });
      }
      console.error(JSON.stringify({ evt: 'compress_error', kind: err.kind || 'unknown' }));
    } finally {
      if (acquired) release();
      await rm(input); await rm(output); // nothing is kept after the response
    }
  });
});

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// Safety net: remove any temp file older than 10 minutes.
setInterval(async () => {
  try {
    const now = Date.now();
    for (const f of await fsp.readdir(workDir)) {
      const p = path.join(workDir, f);
      const st = await fsp.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > 10 * 60 * 1000) await rm(p);
    }
  } catch (_) { /* ignore */ }
}, 5 * 60 * 1000).unref();

app.listen(PORT, () => console.log(`compress-service listening on ${PORT}`));
