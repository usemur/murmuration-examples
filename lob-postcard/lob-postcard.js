// Lob Postcard — sends a postcard via the Lob API.
//
// Required secret: LOB_SECRET_API_KEY
// Input:
//   params.to          (address object, required)
//   params.message     (string, required unless front_image_url is provided)
//   params.from        (address object, optional)
//   params.front_image_url (string, optional) — publicly accessible URL to a PDF or image (PNG/JPEG)
//   params.back_image_url  (string, optional) — publicly accessible URL to a PDF or image (PNG/JPEG)
//
// Output: { id, url, expected_delivery_date, to, from, carrier, thumbnails }
//
// Address format: { name, address_line1, address_line2?, address_city, address_state, address_zip }
//
// Image specs (4x6 postcard):
//   - Full bleed dimensions: 4.25" × 6.25" (1275 × 1875 px at 300 DPI)
//   - Trim: 4" × 6" — content may be cut 0.125" from each edge
//   - Safe area: keep critical content 0.25" from trim edge
//   - Format: PNG (RGB), JPEG, or PDF
//   - Resolution: 300 DPI minimum
//   - Back side: leave ink-free zone 3.2835" × 2.375" (0.275" from right, 0.25" from bottom) for address block

const LOB_API_KEY = params.secrets?.LOB_SECRET_API_KEY;
if (!LOB_API_KEY) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'Missing LOB_SECRET_API_KEY secret' }),
  });
  throw new Error('Missing LOB_SECRET_API_KEY');
}

const to = params.to;
if (!to || !to.name || !to.address_line1 || !to.address_city || !to.address_state || !to.address_zip) {
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: 'Missing or incomplete "to" address. Required: name, address_line1, address_city, address_state, address_zip',
    }),
  });
  throw new Error('Missing to address');
}

const message = params.message;
const frontImageUrl = params.front_image_url;
const backImageUrl = params.back_image_url;

// Message is required unless a custom front image is provided (for text-only mode)
if (!message && !frontImageUrl) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'Either "message" or "front_image_url" is required' }),
  });
  throw new Error('Missing message or front_image_url');
}

// Determine front creative
let front;
if (frontImageUrl) {
  front = frontImageUrl;
} else {
  front = `<html>
<head>
<style>
  body { margin: 0; padding: 0; }
  .container {
    width: 6.25in; height: 4.25in;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    font-family: 'Helvetica Neue', Arial, sans-serif;
    color: white;
  }
  .content { text-align: center; padding: 0.5in; }
  h1 { font-size: 28px; margin-bottom: 8px; }
  p { font-size: 14px; opacity: 0.9; }
</style>
</head>
<body>
<div class="container">
  <div class="content">
    <h1>Greetings from Murmuration</h1>
    <p>Sent by an AI agent running inside a TEE</p>
  </div>
</div>
</body>
</html>`;
}

// Determine back creative
let back;
if (backImageUrl) {
  back = backImageUrl;
} else if (message) {
  back = `<html>
<head>
<style>
  body { margin: 0; padding: 0; }
  .container {
    width: 6.25in; height: 4.25in;
    font-family: 'Helvetica Neue', Arial, sans-serif;
    padding: 0.5in;
    box-sizing: border-box;
  }
  .message {
    font-size: 14px;
    line-height: 1.6;
    color: #333;
    max-width: 3.5in;
  }
</style>
</head>
<body>
<div class="container">
  <div class="message">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
</div>
</body>
</html>`;
} else {
  // front_image_url provided but no message and no back_image_url — use a blank back
  back = `<html>
<head>
<style>
  body { margin: 0; padding: 0; }
  .container { width: 6.25in; height: 4.25in; }
</style>
</head>
<body><div class="container"></div></body>
</html>`;
}

// Build request body
const body = {
  to: {
    name: to.name,
    address_line1: to.address_line1,
    ...(to.address_line2 ? { address_line2: to.address_line2 } : {}),
    address_city: to.address_city,
    address_state: to.address_state,
    address_zip: to.address_zip,
  },
  front,
  back,
  size: '4x6',
  use_type: 'operational',
};

// Add from address if provided
if (params.from && params.from.name && params.from.address_line1) {
  body.from = {
    name: params.from.name,
    address_line1: params.from.address_line1,
    ...(params.from.address_line2 ? { address_line2: params.from.address_line2 } : {}),
    address_city: params.from.address_city,
    address_state: params.from.address_state,
    address_zip: params.from.address_zip,
  };
}

// Call Lob API
const res = await fetch('https://api.lob.com/v1/postcards', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + btoa(LOB_API_KEY + ':'),
  },
  body: JSON.stringify(body),
});

const data = await res.json();

if (!res.ok) {
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: `Lob API error (${res.status})`,
      details: data,
    }),
  });
  throw new Error(`Lob API error: ${res.status} - ${JSON.stringify(data)}`);
}

Lit.Actions.setResponse({
  response: JSON.stringify({
    id: data.id,
    url: data.url,
    expected_delivery_date: data.expected_delivery_date,
    to: data.to,
    from: data.from,
    carrier: data.carrier,
    thumbnails: data.thumbnails,
  }),
});
