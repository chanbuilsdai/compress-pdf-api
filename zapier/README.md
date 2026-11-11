# editpdf.tools Zapier integration

One action: **Compress PDF** (files up to 2 MB, because Zapier stops actions after 30 seconds).
Auth: API key from https://api.editpdf.tools (sent as `X-API-Key`). Requests carry `X-Integration: zapier`.

## Deploy (owner, Windows)
```
npm install
npm install -g zapier-platform-cli
zapier login                      # sign in as support@editpdf.tools
zapier register "editpdf.tools"   # first time only
zapier push
```
Then in the Zapier Developer Platform: add the logo, description and homepage, test in a real Zap, and submit for publishing.

## Local test (needs the API running locally)
```
EDITPDF_API_BASE=http://localhost:8787 FILES_BASE=http://localhost:8099 TEST_API_KEY=ept_... npm test
```
