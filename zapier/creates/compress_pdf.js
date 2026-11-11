'use strict';

const FormData = require('form-data');

const MAX_MB = 2; // Zapier stops actions after 30 s, so we keep files small here.
const BASE = process.env.EDITPDF_API_BASE || 'https://api.editpdf.tools';
const API = BASE + '/v1/compress';

const errorMessage = (body, status) => {
  if (body && body.message) return body.message;
  const map = {
    invalid_api_key: 'Invalid API key. Reconnect your editpdf.tools account.',
    account_blocked: 'This account is blocked. Contact support@editpdf.tools.',
    file_too_large: `The file is too large. Max ${MAX_MB} MB in Zapier.`,
    not_a_pdf: 'The file is not a PDF.',
    pdf_is_password_protected: 'Password-protected PDFs are not supported.',
    could_not_read_pdf: 'The PDF could not be read. It may be damaged.',
    could_not_process_pdf: 'The PDF could not be processed.',
    rate_limited: 'Too many files in a short time. Zapier will retry, or wait a minute.',
    monthly_quota_reached: 'Your monthly file limit is reached. It resets on the 1st (UTC).',
    service_starting_retry_in_60s: 'The service is starting. Please retry in a minute.',
    processing_timeout: 'The file took too long to compress. Try the "strong" level or a smaller file.',
  };
  const code = body && body.error;
  return map[code] || `Compression failed (${code || 'HTTP ' + status}).`;
};

const perform = async (z, bundle) => {
  // 1. Download the file Zapier passes in (a URL or a hydrated file).
  const src = await z.request({ url: bundle.inputData.file, raw: true, skipThrowForStatus: true });
  if (src.status >= 400) throw new z.errors.Error(`Could not download the input file (HTTP ${src.status}).`, 'InputError', src.status);
  const input = await src.buffer();
  if (input.length > MAX_MB * 1024 * 1024) {
    throw new z.errors.Error(`The file is ${(input.length / 1048576).toFixed(1)} MB. Max ${MAX_MB} MB in Zapier. Use the API directly for files up to 10 MB: https://editpdf.tools/compress-pdf-api`, 'FileTooLarge', 413);
  }
  // cleanInputData is off, so trim the raw values ourselves.
  const name = (String(bundle.inputData.filename || '').trim() || 'document.pdf').replace(/[^\w.\- ]+/g, '_').slice(0, 100);
  const level = String(bundle.inputData.level || '').trim().toLowerCase() || 'recommended';

  // 2. Send it to the API.
  const form = new FormData();
  form.append('file', input, { filename: name.toLowerCase().endsWith('.pdf') ? name : name + '.pdf', contentType: 'application/pdf' });
  form.append('level', level);

  const res = await z.request({
    url: API,
    method: 'POST',
    body: form,
    headers: { ...form.getHeaders(), 'Content-Length': String(form.getLengthSync()), 'X-Integration': 'zapier' },
    raw: true,
    skipThrowForStatus: true,
  });

  if (res.status !== 200) {
    let body = null;
    try { body = JSON.parse(await res.text()); } catch (_) { /* not JSON */ }
    if (res.status === 429 && body && body.error === 'rate_limited') throw new z.errors.ThrottledError(errorMessage(body, res.status), Number(body.retry_after_seconds) || 60);
    if (res.status === 503) throw new z.errors.ThrottledError(errorMessage(body, res.status), 60);
    throw new z.errors.Error(errorMessage(body, res.status), body && body.error ? body.error : 'ApiError', res.status);
  }

  // 3. Store the result so later Zap steps can use it.
  const output = await res.buffer();
  const outName = name.replace(/\.pdf$/i, '') + '-compressed.pdf';
  const file = await z.stashFile(output, output.length, outName, 'application/pdf');

  const originalSize = Number(res.headers.get('x-original-size')) || input.length;
  const compressedSize = Number(res.headers.get('x-compressed-size')) || output.length;
  return {
    file,
    filename: outName,
    original_size: originalSize,
    compressed_size: compressedSize,
    saved_percent: originalSize ? Math.round((1 - compressedSize / originalSize) * 1000) / 10 : 0,
    compressed: res.headers.get('x-compressed') === 'true',
    level: res.headers.get('x-level') || level,
    quota_remaining: Number(res.headers.get('x-quota-remaining')),
  };
};

module.exports = {
  key: 'compress_pdf',
  noun: 'PDF',
  display: {
    label: 'Compress PDF',
    description: `Makes a PDF smaller. Files up to ${MAX_MB} MB.`,
  },
  operation: {
    cleanInputData: false,
    inputFields: [
      { key: 'file', label: 'PDF File', type: 'file', required: true, helpText: `The PDF to compress (max ${MAX_MB} MB in Zapier).` },
      { key: 'filename', label: 'File Name', type: 'string', required: false, helpText: 'Optional. Used to name the output file, for example invoice.pdf.' },
      {
        key: 'level', label: 'Compression Level', required: false, default: 'recommended',
        choices: { light: 'Light (best quality, 300 dpi images)', recommended: 'Recommended (150 dpi images)', strong: 'Strong (smallest file, 72 dpi images)' },
      },
    ],
    perform,
    sample: {
      file: 'https://example.com/invoice-compressed.pdf',
      filename: 'invoice-compressed.pdf',
      original_size: 1843200,
      compressed_size: 412300,
      saved_percent: 77.6,
      compressed: true,
      level: 'recommended',
      quota_remaining: 29,
    },
    outputFields: [
      { key: 'file', label: 'Compressed PDF', type: 'file' },
      { key: 'filename', label: 'File Name', type: 'string' },
      { key: 'original_size', label: 'Original Size (bytes)', type: 'integer' },
      { key: 'compressed_size', label: 'Compressed Size (bytes)', type: 'integer' },
      { key: 'saved_percent', label: 'Size Saved (%)', type: 'number' },
      { key: 'compressed', label: 'Was Compressed', type: 'boolean' },
      { key: 'level', label: 'Level Used', type: 'string' },
      { key: 'quota_remaining', label: 'Files Left This Month', type: 'integer' },
    ],
  },
};
