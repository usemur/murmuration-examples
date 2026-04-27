# GitHub Bounty Flow

AI-powered escrow for GitHub bounties. A Claude agent reviews whether a PR actually solves an issue — if it does, the flow signs an on-chain release so the contributor gets paid. No human arbiter needed.

**Live on Base:** Contract [`0x926470ef334b72c6eBDF540a434316e87a7Aa562`](https://basescan.org/address/0x926470ef334b72c6eBDF540a434316e87a7Aa562) (verified)

## Secrets

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude agent |
| `GITHUB_TOKEN` | GitHub personal access token (public repos read) |
| `MANAGED_AGENT_ID` | Claude managed agent ID |
| `MANAGED_ENV_ID` | Claude managed agent environment ID |

## Price

5 cents per invocation (a full claim→status→check cycle is ~15 cents).

## How it works

```
1. Depositor creates a bounty on-chain (ETH + issue URL + this flow as arbiter)
2. Contributor opens a PR and calls `claim` → spawns a Claude agent to review
3. Caller polls `status` until the agent finishes (~10-20s)
4. Caller calls `check` → gets APPROVED + EIP-191 signature, or REJECTED + reasoning
5. Contributor calls `releaseBounty()` on-chain with the signature → gets paid
```

## Actions

### `claim` — Start a review

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | yes | `"claim"` |
| `bountyId` | number | yes | On-chain bounty ID |
| `issueUrl` | string | yes | GitHub issue URL |
| `prUrl` | string | yes | GitHub PR URL |
| `claimantAddress` | string | yes | ETH address to receive funds |

### `status` — Lightweight poll

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | yes | `"status"` |
| `sessionId` | string | yes | Session ID from `claim` |

### `check` — Get verdict + signature

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | yes | `"check"` |
| `bountyId` | number | yes | On-chain bounty ID |
| `sessionId` | string | yes | Session ID from `claim` |
| `claimantAddress` | string | yes | ETH address to receive funds |
| `chainId` | number | no | Chain ID (default: 8453 / Base) |

## Contract

The `EscrowBounty.sol` contract (included in this folder) is a generic escrow that holds ETH and verifies arbiter signatures. It knows nothing about GitHub.

| Function | Description |
|----------|-------------|
| `createBounty(issueUrl, arbiter, timeout)` | Lock ETH with an arbiter and deadline. Payable. |
| `releaseBounty(bountyId, recipient, signature)` | Release to recipient if arbiter signed. Anyone can call. |
| `refundBounty(bountyId)` | Depositor reclaims after deadline. |
| `getBounty(bountyId)` | View bounty state. |

- **Base mainnet:** [`0x926470ef334b72c6eBDF540a434316e87a7Aa562`](https://basescan.org/address/0x926470ef334b72c6eBDF540a434316e87a7Aa562)
- **Arbiter:** `0xa7f3470d42091e5b6a84ddd3595d80aa9a2ff0f8` (this flow's vault PKP)

## Signature Scheme

```
messageHash = keccak256(abi.encodePacked("BOUNTY_RELEASE", bountyId, recipient, chainId))
signature = wallet.signMessage(arrayify(messageHash))   // EIP-191
```
