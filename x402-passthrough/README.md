# x402 Passthrough — Credit Card Bridge to x402 APIs

Use any x402 API endpoint using a credit card and Murmuration platform credits. No crypto needed.

## Why this exists

[x402](https://x402.org) is a breakthrough in how APIs work. Instead of signing up for dozens of different API providers, managing API keys, and dealing with monthly plans, x402 lets you just pay per request with a single protocol. No signups. No rate limits. No monthly invoices. Any API that supports x402 works the same way.

The problem? x402 runs on crypto (USDC), and getting crypto is hard if you've never done it. You need a wallet, you need to buy tokens, you need to understand gas and chains. That's a lot of friction just to call an API.

## What this flow does

This flow is a credit card bridge to the entire x402 ecosystem. You sign up once on Murmuration, load credits with a credit card, and you can use any x402-enabled API on the internet. The flow handles all the crypto behind the scenes — you never touch a wallet, buy tokens, or think about blockchain.

```
You (credit card) → Murmuration (credits) → x402 Passthrough (vault wallet) → Any x402 API
```

One signup. One credit balance. Access to every x402 API.

## Dynamic pricing

This flow uses "up to" pricing. You authorize a maximum per call, but you only pay what the upstream API actually charges. If an API costs $0.01 and your max is $0.10, you're billed $0.01.

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `targetUrl` | string | yes | The x402-protected URL to call |
| `method` | string | no | HTTP method (default: GET) |
| `body` | object | no | Request body (JSON) |
| `headers` | object | no | Additional headers |

## Response

| Field | Description |
|-------|-------------|
| `data` | The upstream API response |
| `upstreamStatus` | HTTP status from the upstream |
| `_actualCost` | What was actually charged (6-decimal raw units) |
| `paidTo` | Address that received the payment |
| `paidFrom` | Vault wallet address that made the payment |

## Example

Search the web via Exa (an x402-enabled search API):

```bash
curl -X POST https://usemur.dev/api/flows/x402-passthrough/invoke \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "targetUrl": "https://stableenrich.dev/api/exa/search",
      "method": "POST",
      "body": { "query": "AI agents", "numResults": 3 }
    }
  }'
```

Point `targetUrl` at any x402 endpoint — the flow reads the payment requirements and handles everything.

## How it works under the hood

1. Your request hits the target URL
2. The upstream returns HTTP 402 with payment requirements
3. The flow's vault wallet (running in a TEE) signs a USDC payment on Base
4. The flow re-sends your request with the signed payment
5. The upstream verifies payment and returns data
6. You're only charged what was actually used
