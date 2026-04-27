# Non-US Proxy Flow

Returns proxy connection details for a non-US (Mexico) residential/datacenter proxy. The provider API key stays secret inside the TEE — consumers only receive the proxy credentials needed to route their traffic.

## Secrets

| Secret | Description |
|--------|-------------|
| `WEBSHARE_API_KEY` | Proxy provider API key |

## Price

2 cents per call.

## Parameters

No parameters required.

## Response

| Field | Description |
|-------|-------------|
| `proxy.host` | Proxy IP address |
| `proxy.port` | Proxy port number |
| `proxy.username` | Proxy auth username |
| `proxy.password` | Proxy auth password |
| `proxy.country` | Country code (MX) |
| `proxy.city` | City name |

## Usage

```js
const result = await invokeFlow('non-us-proxy', {});
const { host, port, username, password } = result.proxy;

// Use in your HTTP client
const response = await fetch(targetUrl, {
  agent: new HttpsProxyAgent(`http://${username}:${password}@${host}:${port}`)
});
```
