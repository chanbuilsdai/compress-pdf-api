// Local test: needs the API on EDITPDF_API_BASE and test PDFs on FILES_BASE.
const { test } = require('node:test');
const assert = require('node:assert');
const zapier = require('zapier-platform-core');
const App = require('../index');
const appTester = zapier.createAppTester(App);
zapier.tools.env.inject();

const authData = { api_key: process.env.TEST_API_KEY };
const FILES = process.env.FILES_BASE;

test('auth test returns account', async () => {
  const r = await appTester(App.authentication.test, { authData });
  assert.ok(r.email);
});

test('bad key fails auth', async () => {
  await assert.rejects(appTester(App.authentication.test, { authData: { api_key: 'ept_wrong' } }), /Invalid API key/);
});

test('compress small image PDF reaches the file-stash step', async () => {
  // z.stashFile only works inside Zapier. Locally, reaching it means the API call returned 200.
  await assert.rejects(
    appTester(App.creates.compress_pdf.operation.perform, { authData, inputData: { file: FILES + '/small_img.pdf', filename: 'scan.pdf', level: 'recommended' } }),
    /No token found - cannot call RPC/
  );
});

test('3 MB file blocked in Zapier (2 MB)', async () => {
  await assert.rejects(appTester(App.creates.compress_pdf.operation.perform, { authData, inputData: { file: FILES + '/mid.pdf' } }), /Max 2 MB in Zapier/);
});

test('not a pdf gives readable error', async () => {
  await assert.rejects(appTester(App.creates.compress_pdf.operation.perform, { authData, inputData: { file: FILES + '/notpdf.txt' } }));
});
