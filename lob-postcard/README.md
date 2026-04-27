# Lob Postcard Flow

Sends a physical postcard via the Lob mail API from inside a TEE. Great for agents that need to send physical mail.

Supports two modes:
- **Text mode**: pass a `message` string and the flow generates styled HTML for front/back
- **Image mode**: pass `front_image_url` and/or `back_image_url` pointing to hosted PNG, JPEG, or PDF files

## Secrets

| Secret | Description |
|--------|-------------|
| `LOB_SECRET_API_KEY` | Lob API key |

## Price

$1.00 per call.

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | object | yes | Recipient address |
| `message` | string | yes (unless `front_image_url` provided) | Message for the back of the postcard |
| `from` | object | no | Sender address (optional) |
| `front_image_url` | string | no | Public URL to a PNG, JPEG, or PDF for the front |
| `back_image_url` | string | no | Public URL to a PNG, JPEG, or PDF for the back |

### Address format

```json
{
  "name": "Jane Doe",
  "address_line1": "123 Main St",
  "address_line2": "Apt 4",
  "address_city": "San Francisco",
  "address_state": "CA",
  "address_zip": "94105"
}
```

### Image specifications (4x6 postcard)

| Spec | Value |
|------|-------|
| Full bleed | 4.25" x 6.25" (1275 x 1875 px at 300 DPI) |
| Trim | 4" x 6" — content may be cut 0.125" from each edge |
| Safe area | Keep critical content 0.25" inside trim edge |
| Format | PNG (RGB), JPEG, or PDF |
| Resolution | 300 DPI minimum |
| Back ink-free zone | 3.2835" x 2.375" (bottom-right) reserved for address block |

## Response

| Field | Description |
|-------|-------------|
| `id` | Lob postcard ID (e.g. `psc_...`) |
| `url` | Link to view the postcard in Lob dashboard |
| `expected_delivery_date` | Estimated delivery date |
| `to` | Resolved recipient address |
| `from` | Resolved sender address |
| `carrier` | Mail carrier (e.g. USPS) |
| `thumbnails` | Front/back preview image URLs |

## Test Assets

- `postcard-front-test.png` — test front image for E2E testing
- `postcard-back-test.png` — test back image for E2E testing
