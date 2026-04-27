// Non-US Proxy — returns a non-US (Mexico) proxy from a managed proxy pool.
//
// The proxy provider API key stays secret inside the TEE. Consumers get
// proxy connection details they can use in their own HTTP client.
//
// Secrets required: WEBSHARE_API_KEY
// Input: (none required)
// Output: { proxy: { host, port, username, password, country, city } }

const apiKey = params.secrets?.WEBSHARE_API_KEY;
if (!apiKey) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'Missing proxy provider API key' }),
  });
  throw new Error('Missing proxy provider API key');
}

// Get a Mexico proxy from the pool
const proxyListRes = await fetch(
  'https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&country_code__in=MX&page_size=10',
  { headers: { Authorization: `Token ${apiKey}` } },
);

if (!proxyListRes.ok) {
  const errText = await proxyListRes.text();
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: `Proxy provider API failed (${proxyListRes.status})`,
      body: errText.slice(0, 500),
    }),
  });
  throw new Error(`Proxy provider API failed: ${proxyListRes.status}`);
}

const proxyList = await proxyListRes.json();
if (!proxyList.results || proxyList.results.length === 0) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'No Mexico proxies available in pool' }),
  });
  throw new Error('No Mexico proxies available');
}

// Pick a random proxy from the results
const proxy = proxyList.results[Math.floor(Math.random() * proxyList.results.length)];

Lit.Actions.setResponse({
  response: JSON.stringify({
    proxy: {
      host: proxy.proxy_address,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password,
      country: proxy.country_code,
      city: proxy.city_name,
    },
  }),
});
