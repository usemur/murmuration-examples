// Oracle — fetches a URL, signs the response with the flow's PKP.
//
// The signature uses the flow's vault PKP, which is a stable identity
// tied to this flow. Consumers can verify the signer address matches
// the flow's known PKP address.
//
// No secrets required.
// Input: params.url (string)
// Output: { url, response, dataHash, signature, signerAddress }

const url = params.url;
if (!url) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'Missing "url" parameter' }),
  });
  throw new Error('Missing url');
}

if (!params.pkpAddress) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'No vault PKP — flow needs a vault set up' }),
  });
  throw new Error('No vault PKP');
}

// Fetch the URL
const res = await fetch(url);
if (!res.ok) {
  const text = await res.text();
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: `Fetch failed (${res.status})`,
      body: text.slice(0, 1000),
    }),
  });
  throw new Error(`Fetch failed: ${res.status}`);
}

const responseBody = await res.text();

// Hash the response for signing
const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(responseBody));

// Get the vault PKP's private key (only accessible inside the TEE)
const privateKey = await Lit.Actions.getPrivateKey({ pkpId: params.pkpAddress });
const wallet = new ethers.Wallet(privateKey);
const signature = await wallet.signMessage(ethers.utils.arrayify(dataHash));

Lit.Actions.setResponse({
  response: JSON.stringify({
    url,
    response: responseBody,
    dataHash,
    signature,
    signerAddress: wallet.address,
  }),
});
