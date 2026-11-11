'use strict';

// API key auth. The key is sent as X-API-Key on every request (see index.js).
const test = async (z) => {
  const res = await z.request({ url: (process.env.EDITPDF_API_BASE || 'https://api.editpdf.tools') + '/v1/me', method: 'GET', skipThrowForStatus: true });
  if (res.status === 401) throw new z.errors.Error('Invalid API key. Create one at https://api.editpdf.tools/dashboard', 'AuthenticationError', 401);
  if (res.status === 403) throw new z.errors.Error('This account is blocked. Contact support@editpdf.tools', 'AuthenticationError', 403);
  if (res.status !== 200) throw new z.errors.Error(`Could not check the key (HTTP ${res.status}). Try again in a minute.`, 'ApiError', res.status);
  return res.json;
};

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'api_key',
      label: 'API Key',
      required: true,
      type: 'password',
      helpText: 'Get a free API key at [api.editpdf.tools](https://api.editpdf.tools/signup). Sign in with your email, then click Create API key in the dashboard.',
    },
  ],
  test,
  // The test result (/v1/me) is passed in as bundle.inputData.
  connectionLabel: (z, bundle) => (bundle.inputData && bundle.inputData.email) || 'editpdf.tools account',
};
