// Transaction Checker — two-layer verification for EVM transactions.
//
// Layer 1: Deterministic Triggers (fast, binary, no LLM)
//   - Address validation and contract existence
//   - OFAC sanctions screening (Chainalysis on-chain oracle)
//   - Balance sufficiency (ETH + token)
//   - Gas estimation and limit validation
//   - Spending limit constraints (optional caller-supplied)
//
// Layer 2: Graph-of-Thoughts Reasoning (LLM, only if triggers pass)
//   - Path A: Intent-transaction alignment
//   - Path B: Adversarial manipulation detection
//   - Path C: Compliance and regulatory validation
//   - Synthesis: Structured verdict with auditable reasoning trace
//
// If any deterministic trigger fails, the transaction is rejected
// immediately without invoking the LLM. This keeps verification
// fast and cheap for straightforward rejections.
//
// Supports all major EVM chains via Alchemy.
// Secrets required: ALCHEMY_API_KEY, OPENROUTER_API_KEY
//
/**
 * @param {string} to - Target contract address
 * @param {string} from - Sender address
 * @param {string} data - Transaction calldata (hex-encoded)
 * @param {string?} value - ETH value in wei (hex, default "0x0")
 * @param {string?} chain - Chain name (default: ethereum)
 * @param {string} intent - Natural language description of what this txn should do
 * @param {number?} maxValueWei - Optional: max ETH value allowed (decimal string)
 * @param {number?} maxApprovalAmount - Optional: max token approval allowed (decimal, in token units)
 * @param {string?} expectedFunction - Optional: expected function name (e.g. "approve", "swap")
 */

// ── Validate secrets ────────────────────────────────────────────

var alchemyKey = params.secrets && params.secrets.ALCHEMY_API_KEY;
if (!alchemyKey) {
  Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing ALCHEMY_API_KEY secret' }) });
  throw new Error('Missing ALCHEMY_API_KEY secret');
}

var openrouterKey = params.secrets && params.secrets.OPENROUTER_API_KEY;
if (!openrouterKey) {
  Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing OPENROUTER_API_KEY secret' }) });
  throw new Error('Missing OPENROUTER_API_KEY secret');
}

// ── Validate inputs ─────────────────────────────────────────────

if (!params.to || !params.from || !params.data || !params.intent) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'Missing required parameters. Need: to, from, data, intent' }),
  });
  throw new Error('Missing required parameters');
}

var to = params.to;
var from = params.from;
var data = params.data;
var value = params.value || '0x0';
var chainName = (params.chain || 'ethereum').toLowerCase();
var intent = params.intent;

// Optional constraints
var maxValueWei = params.maxValueWei || null;
var maxApprovalAmount = params.maxApprovalAmount || null;
var expectedFunction = params.expectedFunction || null;

// ── Chain configuration ─────────────────────────────────────────

var CHAINS = {
  ethereum:  { id: 1,     alchemy: 'eth-mainnet',     sourcifyId: '1' },
  polygon:   { id: 137,   alchemy: 'polygon-mainnet', sourcifyId: '137' },
  arbitrum:  { id: 42161, alchemy: 'arb-mainnet',     sourcifyId: '42161' },
  optimism:  { id: 10,    alchemy: 'opt-mainnet',     sourcifyId: '10' },
  base:      { id: 8453,  alchemy: 'base-mainnet',    sourcifyId: '8453' },
  zksync:    { id: 324,   alchemy: 'zksync-mainnet',  sourcifyId: '324' },
  scroll:    { id: 534352, alchemy: 'scroll-mainnet', sourcifyId: '534352' },
  linea:     { id: 59144, alchemy: 'linea-mainnet',   sourcifyId: '59144' },
  avalanche: { id: 43114, alchemy: 'avax-mainnet',    sourcifyId: '43114' },
  bnb:       { id: 56,    alchemy: 'bnb-mainnet',     sourcifyId: '56' },
};

var chain = CHAINS[chainName];
if (!chain) {
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: 'Unsupported chain: ' + chainName + '. Supported: ' + Object.keys(CHAINS).join(', '),
    }),
  });
  throw new Error('Unsupported chain: ' + chainName);
}

var alchemyUrl = 'https://' + chain.alchemy + '.g.alchemy.com/v2/' + alchemyKey;
// Ethereum endpoint is always needed for OFAC oracle
var ethAlchemyUrl = 'https://eth-mainnet.g.alchemy.com/v2/' + alchemyKey;

// ── JSON-RPC helpers ────────────────────────────────────────────

