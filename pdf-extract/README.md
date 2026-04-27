# PDF Extract Flow

Extract text from a PDF document using opendataloader-pdf, a high-quality Java-based PDF extraction engine. Returns clean markdown text. No API keys or accounts needed — just pay per request via x402.

## Secrets

None required.

## Price

2 cents per call.

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pdf_base64` | string | yes | Base64-encoded PDF document |

## Response

| Field | Description |
|-------|-------------|
| `text` | Extracted text in markdown format |

## Usage

```js
const pdfBytes = fs.readFileSync('document.pdf');
const result = await invokeFlow('pdf-extract', {
  pdf_base64: pdfBytes.toString('base64'),
});
console.log(result.text); // "# Document Title\n\nContent..."
```

## Test Assets

- `test.pdf` — a small test PDF used by the E2E test suite.
