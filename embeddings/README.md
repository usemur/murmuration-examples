# Embeddings Flow

Generate text embeddings using OpenAI's embedding models, without needing your own API key. Pay per request via x402.

Supports two modes:
- **Text mode**: pass strings directly
- **PDF mode**: pass a base64-encoded PDF — text is extracted, then embedded

## Secrets

| Secret | Description |
|--------|-------------|
| `OPENAI_API_KEY` | OpenAI API key |

## Price

2 cents per call.

## Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `input` | string or string[] | yes (unless `pdf_base64` provided) | Text(s) to embed |
| `pdf_base64` | string | no | Base64-encoded PDF to extract and embed |
| `model` | string | no | Embedding model (default: `text-embedding-3-small`) |

### Supported models

- `text-embedding-3-small` (default) — 1536 dimensions, fast & cheap
- `text-embedding-3-large` — 3072 dimensions, higher quality
- `text-embedding-ada-002` — legacy, 1536 dimensions

## Response

| Field | Description |
|-------|-------------|
| `model` | Model used |
| `embeddings` | Array of `{ index, embedding }` objects |
| `usage` | Token usage: `{ prompt_tokens, total_tokens }` |
| `extracted_text` | (PDF mode only) The text extracted from the PDF |

## Usage

### Text mode

```js
const result = await invokeFlow('embeddings', {
  input: ['What is Lit Protocol?', 'How do TEEs work?'],
});
// result.embeddings[0].embedding → [0.0023, -0.0091, ...]
```

### PDF mode

```js
const pdfBytes = fs.readFileSync('document.pdf');
const result = await invokeFlow('embeddings', {
  pdf_base64: pdfBytes.toString('base64'),
});
// result.extracted_text → "# Document Title\n\nContent..."
// result.embeddings[0].embedding → [0.0041, -0.0023, ...]
```
