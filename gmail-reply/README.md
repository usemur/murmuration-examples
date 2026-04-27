# Gmail Reply Flow

Sends an email reply to a specific message, but only when the original message carries the allowed Gmail label. Requires the caller to connect Gmail via OAuth on the platform.

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
| `messageId` | string | yes | Gmail message ID to reply to |
| `replyBody` | string | yes | Plain text reply body (max 5000 chars) |

## Response

| Field | Description |
|-------|-------------|
| `sent` | `true` on success |
| `replyMessageId` | ID of the sent reply message |
