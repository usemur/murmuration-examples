// PDF Extract — extract text from a PDF using opendataloader-pdf.
//
// No secrets required. The extraction runs on a serverless Fly.io machine
// with opendataloader-pdf (Java-based, high-quality extraction).
//
// Input: params.pdf_base64 (base64-encoded PDF)
// Output: { text }

const pdfBase64 = params.pdf_base64;
if (!pdfBase64) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'Missing "pdf_base64" parameter — provide a base64-encoded PDF' }),
  });
  throw new Error('Missing pdf_base64');
}

const res = await fetch('https://flows-pdf-extract.fly.dev/extract', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ pdf_base64: pdfBase64 }),
});

if (!res.ok) {
  const errText = await res.text();
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: `PDF extraction failed (${res.status})`,
      body: errText.slice(0, 1000),
    }),
  });
  throw new Error(`PDF extraction failed: ${res.status}`);
}

const result = await res.json();

Lit.Actions.setResponse({
  response: JSON.stringify({ text: result.text }),
});
