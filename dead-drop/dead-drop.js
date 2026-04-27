// Dead Drop — atomic exchange of encrypted digital goods between two agents.
//
// Two agents that don't trust each other deposit encrypted payloads on IPFS,
// a Claude managed agent verifies both against natural-language criteria,
// and the vault PKP signs an attestation so both sides can decrypt.
//
// All state lives on-chain (DeadDrop.sol on Base) and IPFS. This Lit Action
// is fully stateless — it re-derives encryption keys deterministically from
// the vault PKP's private key + dropId.
//
// Secrets required: ANTHROPIC_API_KEY, MANAGED_AGENT_ID, MANAGED_ENV_ID
//
// Actions:
//   "create"  — register criteria for a drop (after calling createDrop on-chain)
//   "join"    — acknowledge joining a drop
//   "get-key" — derive per-drop per-side encryption key (requires wallet signature)
//   "deposit" — record a CID (after on-chain deposit)
//   "verify"  — gives keys + CIDs to Claude agent (with Bash/Node.js) to fetch, decrypt, check
//   "status"  — poll Claude agent session
//   "release" — if approved, return cross-keys + sign attestation (requires wallet signature)

// ── Validate secrets ────────────────────────────────────────────

var anthropicKey = params.secrets && params.secrets.ANTHROPIC_API_KEY;
if (!anthropicKey) {
  Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing ANTHROPIC_API_KEY secret' }) });
  throw new Error('Missing ANTHROPIC_API_KEY secret');
}

var managedAgentId = params.secrets && params.secrets.MANAGED_AGENT_ID;
if (!managedAgentId) {
  Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing MANAGED_AGENT_ID secret' }) });
  throw new Error('Missing MANAGED_AGENT_ID secret');
}

var managedEnvId = params.secrets && params.secrets.MANAGED_ENV_ID;
if (!managedEnvId) {
  Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing MANAGED_ENV_ID secret' }) });
  throw new Error('Missing MANAGED_ENV_ID secret');
}

// ── Validate action ─────────────────────────────────────────────

var action = params.action;
var validActions = ['create', 'join', 'get-key', 'deposit', 'verify', 'status', 'release'];
if (!action || !validActions.includes(action)) {
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: 'Missing or invalid "action". Must be one of: ' + validActions.join(', '),
    }),
  });
  throw new Error('Invalid action');
}

// ── Helpers ─────────────────────────────────────────────────────

var IPFS_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';
var AGENT_BASE = 'https://api.anthropic.com/v1';
var DEAD_DROP_CONTRACT = '0xC72c5462F6B78e50eBe2BBFccd1992C663e15054';
var BASE_RPC = 'https://mainnet.base.org';

async function agentFetch(method, path, body) {
  var opts = {
    method: method,
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  var res = await fetch(AGENT_BASE + path, opts);
  if (!res.ok) {
    var text = await res.text();
    throw new Error('Anthropic API error (' + res.status + '): ' + text.slice(0, 500));
  }
  return res.json();
}

// Derive a per-drop, per-side AES-256 key from the vault PKP's private key.
// keyA = keccak256(vaultPrivateKey || dropId || "a")
// keyB = keccak256(vaultPrivateKey || dropId || "b")
async function deriveKey(dropId, side) {
  if (!params.pkpAddress) {
    throw new Error('No vault PKP — flow needs a vault set up');
  }
  var privateKey = await Lit.Actions.getPrivateKey({ pkpId: params.pkpAddress });
  return ethers.utils.solidityKeccak256(
    ['bytes32', 'uint256', 'string'],
    [privateKey, dropId, side]
  );
}

// Verify the caller owns the wallet for the claimed role by checking their
// signature against the on-chain partyA/partyB addresses.
// Returns the on-chain drop data tuple for reuse.
async function verifyCallerIsParty(dropId, role, signature, messagePrefix) {
  var message = messagePrefix + ':' + dropId + ':' + role;
  var recoveredAddress = ethers.utils.verifyMessage(message, signature);

  var provider = new ethers.providers.JsonRpcProvider(BASE_RPC);
  var contract = new ethers.Contract(DEAD_DROP_CONTRACT, [
    'function getDrop(uint256) view returns (address,address,address,bytes32,bytes32,bytes32,string,string,uint256,uint256,uint256,uint8)',
  ], provider);
  var drop = await contract.getDrop(dropId);
  var expectedAddress = role === 'a' ? drop[0] : drop[1];

  if (recoveredAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(
      'Signature does not match ' + role + ' party. Expected ' +
      expectedAddress + ', got ' + recoveredAddress
    );
  }
  return drop;
}


// ════════════════════════════════════════════════════════════════
//  ACTION: CREATE
// ════════════════════════════════════════════════════════════════

if (action === 'create') {
  if (params.dropId === undefined && params.dropId !== 0) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "dropId" (create the drop on-chain first)' }) });
    throw new Error('Missing dropId');
  }
  if (!params.criteria || !params.criteria.sideA || !params.criteria.sideB) {
    Lit.Actions.setResponse({
      response: JSON.stringify({ error: 'Missing "criteria" with "sideA" and "sideB" descriptions' }),
    });
    throw new Error('Missing criteria');
  }

  var criteriaJson = JSON.stringify(params.criteria);
  var criteriaHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(criteriaJson));

  Lit.Actions.setResponse({
    response: JSON.stringify({
      status: 'created',
      dropId: params.dropId,
      criteriaHash: criteriaHash,
      criteria: params.criteria,
    }),
  });
}

