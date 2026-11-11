'use strict';

const authentication = require('./authentication');
const compressPdf = require('./creates/compress_pdf');

// Add the API key to every request to api.editpdf.tools (never to file downloads).
const addApiKey = (request, z, bundle) => {
  const base = (process.env.EDITPDF_API_BASE || 'https://api.editpdf.tools') + '/';
  if (String(request.url || '').startsWith(base)) {
    request.headers = request.headers || {};
    request.headers['X-API-Key'] = bundle.authData.api_key;
  }
  return request;
};

module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,
  authentication,
  beforeRequest: [addApiKey],
  creates: { [compressPdf.key]: compressPdf },
  triggers: {},
  searches: {},
};
