# Storage Preferences Flow

Persists a single per-caller preferences object (in this example, a `theme`). The simplest possible "remember this user" pattern — one key, JSON in, JSON out.

Storage scope is automatic per `(flow, caller)`, so each caller gets their own independent `prefs` key.

## Secrets

None required.

## Price

Free (no `pricePerCall` set in this example).

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `theme` | string | no | New theme to save. Omit to read the current value without changing it. |

## Response

| Field | Description |
|-------|-------------|
| `before` | The previous preferences object (defaults to `{ theme: 'light' }` if unset) |
| `after` | The current preferences object after this call |

## Usage

```js
// First call — read defaults
await invokeFlow('storage-preferences', {});
// → { before: { theme: 'light' }, after: { theme: 'light' } }

// Update
await invokeFlow('storage-preferences', { theme: 'dark' });
// → { before: { theme: 'light' }, after: { theme: 'dark' } }

// Read back
await invokeFlow('storage-preferences', {});
// → { before: { theme: 'dark' }, after: { theme: 'dark' } }
```

## Source

[`storage-preferences.js`](./storage-preferences.js)