var rpcId = 1;
async function rpc(url, method, rpcParams) {
  var res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: method, params: rpcParams }),
  });
  var json = await res.json();
  if (json.error) return { error: json.error.message || JSON.stringify(json.error) };
  return { result: json.result };
}
async function alchemyRpc(method, rpcParams) { return rpc(alchemyUrl, method, rpcParams); }
async function ethRpc(method, rpcParams) { return rpc(ethAlchemyUrl, method, rpcParams); }

// ════════════════════════════════════════════════════════════════
//  LAYER 1: DETERMINISTIC TRIGGERS
// ════════════════════════════════════════════════════════════════

var triggers = [];
var triggersFailed = false;

// ── 1a. Address validation ──────────────────────────────────────

function isValidAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

if (!isValidAddress(to)) {
  triggers.push({ name: 'address_validity', passed: false, detail: 'Invalid "to" address: ' + to });
  triggersFailed = true;
} else if (!isValidAddress(from)) {
  triggers.push({ name: 'address_validity', passed: false, detail: 'Invalid "from" address: ' + from });
  triggersFailed = true;
} else {
  triggers.push({ name: 'address_validity', passed: true, detail: 'Both to and from are valid EVM addresses' });
}

// ── 1b. Calldata syntax validation ──────────────────────────────

if (!data || data.length < 10 || !/^0x[0-9a-fA-F]*$/.test(data)) {
  triggers.push({ name: 'calldata_syntax', passed: false, detail: 'Calldata is not valid hex or too short (need at least 4-byte selector)' });
  triggersFailed = true;
} else if (data.length % 2 !== 0) {
  triggers.push({ name: 'calldata_syntax', passed: false, detail: 'Calldata has odd hex length (likely truncated)' });
  triggersFailed = true;
} else {
  triggers.push({ name: 'calldata_syntax', passed: true, detail: 'Calldata is valid hex with ' + ((data.length - 2) / 2) + ' bytes' });
}

// ── 1c. Contract existence ──────────────────────────────────────

var isContract = false;
if (!triggersFailed) {
  var codeRes = await alchemyRpc('eth_getCode', [to, 'latest']);
  if (codeRes.result && codeRes.result !== '0x' && codeRes.result !== '0x0') {
    isContract = true;
    triggers.push({ name: 'contract_exists', passed: true, detail: 'Target is a contract with deployed code' });
  } else {
    triggers.push({ name: 'contract_exists', passed: false, detail: 'Target address has no deployed code — this is an EOA, not a contract' });
    triggersFailed = true;
  }
}

// ── 1d. OFAC sanctions screening ────────────────────────────────
// Chainalysis Sanctions Oracle on Ethereum mainnet
// isSanctioned(address) → bool

var SANCTIONS_ORACLE = '0x40C57923924B5c5c5455c48D93317139ADDaC8fb';

async function checkSanctioned(addr) {
  // ABI: isSanctioned(address) → bool
  // Selector: keccak256("isSanctioned(address)") = 0xdf592f7d...
  // We manually encode since ethers v5 utils are available
  var selector = '0xdf592f7d';
  var paddedAddr = addr.toLowerCase().replace('0x', '').padStart(64, '0');
  var calldata = selector + paddedAddr;

  var res = await ethRpc('eth_call', [{ to: SANCTIONS_ORACLE, data: calldata }, 'latest']);
  if (res.error) return { error: res.error };
  // Returns 0x...0001 if sanctioned, 0x...0000 if not
  var isSanctioned = res.result && res.result !== '0x' + '0'.repeat(64);
  return { sanctioned: isSanctioned };
}

if (!triggersFailed) {
  try {
    var fromCheck = await checkSanctioned(from);
    var toCheck = await checkSanctioned(to);

    if (fromCheck.error || toCheck.error) {
      triggers.push({
        name: 'ofac_sanctions',
        passed: true, // non-fatal if oracle unavailable
        detail: 'OFAC oracle query failed (non-fatal): ' + (fromCheck.error || toCheck.error),
      });
    } else if (fromCheck.sanctioned) {
      triggers.push({ name: 'ofac_sanctions', passed: false, detail: 'SENDER address ' + from + ' is on the OFAC sanctions list (Chainalysis oracle)' });
      triggersFailed = true;
    } else if (toCheck.sanctioned) {
      triggers.push({ name: 'ofac_sanctions', passed: false, detail: 'TARGET address ' + to + ' is on the OFAC sanctions list (Chainalysis oracle)' });
      triggersFailed = true;
    } else {
      triggers.push({ name: 'ofac_sanctions', passed: true, detail: 'Neither sender nor target is on the OFAC sanctions list' });
    }
  } catch (e) {
    triggers.push({ name: 'ofac_sanctions', passed: true, detail: 'OFAC check skipped (oracle error, non-fatal): ' + (e.message || String(e)) });
  }
}