// ════════════════════════════════════════════════════════════════
//  ACTION: JOIN
// ════════════════════════════════════════════════════════════════

if (action === 'join') {
  if (params.dropId === undefined) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "dropId"' }) });
    throw new Error('Missing dropId');
  }

  Lit.Actions.setResponse({
    response: JSON.stringify({
      status: 'joined',
      dropId: params.dropId,
    }),
  });
}

// ════════════════════════════════════════════════════════════════
//  ACTION: GET-KEY
// ════════════════════════════════════════════════════════════════

if (action === 'get-key') {
  if (params.dropId === undefined) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "dropId"' }) });
    throw new Error('Missing dropId');
  }
  if (!params.role || !['a', 'b'].includes(params.role)) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing or invalid "role". Must be "a" or "b".' }) });
    throw new Error('Invalid role');
  }
  if (!params.signature) {
    Lit.Actions.setResponse({
      response: JSON.stringify({ error: 'Missing "signature". Sign message "DEAD_DROP_GET_KEY:<dropId>:<role>" with your wallet.' }),
    });
    throw new Error('Missing signature');
  }

  try {
    await verifyCallerIsParty(params.dropId, params.role, params.signature, 'DEAD_DROP_GET_KEY');
  } catch (e) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Auth failed: ' + e.message }) });
    throw e;
  }

  var encryptionKey = await deriveKey(params.dropId, params.role);

  Lit.Actions.setResponse({
    response: JSON.stringify({
      dropId: params.dropId,
      role: params.role,
      encryptionKey: encryptionKey,
      algorithm: 'AES-256-GCM',
      spec: 'Encrypt: [12-byte random IV][ciphertext][16-byte GCM auth tag]. Upload raw bytes to IPFS.',
    }),
  });
}

// ════════════════════════════════════════════════════════════════
//  ACTION: DEPOSIT
// ════════════════════════════════════════════════════════════════

if (action === 'deposit') {
  if (params.dropId === undefined) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "dropId"' }) });
    throw new Error('Missing dropId');
  }
  if (!params.role || !['a', 'b'].includes(params.role)) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing or invalid "role"' }) });
    throw new Error('Invalid role');
  }
  if (!params.cid) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "cid" (IPFS CID of encrypted payload)' }) });
    throw new Error('Missing cid');
  }

  // Verify the CID is fetchable from IPFS
  var headRes = await fetch(IPFS_GATEWAY + params.cid, { method: 'HEAD' });
  if (!headRes.ok) {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        error: 'CID not found on IPFS gateway',
        cid: params.cid,
        httpStatus: headRes.status,
      }),
    });
    throw new Error('CID not found');
  }

  var commitment = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(params.cid));

  Lit.Actions.setResponse({
    response: JSON.stringify({
      status: 'deposited',
      dropId: params.dropId,
      role: params.role,
      cid: params.cid,
      commitment: commitment,
    }),
  });
}

