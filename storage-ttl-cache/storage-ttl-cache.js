// Storage TTL Cache - caches a fetched JSON response for 300 seconds for publishers reducing latency and upstream calls.
// A missing key returns null, and this example treats null as a cache miss.
//
// Input:
// - params.url (optional string)
// - params.cacheKey (optional short string)
// Output:
// - { source, data }

const url = typeof params.url === 'string' && params.url ? params.url : 'https://httpbin.org/json';
const cacheSuffix =
  typeof params.cacheKey === 'string' && params.cacheKey ? params.cacheKey : 'httpbin-json';
const cacheKey = `cache:${cacheSuffix}`;
const cached = await storage.get(cacheKey);

if (cached === null) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  const data = await response.json();
  await storage.set(cacheKey, data, { ttlSec: 300 });
  return { source: 'origin', data };
}

return { source: 'cache', data: JSON.parse(cached) };
