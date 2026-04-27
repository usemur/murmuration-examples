# Oracle Flow

Fetches any URL and returns the response body along with a cryptographic signature from the flow's vault PKP. Consumers can verify the data was fetched inside a TEE and hasn't been tampered with.

## Secrets

None required.

## Price

5 cents per call.

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | The URL to fetch |

## Response

| Field | Description |
|-------|-------------|
| `url` | The URL that was fetched |
| `response` | The raw response body |
| `dataHash` | `keccak256(response)` — the hash that was signed |
| `signature` | EIP-191 signature over the raw bytes of `dataHash` |
| `signerAddress` | The vault PKP's Ethereum address |

## Verifying the Signature

```js
import { ethers } from 'ethers';

// 1. Recompute the hash from the response body
const recomputedHash = ethers.keccak256(ethers.toUtf8Bytes(result.response));
assert(recomputedHash === result.dataHash);

// 2. Recover the signer from the signature
const recovered = ethers.verifyMessage(
  ethers.getBytes(result.dataHash),
  result.signature,
);
assert(recovered.toLowerCase() === result.signerAddress.toLowerCase());
```

The `signerAddress` should match the flow's vault PKP address, visible on the flow's public page.
