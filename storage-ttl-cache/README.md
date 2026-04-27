# Storage TTL Cache Flow

Caches a fetched JSON response under a TTL'd storage key. On a hit, returns the cached payload; on a miss, fetches the upstream URL, stores the result with `ttlSec: 300`, and returns it.

Demonstrates the canonical "expensive upstream call, cache for N seconds" pattern. A missing key returns `null`, which this example treats as a cache miss.

Storage scope is automatic per `(flow, caller)`, so each caller has their own cache.

## Secrets

None required.

## Price

Free (no `pricePerCall` set in this example).

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | no | URL to fetch (defaults to `https://httpbin.org/json`) |
| `cacheKey` | string | no | Short suffix for the cache key (defaults to `httpbin-json`). The full key is `cache:<cacheKey>`. |

## Response

| Field | Description |
|-------|-------------|
| `source` | `"origin"` on a cache miss, `"cache"` on a cache hit |
| `data` | The JSON payload (fresh from the URL or replayed from cache) |

## Usage

```js
// First call — cache miss, fetches origin
const a = await invokeFlow('storage-ttl-cache', {
  url: 'https://api.example.com/prices',
  cacheKey: 'prices',
});
// → { source: 'origin', data: { ... } }

// Within 5 minutes — cache hit
const b = await invokeFlow('storage-ttl-cache', {
  url: 'https://api.example.com/prices',
  cacheKey: 'prices',
});
// → { source: 'cache', data: { ... } }
```

## Source

[`storage-ttl-cache.js`](./storage-ttl-cache.js)
