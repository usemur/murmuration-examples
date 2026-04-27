# Storage Counter Flow

A minimal counter that demonstrates the read-modify-write pattern against per-call storage. Useful as a copy-paste starting point when you want a flow to remember a single number across invocations.

> **⚠ Not race-safe.** Concurrent invocations can clobber each other. An atomic `storage.increment` helper is planned for v2 — until then, treat this as illustrative, not as a high-throughput counter primitive.

Storage scope is automatic per `(flow, caller)`, so every caller has their own independent `count` key.

## Secrets

None required.

## Price

Free (no `pricePerCall` set in this example).

## Parameters

No parameters required.

## Response

| Field | Description |
|-------|-------------|
| `count` | The new counter value after this invocation |

## Usage

```js
const first = await invokeFlow('storage-counter', {});
// → { count: 1 }

const second = await invokeFlow('storage-counter', {});
// → { count: 2 }
```

## Source

[`storage-counter.js`](./storage-counter.js)
