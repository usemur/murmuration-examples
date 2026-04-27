# IPFS Upload Flow

Generate a Pinata presigned URL for direct IPFS uploads. The Pinata API key stays secret inside the TEE — agents pay per request via x402 and upload directly without needing their own account.

## Secrets

| Secret | Description |
|--------|-------------|
| `PINATA_JWT` | Pinata JWT for API access |

## Price

1 cent per call.

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `filename` | string | no | Filename for the upload (default: "upload") |
| `mimeType` | string | no | MIME type filter (e.g. "application/json", "image/*") |
| `maxSize` | number | no | Max file size in bytes (default: 50MB, max: 100MB) |
| `expires` | number | no | URL TTL in seconds (default: 3600, max: 86400) |

## Response

| Field | Description |
|-------|-------------|
| `uploadUrl` | Presigned URL — POST multipart form data here |
| `expires` | URL TTL in seconds |
| `maxSize` | Enforced max file size in bytes |
| `gateway` | IPFS gateway base URL for retrieving files |

## Usage

```js
// 1. Get a presigned URL from the flow
const result = await invokeFlow('ipfs-upload', {
  filename: 'data.json',
  mimeType: 'application/json',
});

// 2. Upload directly to Pinata
const form = new FormData();
form.append('file', new Blob([myData], { type: 'application/json' }), 'data.json');
const uploadRes = await fetch(result.uploadUrl, { method: 'POST', body: form });
const { data } = await uploadRes.json();
console.log('CID:', data.cid);

// 3. Retrieve via IPFS gateway
const content = await fetch(result.gateway + data.cid);
```

## E2E Test

```bash
npx tsx scripts/prod-e2e.ts --flow ipfs-upload
```
