# Dead Drop Flow

Atomic exchange of encrypted digital goods between two agents that don't trust each other. A Claude AI agent verifies both payloads against natural-language criteria, and the vault PKP signs an on-chain attestation.

## How it works

```
1. Agent A creates a drop on-chain (DeadDrop.sol on Base) with criteria
2. Agent B joins the drop
3. Both get per-drop encryption keys from the flow (derived from vault PKP)
4. Both encrypt their payloads locally, upload to IPFS (via ipfs-upload flow)
5. Both deposit their IPFS CIDs
6. Either triggers verification — TEE derives decryption keys, gives them + CIDs
   to a Claude managed agent which fetches, decrypts (Node.js), and checks criteria
7. If approved: both receive the other's decryption key + CID + on-chain attestation
```

The Claude managed agent has Bash, Node.js, and web access — it fetches from IPFS, decrypts with AES-256-GCM, and evaluates content. No TEE payload size limit.

## Secrets

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude managed agent |
| `MANAGED_AGENT_ID` | Claude managed agent ID |
| `MANAGED_ENV_ID` | Claude managed agent environment ID |

## Price

1-5 cents per action (create/join/get-key/deposit are cheap, verify/release are 5 cents).

## Actions

| Action | Description | Input |
|--------|-------------|-------|
| `create` | Register criteria | `{ dropId, criteria: { sideA, sideB } }` |
| `join` | Acknowledge joining | `{ dropId }` |
| `get-key` | Get your encryption key | `{ dropId, role: "a"\|"b", signature }` |
| `deposit` | Record your IPFS CID | `{ dropId, role, cid }` |
| `verify` | Trigger AI verification | `{ dropId, cidA, cidB, criteria }` |
| `status` | Poll verification | `{ sessionId }` |
| `release` | Get cross-keys + attestation | `{ dropId, sessionId, role, signature }` |

## Client helper

A TypeScript CLI handles the full encrypt → upload → deposit pipeline:

```bash
# Encrypt + upload + deposit a file (all-in-one)
MUR_API_KEY=your_key npx tsx examples/dead-drop/client.ts deposit \
  --drop-id 0 --role a --file ./dataset.json

# Just encrypt locally (no upload)
MUR_API_KEY=your_key npx tsx examples/dead-drop/client.ts encrypt \
  --drop-id 0 --role a --file ./dataset.json --out ./dataset.enc

# Download + decrypt after release (no API key needed)
npx tsx examples/dead-drop/client.ts decrypt \
  --cid QmAbc... --key 0xdef... --out ./received-payload.json
```

The `deposit` command orchestrates 5 steps automatically:
1. Gets encryption key from dead-drop flow (`get-key`)
2. Encrypts locally with AES-256-GCM
3. Gets presigned IPFS upload URL from ipfs-upload flow
4. Uploads encrypted blob directly to Pinata
5. Deposits CID with dead-drop flow

## Encryption for agents (DIY)

If you're building your own client, the encryption is standard AES-256-GCM:

```js
// Node.js / browser
const keyBytes = hexToBytes(encryptionKey); // 32 bytes from get-key
const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
const blob = new Uint8Array([...iv, ...new Uint8Array(ciphertext)]);
// Upload `blob` to IPFS using presigned URL from ipfs-upload flow
```

```python
# Python
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
key = bytes.fromhex(encryption_key[2:])  # strip 0x
nonce = os.urandom(12)
ciphertext = AESGCM(key).encrypt(nonce, plaintext, None)
blob = nonce + ciphertext  # upload this to IPFS
```

Key derivation: `keccak256(vaultPrivateKey || dropId || role)` — per-drop, per-side.

Format: `[12-byte random IV][ciphertext][16-byte GCM auth tag]`

## Contract: DeadDrop.sol

**Live on Base:** [`0xC72c5462F6B78e50eBe2BBFccd1992C663e15054`](https://basescan.org/address/0xC72c5462F6B78e50eBe2BBFccd1992C663e15054) (verified)

Tracks drop lifecycle, stores CIDs and hash commitments, holds optional ETH stakes, verifies vault PKP signature on release.

| Function | Description |
|----------|-------------|
| `createDrop(arbiter, criteriaHash, timeout)` | Create drop with optional ETH stake. Payable. |
| `joinDrop(dropId)` | Join as party B with optional stake. Payable. |
| `deposit(dropId, commitment, cid)` | Record encrypted payload CID. |
| `releaseDrop(dropId, signature)` | Release stakes with arbiter signature. |
| `refundDrop(dropId)` | Reclaim stakes after deadline. |
| `cancelDrop(dropId)` | Cancel before both deposits. |

## Signature scheme

```
// Release attestation
messageHash = keccak256(abi.encodePacked("DEAD_DROP_RELEASE", dropId, partyA, partyB, chainId))
signature = wallet.signMessage(arrayify(messageHash))   // EIP-191
```

## E2E Test

```bash
npx tsx scripts/prod-e2e.ts --flow dead-drop
```
