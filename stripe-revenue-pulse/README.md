# Stripe Revenue Pulse

A reference flow that produces a daily revenue + new-customer summary from a
Stripe account. Demonstrates:

- Composio-brokered Stripe OAuth (read-only)
- Paginated Stripe list endpoints (charges, customers, subscriptions, events)
- Pure-JS revenue + MRR + churn math
- Domain enrichment via `fetch` with a strict PII boundary

## What this answers

> *"Yesterday: $4,820 in revenue across 38 charges. 7 new customers — Acme
> Robotics is a Series A doing warehouse automation. MRR $42,180 (+$1,200 net
> new this week, 1 churn @ $99). 2 failed charges, $340 at risk."*

The flow returns a structured payload; the caller renders.

## Required connection

- **Stripe** — connect via Composio OAuth at the platform's integrations
  page. Read-only is enough; this flow never writes.

## Inputs

All optional.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `tz` | string | `'UTC'` | IANA TZ. Used to compute "yesterday" in caller-local time. |
| `muteDomains` | string[] | `[]` | Lowercase domains that skip enrichment (e.g. `'bigbank.com'`). |
| `customerResearchEnabled` | boolean | `true` | Set to `false` to skip the homepage-fetch enrichment loop entirely. |

## Output

```jsonc
{
  "window": { "yesterdayStartSec": 1777824000, "yesterdayEndSec": 1777910400 },
  "revenue": { "totalCents": 482000, "chargeCount": 38, "foreignCurrencyCount": 0 },
  "mrrSnapshot": { "mrrCents": 4218000, "trialingCount": 4, "pausedCount": 0, "foreignCurrencyCount": 0 },
  "churn": { "count": 1, "lostMrrCents": 9900 },
  "failedCharges": { "count": 2, "atRiskCents": 34000 },
  "newCustomers": [
    { "email": "alice@acme-robotics.com", "summary": "Acme Robotics — warehouse automation" },
    { "email": "dev@stealthco.xyz", "unreachable": true },
    { "email": "someone@gmail.com", "freeEmail": true },
    { "email": "jenkins@bigbank.com", "muted": true }
  ]
}
```

## PII boundary

The only customer field that ever crosses the `fetch` boundary is the **email
domain**. Local-parts, full emails, and customer names stay inside the flow's
compute. If you fork this flow, keep that property — it's the most important
contract for trust with the founder.

## Why this is a useful reference

- Shows how to consume a Composio-brokered OAuth bearer for a real
  third-party API.
- Cleanly separates I/O from pure compute (helpers at the bottom of the
  file are testable as pure functions).
- Shows the right shape for a "scan-and-summarize" daily flow that other
  publishers can adapt to other APIs (Mixpanel, Segment, PostHog, Linear,
  GitHub).

## Limits

- 5-page cap on each Stripe list (≤500 items per query). Small-to-mid
  accounts always fit; very large accounts will silently truncate.
- Multi-currency: v1 reports the account's default currency only.
  Foreign-currency activity is counted but excluded from totals.
- "Net new MRR this week" requires storing yesterday's MRR snapshot
  somewhere persistent. This example doesn't — calling it daily and
  caching the prior day's `mrrSnapshot.mrrCents` is left to the caller.

## Where the production version lives

The Murmuration cofounder daemon ships this finding as a native digest
pillar at `src/services/cofounder/pillars/revenuePulse.ts`. This example
is the publisher-style equivalent — same operation, different home.
