# Storage Notes Flow

A tiny CRUD-style flow that stores many small JSON notes under per-caller storage. Demonstrates how to use a key prefix (`note:`) so `storage.list({ prefix: 'note:' })` returns only the records you care about.

Each caller gets their own independent set of notes — storage scope is automatic per `(flow, caller)`.

## Secrets

None required.

## Price

Free (no `pricePerCall` set in this example).

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | no | `"create"`, `"delete"`, or `"list"` (default: `"list"`) |
| `id` | string | conditional | Required for `delete`; optional for `create` (auto-generated if omitted) |
| `title` | string | no | Note title (defaults to `"Untitled"` on create) |
| `body` | string | no | Note body |

## Response

| Field | Description |
|-------|-------------|
| `ok` | `true` on `create` and `delete` |
| `createdKey` | Full storage key of the new note (on `create`) |
| `deletedKey` | Full storage key of the removed note (on `delete`) |
| `notes` | Array of `{ key, updatedAt, value }` (on `list`) |
| `nextCursor` | Pagination cursor for `storage.list` (on `list`) |

## Usage

```js
// Create
await invokeFlow('storage-notes', {
  action: 'create',
  title: 'Shopping list',
  body: 'eggs, milk, bread',
});

// List (returns up to 20)
const { notes } = await invokeFlow('storage-notes', { action: 'list' });

// Delete
await invokeFlow('storage-notes', {
  action: 'delete',
  id: '1714159200000',
});
```

## Source

[`storage-notes.js`](./storage-notes.js)
