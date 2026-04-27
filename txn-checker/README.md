# Transaction Checker Flow

Two-layer verification for EVM transactions. Deterministic triggers run first for fast, cheap rejection of obviously bad transactions. Graph-of-Thoughts (GoT) LLM reasoning runs only when all triggers pass, analyzing intent alignment, adversarial patterns, and compliance.

Perfect for agents that need to verify transactions before signing — catch phishing, sanctions violations, insufficient balances, and unexpected token approvals.

## Secrets

| Secret | Description |
|--------|-------------|
| `ALCHEMY_API_KEY` | Alchemy API key for on-chain lookups |
| `OPENROUTER_API_KEY` | OpenRouter key for LLM reasoning |

## Price

1 cent per call.

## Layer 1: Deterministic Triggers

Fast binary checks that reject immediately on failure:
- **Address validity** — valid EVM hex format
- **Contract existence** — target has deployed code
- **OFAC sanctions** — Chainalysis on-chain oracle (both sender and target)
- **Balance sufficiency** — ETH balance covers value + gas
- **Gas estimation** — transaction won't revert
- **Spending limits** — optional caller-supplied constraints
- **Function validation** — optional expected function check

## Layer 2: Graph-of-Thoughts Reasoning

Three independent LLM reasoning paths, then synthesis:
- **Path A (Intent Alignment)** — Does the transaction match the stated intent?
- **Path B (Adversarial Detection)** — Hidden swaps, unlimited approvals, phishing?
- **Path C (Compliance)** — Regulatory concerns, mixing services, auditability?

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | yes | Target contract address |
| `from` | string | yes | Sender address |
| `data` | string | yes | Transaction calldata (hex-encoded) |
| `value` | string | no | ETH value in wei (hex, default `"0x0"`) |
| `chain` | string | no | Chain name (default: `"ethereum"`) |
| `intent` | string | yes | Natural language description of what this txn should do |
| `maxValueWei` | string | no | Max ETH value allowed (decimal string) |
| `maxApprovalAmount` | number | no | Max token approval allowed (in token base units) |
| `expectedFunction` | string | no | Expected function name (e.g. `"approve"`) |

### Supported chains

`ethereum`, `polygon`, `arbitrum`, `optimism`, `base`, `zksync`, `scroll`, `linea`, `avalanche`, `bnb`

## Response

| Field | Description |
|-------|-------------|
| `confidenceScore` | 0-100 score that the transaction matches the intent |
| `verdict` | `SAFE`, `SUSPICIOUS`, `DANGEROUS`, `REJECTED`, or `ERROR` |
| `intentMatch` | Whether the transaction matches the stated intent |
| `summary` | Human-readable summary |
| `triggers` | Array of deterministic trigger results (name, passed, detail) |
| `allTriggersPassed` | Whether all triggers passed |
| `reasoning` | GoT reasoning trace (pathA, pathB, pathC, synthesis) |
| `transaction` | Transaction details (chain, function, gas estimate) |
| `contract` | Contract info (Sourcify, metadata, identification) |
| `simulation` | Alchemy simulation results |
| `risks` | Aggregated risk list |

## Usage

```js
const result = await invokeFlow('txn-checker', {
  to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  from: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  data: '0x095ea7b3...',
  chain: 'ethereum',
  intent: 'Approve 10 USDC for Aave V3 deposit',
});
// result.verdict → "SAFE"
// result.allTriggersPassed → true
```