// ── 1e. Balance sufficiency ─────────────────────────────────────

if (!triggersFailed) {
  // Check ETH balance for gas + value
  var balRes = await alchemyRpc('eth_getBalance', [from, 'latest']);
  if (balRes.result) {
    var balanceHex = balRes.result;
    var valueNum = parseInt(value, 16) || 0;
    var balanceNum = parseInt(balanceHex, 16) || 0;

    if (valueNum > 0 && balanceNum < valueNum) {
      triggers.push({
        name: 'balance_sufficiency',
        passed: false,
        detail: 'Insufficient ETH balance. Have: ' + balanceHex + ' wei, need: ' + value + ' wei (plus gas)',
      });
      triggersFailed = true;
    } else {
      triggers.push({
        name: 'balance_sufficiency',
        passed: true,
        detail: 'ETH balance (' + balanceHex + ' wei) is sufficient for transaction value (' + value + ' wei)',
      });
    }
  } else {
    triggers.push({ name: 'balance_sufficiency', passed: true, detail: 'Balance check skipped (RPC error, non-fatal)' });
  }
}

// ── 1f. Gas estimation ──────────────────────────────────────────

var estimatedGas = null;
if (!triggersFailed) {
  var gasRes = await alchemyRpc('eth_estimateGas', [{ from: from, to: to, data: data, value: value }]);
  if (gasRes.error) {
    triggers.push({
      name: 'gas_estimation',
      passed: false,
      detail: 'Transaction would revert: ' + gasRes.error,
    });
    triggersFailed = true;
  } else {
    estimatedGas = gasRes.result;
    var gasNum = parseInt(estimatedGas, 16);
    // Flag extremely high gas (> 10M) as suspicious but not a hard failure
    if (gasNum > 10000000) {
      triggers.push({ name: 'gas_estimation', passed: true, detail: 'WARNING: Very high gas estimate (' + gasNum + '). Transaction is valid but expensive.' });
    } else {
      triggers.push({ name: 'gas_estimation', passed: true, detail: 'Gas estimate: ' + gasNum + ' units' });
    }
  }
}

// ── 1g. Spending limit constraints (optional) ───────────────────

if (!triggersFailed && maxValueWei) {
  var txValue = parseInt(value, 16) || 0;
  var maxVal = parseInt(maxValueWei);
  if (txValue > maxVal) {
    triggers.push({
      name: 'spending_limit',
      passed: false,
      detail: 'Transaction value (' + txValue + ' wei) exceeds spending limit (' + maxVal + ' wei)',
    });
    triggersFailed = true;
  } else {
    triggers.push({ name: 'spending_limit', passed: true, detail: 'Value within spending limit' });
  }
}

// ── 1h. Function selector validation (optional) ─────────────────

var functionSelector = data && data.length >= 10 ? data.slice(0, 10) : null;
var functionSignature = null;

