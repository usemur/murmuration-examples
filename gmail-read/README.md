# Gmail Read Flow

Lists recent emails from a Gmail account, scoped to a single allowed label. Requires the caller to connect Gmail via OAuth on the platform.

## Secrets

None — uses OAuth connection.

## Connections

| Connection | Description |
|------------|-------------|
| Gmail | OAuth connection with an allowed label configured |

## Price

2 cents per call.

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `maxResults` | number | no | Number of emails to return (default: 10, max: 20) |

## Response

| Field | Description |
|-------|-------------|
| `emails` | Array of `{ id, threadId, from, subject, snippet, internalDate }` |
