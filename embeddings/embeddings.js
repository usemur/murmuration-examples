// Embeddings — generate text embeddings via the OpenAI embeddings API.
//
// Supports two modes:
//   1. Text mode:  pass params.input (string or string[])
//   2. PDF mode:   pass params.pdf_base64 (base64-encoded PDF) — text is extracted
//                  via opendataloader-pdf, then embedded
//
// The OpenAI API key stays secret inside the TEE. Consumers pay per
// request via x402 and never need their own OpenAI account or API key.
//
// Secrets required: OPENAI_API_KEY
// Input: params.input OR params.pdf_base64, params.model (optional)
// Output: { model, embeddings, usage, extracted_text? }

const apiKey = params.secrets?.OPENAI_API_KEY;
if (!apiKey) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'Missing OPENAI_API_KEY secret' }),
  });
  throw new Error('Missing OPENAI_API_KEY secret');
}

let input = params.input;
let extractedText = null;

// PDF mode: extract text first, then embed it
if (params.pdf_base64) {
  const extractRes = await fetch('https://flows-pdf-extract.fly.dev/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdf_base64: params.pdf_base64 }),
  });

  if (!extractRes.ok) {
    const errText = await extractRes.text();
    Lit.Actions.setResponse({
      response: JSON.stringify({
        error: `PDF extraction failed (${extractRes.status})`,
        body: errText.slice(0, 1000),
      }),
    });
    throw new Error(`PDF extraction failed: ${extractRes.status}`);
  }

  const extractResult = await extractRes.json();
  extractedText = extractResult.text;

  // Use extracted text as embedding input (split by double newlines for chunking)
  if (!input) {
    input = extractedText;
  }
}

if (!input) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'Missing "input" or "pdf_base64" parameter' }),
  });
  throw new Error('Missing input');
}

const model = params.model || 'text-embedding-3-small';

const res = await fetch('https://api.openai.com/v1/embeddings', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ input, model }),
});

if (!res.ok) {
  const errText = await res.text();
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: `OpenAI API failed (${res.status})`,
      body: errText.slice(0, 1000),
    }),
  });
  throw new Error(`OpenAI API failed: ${res.status}`);
}

const result = await res.json();

const response = {
  model: result.model,
  embeddings: result.data.map((d) => ({
    index: d.index,
    embedding: d.embedding,
  })),
  usage: result.usage,
};

// Include extracted text in response so consumers can see what was embedded
if (extractedText) {
  response.extracted_text = extractedText;
}

Lit.Actions.setResponse({
  response: JSON.stringify(response),
});