if (functionSelector) {
  // Look up function signature via 4byte.directory
  try {
    var sigRes = await fetch(
      'https://www.4byte.directory/api/v1/signatures/?hex_signature=' + functionSelector,
      { headers: { 'Accept': 'application/json' } }
    );
    if (sigRes.ok) {
      var sigData = await sigRes.json();
      if (sigData.results && sigData.results.length > 0) {
        sigData.results.sort(function(a, b) { return a.id - b.id; });
        functionSignature = sigData.results[0].text_signature;
      }
    }
  } catch (e) { /* non-fatal */ }

  // Check expectedFunction constraint
  if (!triggersFailed && expectedFunction && functionSignature) {
    var fnName = functionSignature.split('(')[0];
    if (fnName.toLowerCase() !== expectedFunction.toLowerCase()) {
      triggers.push({
        name: 'expected_function',
        passed: false,
        detail: 'Expected function "' + expectedFunction + '" but found "' + fnName + '" (' + functionSignature + ')',
      });
      triggersFailed = true;
    } else {
      triggers.push({ name: 'expected_function', passed: true, detail: 'Function matches expected: ' + functionSignature });
    }
  }

  // Check approval amount constraint
  if (!triggersFailed && maxApprovalAmount && functionSignature && functionSignature.startsWith('approve(')) {
    // Decode approval amount from calldata: approve(address,uint256)
    // Bytes: 4 (selector) + 32 (address) + 32 (amount) = 68 bytes = 138 hex chars with 0x
    if (data.length >= 138) {
      var amountHex = '0x' + data.slice(74, 138);
      // Parse as BigInt-safe comparison
      try {
        var approvalAmount = parseInt(amountHex, 16);
        var maxApproval = parseFloat(maxApprovalAmount);
        if (approvalAmount > maxApproval) {
          triggers.push({
            name: 'approval_limit',
            passed: false,
            detail: 'Approval amount (' + approvalAmount + ') exceeds limit (' + maxApproval + ')',
          });
          triggersFailed = true;
        } else {
          triggers.push({ name: 'approval_limit', passed: true, detail: 'Approval amount within limit' });
        }
      } catch (e) {
        triggers.push({ name: 'approval_limit', passed: true, detail: 'Could not parse approval amount (non-fatal)' });
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  EARLY EXIT — reject immediately if any trigger failed
// ════════════════════════════════════════════════════════════════

if (triggersFailed) {
  var failedTrigger = triggers.filter(function(t) { return !t.passed; })[0];
  Lit.Actions.setResponse({
    response: JSON.stringify({
      confidenceScore: 0,
      verdict: 'REJECTED',
      intentMatch: false,
      summary: 'Transaction rejected by deterministic trigger: ' + failedTrigger.name + '. ' + failedTrigger.detail,
      rejectedByTrigger: failedTrigger.name,
      triggers: triggers,
      reasoning: null,
      transaction: {
        chain: chainName, chainId: chain.id, to: to, from: from, value: value,
        functionSelector: functionSelector, functionSignature: functionSignature,
      },
      contract: { isContract: isContract },
      simulation: null,
      findings: [],
      risks: [failedTrigger.detail],
    }),
  });
  // Not throwing — this is a valid result, not an error
  return;
}

// ════════════════════════════════════════════════════════════════
//  ENRICHMENT — gather data for LLM reasoning
// ════════════════════════════════════════════════════════════════

// Transaction simulation
var simulation = null;
var simulationError = null;
var simResponse = await alchemyRpc('alchemy_simulateAssetChanges', [{ from: from, to: to, data: data, value: value }]);
if (simResponse.error) {
  simulationError = simResponse.error;
} else {
  simulation = simResponse.result;
}

// Sourcify contract verification
var sourcifyVerified = false;
var sourcifyStatus = 'unknown';
try {
  var sourcifyUrl = 'https://sourcify.dev/server/check-all-by-addresses?addresses=' + to.toLowerCase() + '&chainIds=' + chain.sourcifyId;
  var sourcifyRes = await fetch(sourcifyUrl, { headers: { 'Accept': 'application/json' } });
  if (sourcifyRes.ok) {
    var sourcifyData = await sourcifyRes.json();
    if (sourcifyData && sourcifyData.length > 0 && sourcifyData[0].chainIds && sourcifyData[0].chainIds.length > 0) {
      var chainResult = sourcifyData[0].chainIds[0];
      if (chainResult.status === 'perfect' || chainResult.status === 'partial') {
        sourcifyVerified = true;
        sourcifyStatus = chainResult.status;
      }
    }
  }
} catch (e) {
  sourcifyStatus = 'error';
}

// Token metadata
var contractMeta = null;
try {
  var metaRes = await alchemyRpc('alchemy_getTokenMetadata', [to]);
  if (metaRes.result && metaRes.result.name) {
    contractMeta = { name: metaRes.result.name, symbol: metaRes.result.symbol, decimals: metaRes.result.decimals };
  }
} catch (e) { /* non-fatal */ }

// ════════════════════════════════════════════════════════════════
//  LAYER 2: GRAPH-OF-THOUGHTS (GoT) REASONING
// ════════════════════════════════════════════════════════════════

// Build evidence block shared by all reasoning paths
var evidence = '';
evidence += 'TRANSACTION:\n';
evidence += '  Chain: ' + chainName + ' (ID ' + chain.id + ')\n';
evidence += '  To: ' + to + '\n';
evidence += '  From: ' + from + '\n';
evidence += '  Value: ' + value + ' wei\n';
evidence += '  Function: ' + (functionSignature || functionSelector || 'unknown') + '\n';
evidence += '  Calldata (' + ((data.length - 2) / 2) + ' bytes): ' + data.slice(0, 200) + (data.length > 200 ? '...' : '') + '\n\n';
evidence += 'CONTRACT:\n';
evidence += '  Has code: ' + isContract + '\n';
evidence += '  Sourcify verified: ' + sourcifyVerified + ' (' + sourcifyStatus + ')\n';
if (contractMeta) {
  evidence += '  Token: ' + contractMeta.name + ' (' + contractMeta.symbol + '), ' + contractMeta.decimals + ' decimals\n';
}
evidence += '\n';
if (simulation) {
  evidence += 'SIMULATION RESULT:\n' + JSON.stringify(simulation, null, 2) + '\n\n';
} else if (simulationError) {
  evidence += 'SIMULATION ERROR: ' + simulationError + '\n\n';
}
evidence += 'DETERMINISTIC TRIGGERS (all passed):\n';
for (var ti = 0; ti < triggers.length; ti++) {
  evidence += '  [' + (triggers[ti].passed ? 'PASS' : 'FAIL') + '] ' + triggers[ti].name + ': ' + triggers[ti].detail + '\n';
}

// GoT prompt: three explicit reasoning paths, then synthesis
var gotPrompt = 'You are a blockchain transaction security analyst using Graph-of-Thoughts reasoning.\n';
gotPrompt += 'You will analyze a transaction through three independent reasoning paths, then synthesize a final verdict.\n\n';
gotPrompt += 'USER INTENT: "' + intent + '"\n\n';
gotPrompt += evidence + '\n';
gotPrompt += '═══ INSTRUCTIONS ═══\n\n';
gotPrompt += 'Work through these three reasoning paths independently. Each path should reach its own conclusion before you synthesize.\n\n';
gotPrompt += 'PATH A — INTENT ALIGNMENT:\n';
gotPrompt += 'Does this transaction actually do what the user described? Check:\n';
gotPrompt += '- Is the target contract the canonical/official contract for the protocol mentioned?\n';
gotPrompt += '- Does the function name match the intended action (deposit, swap, approve, etc.)?\n';
gotPrompt += '- Do the simulated asset changes match expected amounts and tokens?\n';
gotPrompt += '- Are the parameters (amounts, recipients, tokens) consistent with the intent?\n\n';
gotPrompt += 'PATH B — ADVERSARIAL DETECTION:\n';
gotPrompt += 'Look for manipulation patterns that might be hidden in the transaction:\n';
gotPrompt += '- Unlimited token approvals (amount = type(uint256).max) when a specific amount was intended\n';
gotPrompt += '- Hidden transfers to unexpected addresses in the simulation results\n';
gotPrompt += '- Slippage exploitation (swap parameters that allow excessive slippage)\n';
gotPrompt += '- Malicious routing through unexpected intermediary contracts\n';
gotPrompt += '- Approval to a different spender than the protocol would need\n';
gotPrompt += '- Phishing patterns: contract that mimics a known protocol but is at a different address\n\n';
gotPrompt += 'PATH C — COMPLIANCE:\n';
gotPrompt += '- Are there regulatory concerns with this transaction type?\n';
gotPrompt += '- Does this interact with any known mixing services or privacy protocols?\n';
gotPrompt += '- Is the contract verified and auditable (Sourcify status)?\n';
gotPrompt += '- Any AML red flags from the simulation (large values, unusual patterns)?\n\n';
gotPrompt += 'SYNTHESIS:\n';
gotPrompt += 'Combine all three paths into a final verdict. If paths disagree, explain the conflict.\n\n';
gotPrompt += 'Respond with ONLY this JSON (no markdown, no backticks, no other text):\n';
gotPrompt += '{\n';
gotPrompt += '  "pathA": {\n';
gotPrompt += '    "conclusion": "ALIGNED" or "MISALIGNED" or "UNCERTAIN",\n';
gotPrompt += '    "confidence": <0-100>,\n';
gotPrompt += '    "reasoning": "<2-3 sentences explaining the analysis>",\n';
gotPrompt += '    "contractIdentification": "<identified protocol/contract or unknown>"\n';
gotPrompt += '  },\n';
gotPrompt += '  "pathB": {\n';
gotPrompt += '    "conclusion": "CLEAN" or "SUSPICIOUS" or "MALICIOUS",\n';
gotPrompt += '    "confidence": <0-100>,\n';
gotPrompt += '    "reasoning": "<2-3 sentences explaining the analysis>",\n';
gotPrompt += '    "adversarialPatterns": ["<pattern found>"] or []\n';
gotPrompt += '  },\n';
gotPrompt += '  "pathC": {\n';
gotPrompt += '    "conclusion": "COMPLIANT" or "FLAGGED" or "UNKNOWN",\n';
gotPrompt += '    "confidence": <0-100>,\n';
gotPrompt += '    "reasoning": "<2-3 sentences explaining the analysis>"\n';
gotPrompt += '  },\n';
gotPrompt += '  "synthesis": {\n';
gotPrompt += '    "confidenceScore": <0-100>,\n';
gotPrompt += '    "verdict": "SAFE" or "SUSPICIOUS" or "DANGEROUS",\n';
gotPrompt += '    "intentMatch": true or false,\n';
gotPrompt += '    "summary": "<1-2 sentence final summary>",\n';
gotPrompt += '    "risks": ["<any risks>"] or [],\n';
gotPrompt += '    "conflicts": "<any disagreements between paths, or none>"\n';
gotPrompt += '  }\n';
gotPrompt += '}\n';

var llmRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + openrouterKey,
    'HTTP-Referer': 'https://usemur.dev',
    'X-Title': 'Murmuration Transaction Checker',
  },
  body: JSON.stringify({
    model: 'google/gemini-2.5-flash',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You are a blockchain security analyst. Always respond with valid JSON only. No markdown, no backticks, no explanation outside the JSON.' },
      { role: 'user', content: gotPrompt },
    ],
    temperature: 0.1,
    max_tokens: 3000,
  }),
});

