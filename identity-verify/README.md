# Identity Verify Flow

Verify a person's identity by checking their name, address, phone, and/or email against consumer databases. Returns verification status for each field, cross-reference matches, and USPS-corrected addresses.

The underlying API key stays secret inside the TEE — agents pay per call via x402 instead of needing their own subscription.

## Secrets

| Secret | Description |
|--------|-------------|
| `MELISSA_API_KEY` | Melissa API key |

## Price

10 cents per call.

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string or `{first, last}` | no | Full name or structured name |
| `address` | object | no | Address to verify |
| `phone` | string | no | Phone number (digits only) |
| `email` | string | no | Email address to verify |

At least one parameter is required.

### Address format

```json
{
  "line1": "123 Main St",
  "line2": "Apt 4",
  "city": "San Francisco",
  "state": "CA",
  "zip": "94105",
  "country": "US"
}
```

## Response

| Field | Description |
|-------|-------------|
| `verified.address` | Is the address deliverable (USPS-verified) |
| `verified.phone` | Is the phone number valid |
| `verified.email` | Is the email valid and deliverable |
| `verified.name` | Was the name successfully parsed |
| `crossReference.nameToAddress` | Does the name match this address in records |
| `crossReference.nameToPhone` | Does the name match this phone number |
| `crossReference.nameToEmail` | Does the name match this email |
| `address` | Corrected/standardized address with lat/lng |
| `phone` | Phone details: area code, cellular/landline/VoIP flags |
| `email` | Email details: domain, disposable/spamtrap/role flags |
| `name` | Parsed name: first, last, gender |
| `resultCodes` | Raw verification codes for detailed analysis |

## Usage

```js
const result = await invokeFlow('identity-verify', {
  name: 'Jane Smith',
  phone: '4155551234',
  email: 'jane@example.com',
  address: {
    line1: '185 Berry St',
    city: 'San Francisco',
    state: 'CA',
    zip: '94107',
  },
});
// result.verified.address → true
// result.crossReference.nameToAddress → true
```
