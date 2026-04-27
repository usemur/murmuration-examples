// IPFS Upload — generate a Pinata presigned URL for direct IPFS uploads.
//
// A general-purpose primitive: any agent that needs to put something on IPFS
// can use this flow to get a presigned upload URL without managing their own
// Pinata API key. The key stays secret inside the TEE.
//
// Secrets required: PINATA_JWT
//
// Input: {
//   filename?: string,        // optional filename (default: "upload")
//   mimeType?: string,        // optional MIME type filter (e.g. "application/json", "image/*")
//   maxSize?: number,         // optional max file size in bytes (default: 52428800 = 50MB)
//   expires?: number          // optional presigned URL TTL in seconds (default: 3600 = 1hr)
// }
//
// Output: {
//   uploadUrl: string,        // presigned URL — POST multipart form data here
//   expires: number,          // TTL in seconds
//   maxSize: number,          // enforced max file size in bytes
//   gateway: string           // IPFS gateway base URL for retrieving files
// }

// ── Validate secrets ────────────────────────────────────────────

var pinataJwt = params.secrets && params.secrets.PINATA_JWT;
if (!pinataJwt) {
  Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing PINATA_JWT secret' }) });
  throw new Error('Missing PINATA_JWT secret');
}

// ── Parse & validate inputs ─────────────────────────────────────

var filename = params.filename || 'upload';
var maxSize = params.maxSize || 52428800; // 50MB default
var expires = params.expires || 3600;     // 1 hour default

// Enforce hard limits
var HARD_MAX_SIZE = 104857600; // 100MB absolute max
if (maxSize > HARD_MAX_SIZE) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'maxSize cannot exceed ' + HARD_MAX_SIZE + ' bytes (100MB)' }),
  });
  throw new Error('maxSize too large');
}

var MAX_EXPIRES = 86400; // 24 hours
if (expires > MAX_EXPIRES) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'expires cannot exceed ' + MAX_EXPIRES + ' seconds (24h)' }),
  });
  throw new Error('expires too large');
}

// ── Generate presigned URL ──────────────────────────────────────

var signBody = {
  network: 'public',
  date: Math.floor(Date.now() / 1000),
  expires: expires,
  filename: filename,
  max_file_size: maxSize,
};

if (params.mimeType) {
  signBody.allow_mime_types = [params.mimeType];
}

var res = await fetch('https://uploads.pinata.cloud/v3/files/sign', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + pinataJwt,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(signBody),
});

if (!res.ok) {
  var errText = await res.text();
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: 'Pinata API error (' + res.status + ')',
      detail: errText.slice(0, 500),
    }),
  });
  throw new Error('Pinata API error: ' + res.status);
}

var signData = await res.json();
var uploadUrl = signData.data || signData.url || signData;

if (!uploadUrl || typeof uploadUrl !== 'string') {
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: 'Unexpected Pinata response format',
      detail: JSON.stringify(signData).slice(0, 500),
    }),
  });
  throw new Error('Unexpected Pinata response');
}

Lit.Actions.setResponse({
  response: JSON.stringify({
    uploadUrl: uploadUrl,
    expires: expires,
    maxSize: maxSize,
    gateway: 'https://gateway.pinata.cloud/ipfs/',
  }),
});