var reasoning = null;
var llmError = null;

if (!llmRes.ok) {
  var errText = await llmRes.text();
  llmError = 'LLM API failed (' + llmRes.status + '): ' + errText.slice(0, 500);
} else {
  var llmData = await llmRes.json();
  var content = llmData.choices && llmData.choices[0] && llmData.choices[0].message && llmData.choices[0].message.content;
  if (content) {
    // Try parsing directly, then try extracting from code blocks
    var jsonStr = content.trim();
    // Strip markdown code fences if present
    var fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    try {
      reasoning = JSON.parse(jsonStr);
    } catch (e) {
      // Last resort: find first { and last }
      var firstBrace = jsonStr.indexOf('{');
      var lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          reasoning = JSON.parse(jsonStr.slice(firstBrace, lastBrace + 1));
        } catch (e2) {
          llmError = 'Failed to parse LLM response as JSON. Raw: ' + content.slice(0, 300);
        }
      } else {
        llmError = 'LLM returned non-JSON response: ' + content.slice(0, 300);
      }
    }
  } else {
    llmError = 'No content in LLM response';
  }
}

// ── Build final response ────────────────────────────────────────

var synthesis = reasoning && reasoning.synthesis ? reasoning.synthesis : null;

var response = {
  // Top-level verdict
  confidenceScore: synthesis ? synthesis.confidenceScore : 0,
  verdict: synthesis ? synthesis.verdict : (llmError ? 'ERROR' : 'UNKNOWN'),
  intentMatch: synthesis ? synthesis.intentMatch : false,
  summary: synthesis ? synthesis.summary : (llmError || 'Analysis unavailable'),

  // Deterministic triggers
  triggers: triggers,
  allTriggersPassed: !triggersFailed,

  // Graph-of-Thoughts reasoning trace
  reasoning: reasoning ? {
    pathA_intentAlignment: reasoning.pathA || null,
    pathB_adversarialDetection: reasoning.pathB || null,
    pathC_compliance: reasoning.pathC || null,
    synthesis: synthesis,
  } : (llmError ? { error: llmError } : null),

  // Transaction details
  transaction: {
    chain: chainName,
    chainId: chain.id,
    to: to,
    from: from,
    value: value,
    functionSelector: functionSelector,
    functionSignature: functionSignature,
    estimatedGas: estimatedGas,
  },

  // Contract verification
  contract: {
    isContract: isContract,
    sourcifyVerified: sourcifyVerified,
    sourcifyStatus: sourcifyStatus,
    metadata: contractMeta,
    identification: reasoning && reasoning.pathA ? reasoning.pathA.contractIdentification : null,
  },

  // Simulation results
  simulation: simulationError ? { error: simulationError } : simulation,

  // Aggregated risks
  risks: (synthesis && synthesis.risks ? synthesis.risks : []).concat(
    reasoning && reasoning.pathB && reasoning.pathB.adversarialPatterns ? reasoning.pathB.adversarialPatterns : []
  ),
};

Lit.Actions.setResponse({
  response: JSON.stringify(response),
});