// ════════════════════════════════════════════════════════════════
//  ACTION: VERIFY
// ════════════════════════════════════════════════════════════════

if (action === 'verify') {
  if (params.dropId === undefined) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "dropId"' }) });
    throw new Error('Missing dropId');
  }
  if (!params.cidA || !params.cidB) {
    Lit.Actions.setResponse({
      response: JSON.stringify({ error: 'Missing "cidA" and/or "cidB". Both CIDs are needed for verification.' }),
    });
    throw new Error('Missing CIDs');
  }
  if (!params.criteria || !params.criteria.sideA || !params.criteria.sideB) {
    Lit.Actions.setResponse({
      response: JSON.stringify({ error: 'Missing "criteria" with "sideA" and "sideB" descriptions' }),
    });
    throw new Error('Missing criteria');
  }

  // Derive both decryption keys and pass them to the Claude managed agent
  // along with the IPFS CIDs. The agent has Bash + web_fetch + Node.js
  // available, so it fetches from IPFS, decrypts with AES-256-GCM, and
  // evaluates the plaintext against criteria. No TEE payload size limit.
  var keyA = await deriveKey(params.dropId, 'a');
  var keyB = await deriveKey(params.dropId, 'b');

  var verifyPrompt = 'You are verifying a dead drop exchange. Two agents deposited encrypted\n';
  verifyPrompt += 'payloads on IPFS. You have the decryption keys and IPFS URLs.\n\n';
  verifyPrompt += 'For EACH side, you must:\n';
  verifyPrompt += '1. Fetch the encrypted payload from the IPFS URL (use curl or web_fetch)\n';
  verifyPrompt += '2. Decrypt it using AES-256-GCM with the provided key\n';
  verifyPrompt += '3. Evaluate the decrypted content against the criteria\n\n';
  verifyPrompt += '═══ SIDE A ═══\n';
  verifyPrompt += 'IPFS URL: ' + IPFS_GATEWAY + params.cidA + '\n';
  verifyPrompt += 'Decryption key (hex): ' + keyA + '\n';
  verifyPrompt += 'Criteria: ' + params.criteria.sideA + '\n\n';
  verifyPrompt += '═══ SIDE B ═══\n';
  verifyPrompt += 'IPFS URL: ' + IPFS_GATEWAY + params.cidB + '\n';
  verifyPrompt += 'Decryption key (hex): ' + keyB + '\n';
  verifyPrompt += 'Criteria: ' + params.criteria.sideB + '\n\n';
  verifyPrompt += '═══ DECRYPTION ═══\n';
  verifyPrompt += 'Use this Node.js script pattern to decrypt each payload:\n\n';
  verifyPrompt += 'const crypto = require("crypto");\n';
  verifyPrompt += 'const fs = require("fs");\n';
  verifyPrompt += 'const encrypted = fs.readFileSync("payload.bin");\n';
  verifyPrompt += 'const key = Buffer.from("KEY_HEX".replace("0x",""), "hex");\n';
  verifyPrompt += 'const iv = encrypted.subarray(0, 12);\n';
  verifyPrompt += 'const tag = encrypted.subarray(encrypted.length - 16);\n';
  verifyPrompt += 'const ciphertext = encrypted.subarray(12, encrypted.length - 16);\n';
  verifyPrompt += 'const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);\n';
  verifyPrompt += 'decipher.setAuthTag(tag);\n';
  verifyPrompt += 'const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);\n';
  verifyPrompt += 'fs.writeFileSync("decrypted.txt", decrypted);\n\n';
  verifyPrompt += '═══ INSTRUCTIONS ═══\n';
  verifyPrompt += 'Evaluate each side independently. Be strict but fair — the criteria\n';
  verifyPrompt += 'are what both parties agreed to.\n\n';
  verifyPrompt += 'After decrypting and evaluating, respond with ONLY this JSON (no markdown):\n';
  verifyPrompt += '{\n';
  verifyPrompt += '  "verdict": "APPROVED" or "REJECTED",\n';
  verifyPrompt += '  "sideA": {\n';
  verifyPrompt += '    "passes": true or false,\n';
  verifyPrompt += '    "confidence": <0-100>,\n';
  verifyPrompt += '    "reasoning": "<explanation>"\n';
  verifyPrompt += '  },\n';
  verifyPrompt += '  "sideB": {\n';
  verifyPrompt += '    "passes": true or false,\n';
  verifyPrompt += '    "confidence": <0-100>,\n';
  verifyPrompt += '    "reasoning": "<explanation>"\n';
  verifyPrompt += '  },\n';
  verifyPrompt += '  "overall_reasoning": "<summary of decision>"\n';
  verifyPrompt += '}\n\n';
  verifyPrompt += 'The overall verdict should be APPROVED only if BOTH sides pass.\n';

  // Create managed agent session and send verification task
  var session = await agentFetch('POST', '/sessions', {
    agent: managedAgentId,
    environment_id: managedEnvId,
  });

  await agentFetch('POST', '/sessions/' + session.id + '/events', {
    events: [{
      type: 'user.message',
      content: [{ type: 'text', text: verifyPrompt }],
    }],
  });

  Lit.Actions.setResponse({
    response: JSON.stringify({
      status: 'verifying',
      sessionId: session.id,
      dropId: params.dropId,
    }),
  });
}

