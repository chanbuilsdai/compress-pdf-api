// Compress a PDF with the editpdf.tools Compress PDF API (Node.js 20+, no packages).
//
//   EDITPDF_API_KEY=ept_... node compress-pdf.mjs input.pdf [light|recommended|strong]
//
// Free plan: 30 files per month, up to 10 MB each, 1 file per minute.
// Docs: https://editpdf.tools/compress-pdf-api
import { openAsBlob } from 'node:fs';
import { writeFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

const API = (process.env.EDITPDF_API_BASE || 'https://api.editpdf.tools') + '/v1/compress';
const key = process.env.EDITPDF_API_KEY;
const [input, level = 'recommended'] = process.argv.slice(2);

if (!key) throw new Error('Set EDITPDF_API_KEY first (free key: https://api.editpdf.tools/signup)');
if (!input) throw new Error('Usage: node compress-pdf.mjs input.pdf [level]');
if ((await stat(input)).size > 10 * 1024 * 1024) throw new Error('The free plan accepts files up to 10 MB');

async function compress(tries = 5) {
  const form = new FormData();
  form.append('file', await openAsBlob(input, { type: 'application/pdf' }), basename(input));
  form.append('level', level);

  const res = await fetch(API, { method: 'POST', headers: { 'X-API-Key': key }, body: form });
  if (res.ok) return res;

  const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  const retryable = (res.status === 429 || res.status === 503) && err.error !== 'monthly_quota_reached';
  if (retryable && tries > 1) {
    const wait = Number(res.headers.get('retry-after')) || 60;
    console.log(`${err.error}: waiting ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return compress(tries - 1);
  }
  throw new Error(err.message || err.error);
}

const res = await compress();
const out = input.replace(/\.pdf$/i, '') + '-compressed.pdf';
await writeFile(out, Buffer.from(await res.arrayBuffer()));

const before = Number(res.headers.get('x-original-size'));
const after = Number(res.headers.get('x-compressed-size'));
console.log(`${out}: ${before} -> ${after} bytes (${((1 - after / before) * 100).toFixed(1)}% smaller), ` +
  `${res.headers.get('x-quota-remaining')} files left this month`);
