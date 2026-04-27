# Storage Session Memory Flow

Keeps a rolling buffer of the last 10 chat messages for each caller — a lightweight "agent memory" pattern. Stores the full transcript as a single JSON array under the `messages` key.

Storage scope is automatic per `(flow, caller)`, so each caller gets their own private transcript.

## Secrets

None required.

## Price

Free (no `pricePerCall` set in this example).

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `role` | string | no | `"user"` or `"assistant"` (defaults to `"user"`) |
| `content` | string | no | Message text. Omit to read the transcript without writing a new turn. |

## Response

| Field | Description |
|-------|-------------|
| `messages` | Array of `{ role, content, at }` — the last 10 messages |

## Usage

```js
// Push a user turn
await invokeFlow('storage-session-memory', {
  role: 'user',
  content: 'What is Lit Protocol?',
});

// Push an assistant turn
await invokeFlow('storage-session-memory', {
  role: 'assistant',
  content: 'Lit Protocol is a decentralized key management network.',
});

// Read without writing
const { messages } = await invokeFlow('storage-session-memory', {});
// → messages.length up to 10, oldest evicted as new turns arrive
```

## Source

[`storage-session-memory.js`](./storage-session-memory.js)