// ════════════════════════════════════════════════════════════════
//  ACTION: STATUS
// ════════════════════════════════════════════════════════════════

if (action === 'status') {
  if (!params.sessionId) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "sessionId"' }) });
    throw new Error('Missing sessionId');
  }

  var statusEvents = await agentFetch('GET', '/sessions/' + params.sessionId + '/events');
  var statusList = statusEvents.data || statusEvents.events || statusEvents;

  if (!Array.isArray(statusList)) {
    Lit.Actions.setResponse({ response: JSON.stringify({ status: 'unknown' }) });
    return;
  }

  var sessionStatus = 'running';
  for (var si = statusList.length - 1; si >= 0; si--) {
    if (statusList[si].type === 'session.status_idle') { sessionStatus = 'idle'; break; }
    if (statusList[si].type === 'session.status_terminated') { sessionStatus = 'terminated'; break; }
  }

  Lit.Actions.setResponse({
    response: JSON.stringify({
      status: sessionStatus,
      sessionId: params.sessionId,
      eventCount: statusList.length,
    }),
  });
}

// ════════════════════════════════════════════════════════════════
//  ACTION: RELEASE
// ════════════════════════════════════════════════════════════════

if (action === 'release') {
  if (params.dropId === undefined) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "dropId"' }) });
    throw new Error('Missing dropId');
  }
  if (!params.sessionId) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "sessionId"' }) });
    throw new Error('Missing sessionId');
  }
  if (!params.role || !['a', 'b'].includes(params.role)) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing or invalid "role"' }) });
    throw new Error('Invalid role');
  }
  if (!params.signature) {
    Lit.Actions.setResponse({
      response: JSON.stringify({ error: 'Missing "signature". Sign message "DEAD_DROP_RELEASE:<dropId>:<role>" with your wallet.' }),
    });
    throw new Error('Missing signature for release');
  }

  // Verify caller owns the wallet for their claimed role, and get on-chain party addresses
  var releaseDrop;
  try {
    releaseDrop = await verifyCallerIsParty(params.dropId, params.role, params.signature, 'DEAD_DROP_RELEASE');
  } catch (e) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Auth failed: ' + e.message }) });
    throw e;
  }
  var onChainPartyA = releaseDrop[0];
  var onChainPartyB = releaseDrop[1];

  // Fetch session events and extract verdict
  var events = await agentFetch('GET', '/sessions/' + params.sessionId + '/events');
  var eventList = events.data || events.events || events;
  if (!Array.isArray(eventList)) {
    Lit.Actions.setResponse({ response: JSON.stringify({ status: 'error', detail: 'Could not parse session events' }) });
    return;
  }

  // Check agent is done
  var isIdle = eventList.some(function(e) { return e.type === 'session.status_idle'; });
  if (!isIdle) {
    Lit.Actions.setResponse({ response: JSON.stringify({ status: 'pending', detail: 'Agent is still verifying' }) });
    return;
  }

  // Find verdict JSON in agent response
  var verdict = null;
  for (var i = eventList.length - 1; i >= 0; i--) {
    var evt = eventList[i];
    if (evt.type === 'agent.message' || evt.type === 'assistant' || evt.type === 'agent.text') {
      var content = '';
      if (typeof evt.content === 'string') {
        content = evt.content;
      } else if (Array.isArray(evt.content)) {
        for (var ci = 0; ci < evt.content.length; ci++) {
          if (evt.content[ci] && evt.content[ci].text) content += evt.content[ci].text;
        }
      } else if (typeof evt.text === 'string') {
        content = evt.text;
      }
      var jsonStr = content.trim();
      var fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) jsonStr = fenceMatch[1].trim();
      try {
        var parsed = JSON.parse(jsonStr);
        if (parsed.verdict) { verdict = parsed; break; }
      } catch (e) {
        // Look for {"verdict" specifically to avoid matching other JSON in the text
        var verdictStart = jsonStr.indexOf('{"verdict"');
        if (verdictStart < 0) verdictStart = jsonStr.indexOf('{\"verdict\"');
        if (verdictStart >= 0) {
          var lastBrace = jsonStr.lastIndexOf('}');
          if (lastBrace > verdictStart) {
            try {
              var extracted = JSON.parse(jsonStr.slice(verdictStart, lastBrace + 1));
              if (extracted.verdict) { verdict = extracted; break; }
            } catch (e2) { /* continue searching */ }
          }
        }
      }
    }
  }

  if (!verdict) {
    Lit.Actions.setResponse({
      response: JSON.stringify({ status: 'error', detail: 'Agent completed but no verdict found' }),
    });
    return;
  }

  // If REJECTED, return reasoning without releasing keys
  if (verdict.verdict !== 'APPROVED') {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        status: 'rejected',
        dropId: params.dropId,
        verdict: verdict.verdict,
        sideA: verdict.sideA,
        sideB: verdict.sideB,
        reasoning: verdict.overall_reasoning,
      }),
    });
    return;
  }

  // APPROVED — derive cross-keys and sign attestation
  if (!params.pkpAddress) {
    Lit.Actions.setResponse({
      response: JSON.stringify({ error: 'No vault PKP — flow needs a vault set up' }),
    });
    throw new Error('No vault PKP');
  }

  var chainId = params.chainId || 8453; // Default to Base
  var dropId = typeof params.dropId === 'string' ? parseInt(params.dropId) : params.dropId;

  // Sign release using on-chain party addresses (not caller-supplied)
  // keccak256("DEAD_DROP_RELEASE", dropId, partyA, partyB, chainId)
  var messageHash = ethers.utils.solidityKeccak256(
    ['string', 'uint256', 'address', 'address', 'uint256'],
    ['DEAD_DROP_RELEASE', dropId, onChainPartyA, onChainPartyB, chainId]
  );

  var privateKey = await Lit.Actions.getPrivateKey({ pkpId: params.pkpAddress });
  var wallet = new ethers.Wallet(privateKey);
  var attestationSig = await wallet.signMessage(ethers.utils.arrayify(messageHash));

  // Derive the OTHER side's key to give to the caller
  var theirSide = params.role === 'a' ? 'b' : 'a';
  var theirKey = await deriveKey(dropId, theirSide);
  // Get the other side's CID from on-chain data (indices 6=cidA, 7=cidB)
  var theirCid = params.role === 'a' ? releaseDrop[7] : releaseDrop[6];

  Lit.Actions.setResponse({
    response: JSON.stringify({
      status: 'released',
      dropId: dropId,
      theirCid: theirCid,
      theirKey: theirKey,
      attestation: {
        signature: attestationSig,
        signerAddress: wallet.address,
        chainId: chainId,
        dropId: dropId,
        partyA: onChainPartyA,
        partyB: onChainPartyB,
      },
      verdict: verdict.verdict,
      sideA: verdict.sideA,
      sideB: verdict.sideB,
      reasoning: verdict.overall_reasoning,
    }),
  });
}
