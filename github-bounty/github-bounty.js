// GitHub Bounty — escrow arbiter that uses a Claude managed agent to review
// whether a PR solves a GitHub issue, then signs an on-chain release.
//
// This is a generic escrow pattern with a GitHub-specific implementation.
// The same contract + flow structure works for any async human/AI review
// (freelance deliverables, content approval, etc.) — just change what
// you fetch and how you prompt the agent.
//
// Secrets required: ANTHROPIC_API_KEY, GITHUB_TOKEN, MANAGED_AGENT_ID, MANAGED_ENV_ID
//
// Actions:
//   "claim"  — fetch issue + PR from GitHub, spawn a Claude agent to review, return sessionId
//   "check"  — poll the agent session; if done and APPROVED, sign a release for the escrow contract
//   "status" — lightweight poll of agent session status
//
// Input (claim):  { action: "claim", bountyId, issueUrl, prUrl, claimantAddress }
// Input (check):  { action: "check", bountyId, sessionId, claimantAddress, chainId? }
// Input (status): { action: "status", sessionId }
//
// Output (claim): { status: "reviewing", sessionId, issue: {title}, pr: {title, author} }
// Output (check): { status: "approved"|"rejected"|"pending", signature?, reasoning?, signerAddress? }
// Output (status): { status: "running"|"idle"|"terminated" }

// ── Validate secrets ────────────────────────────────────────────

var anthropicKey = params.secrets && params.secrets.ANTHROPIC_API_KEY;
if (!anthropicKey) {
  Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing ANTHROPIC_API_KEY secret' }) });
  throw new Error('Missing ANTHROPIC_API_KEY secret');
}

var githubToken = params.secrets && params.secrets.GITHUB_TOKEN;
if (!githubToken) {
  Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing GITHUB_TOKEN secret' }) });
  throw new Error('Missing GITHUB_TOKEN secret');
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
if (!action || !['claim', 'check', 'status'].includes(action)) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'Missing or invalid "action". Must be "claim", "check", or "status".' }),
  });
  throw new Error('Invalid action');
}

// ── GitHub helpers ──────────────────────────────────────────────

function parseGitHubUrl(url) {
  // Accepts: https://github.com/owner/repo/issues/123 or /pull/123
  var match = url.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], type: match[3], number: parseInt(match[4]) };
}

async function ghFetch(path) {
  var res = await fetch('https://api.github.com' + path, {
    headers: {
      'Authorization': 'token ' + githubToken,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'flows-github-bounty',
    },
  });
  if (!res.ok) {
    var text = await res.text();
    throw new Error('GitHub API error (' + res.status + '): ' + text.slice(0, 300));
  }
  return res.json();
}

async function ghFetchDiff(owner, repo, prNumber) {
  var res = await fetch('https://api.github.com/repos/' + owner + '/' + repo + '/pulls/' + prNumber, {
    headers: {
      'Authorization': 'token ' + githubToken,
      'Accept': 'application/vnd.github.v3.diff',
      'User-Agent': 'flows-github-bounty',
    },
  });
  if (!res.ok) {
    var text = await res.text();
    throw new Error('GitHub diff fetch failed (' + res.status + '): ' + text.slice(0, 300));
  }
  return res.text();
}

// ── Managed agent helpers ──────────────────────────────────────
// Beta API: https://platform.claude.com/docs/en/api/beta/sessions/create

var AGENT_BASE = 'https://api.anthropic.com/v1';

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

// ════════════════════════════════════════════════════════════════
//  ACTION: CLAIM
// ════════════════════════════════════════════════════════════════

if (action === 'claim') {
  // Validate inputs
  if (!params.bountyId && params.bountyId !== 0) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "bountyId"' }) });
    throw new Error('Missing bountyId');
  }
  if (!params.issueUrl) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "issueUrl"' }) });
    throw new Error('Missing issueUrl');
  }
  if (!params.prUrl) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "prUrl"' }) });
    throw new Error('Missing prUrl');
  }
  if (!params.claimantAddress) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "claimantAddress"' }) });
    throw new Error('Missing claimantAddress');
  }

  var issue = parseGitHubUrl(params.issueUrl);
  if (!issue || issue.type !== 'issues') {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Invalid issue URL. Expected: https://github.com/owner/repo/issues/123' }) });
    throw new Error('Invalid issue URL');
  }

  var pr = parseGitHubUrl(params.prUrl);
  if (!pr || pr.type !== 'pull') {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Invalid PR URL. Expected: https://github.com/owner/repo/pull/123' }) });
    throw new Error('Invalid PR URL');
  }

  // Fetch GitHub data
  var issueData = await ghFetch('/repos/' + issue.owner + '/' + issue.repo + '/issues/' + issue.number);
  var prData = await ghFetch('/repos/' + pr.owner + '/' + pr.repo + '/pulls/' + pr.number);
  var diffText = await ghFetchDiff(pr.owner, pr.repo, pr.number);

  // Truncate diff if extremely large (keep first 50k chars)
  var maxDiff = 50000;
  var truncatedDiff = diffText.length > maxDiff
    ? diffText.slice(0, maxDiff) + '\n\n... [diff truncated at ' + maxDiff + ' chars] ...'
    : diffText;

  // Build review prompt
  var reviewPrompt = 'You are reviewing a pull request to determine if it solves a GitHub issue.\n';
  reviewPrompt += 'A bounty has been placed on this issue. Your job is to carefully assess whether\n';
  reviewPrompt += 'the PR adequately addresses the issue requirements.\n\n';
  reviewPrompt += '═══ GITHUB ISSUE ═══\n';
  reviewPrompt += 'Title: ' + issueData.title + '\n';
  reviewPrompt += 'URL: ' + params.issueUrl + '\n';
  reviewPrompt += 'Body:\n' + (issueData.body || '(no body)') + '\n\n';
  reviewPrompt += '═══ PULL REQUEST ═══\n';
  reviewPrompt += 'Title: ' + prData.title + '\n';
  reviewPrompt += 'Author: ' + prData.user.login + '\n';
  reviewPrompt += 'URL: ' + params.prUrl + '\n';
  reviewPrompt += 'Body:\n' + (prData.body || '(no body)') + '\n\n';
  reviewPrompt += '═══ DIFF ═══\n' + truncatedDiff + '\n\n';
  reviewPrompt += '═══ INSTRUCTIONS ═══\n';
  reviewPrompt += 'Analyze this PR against the issue. Check:\n';
  reviewPrompt += '1. Does the PR address ALL requirements stated in the issue?\n';
  reviewPrompt += '2. Is the implementation complete (no TODOs, empty functions, placeholder code)?\n';
  reviewPrompt += '3. Are there obvious security issues or bugs?\n';
  reviewPrompt += '4. Is the code quality reasonable (not obfuscated, not malicious)?\n\n';
  reviewPrompt += 'Respond with ONLY this JSON (no markdown, no backticks):\n';
  reviewPrompt += '{\n';
  reviewPrompt += '  "verdict": "APPROVED" or "REJECTED",\n';
  reviewPrompt += '  "confidence": <0-100>,\n';
  reviewPrompt += '  "reasoning": "<detailed explanation of your assessment>",\n';
  reviewPrompt += '  "requirements_met": ["<requirement 1>", ...],\n';
  reviewPrompt += '  "requirements_missing": ["<missing requirement>", ...],\n';
  reviewPrompt += '  "concerns": ["<any concerns>", ...]\n';
  reviewPrompt += '}\n';

  // Create managed agent session and send review task
  var session = await agentFetch('POST', '/sessions', {
    agent: { type: 'agent', id: managedAgentId },
    environment_id: managedEnvId,
  });

  await agentFetch('POST', '/sessions/' + session.id + '/events', {
    events: [{
      type: 'user.message',
      content: [{ type: 'text', text: reviewPrompt }],
    }],
  });

  Lit.Actions.setResponse({
    response: JSON.stringify({
      status: 'reviewing',
      sessionId: session.id,
      bountyId: params.bountyId,
      claimantAddress: params.claimantAddress,
      issue: {
        title: issueData.title,
        url: params.issueUrl,
        owner: issue.owner,
        repo: issue.repo,
        number: issue.number,
      },
      pr: {
        title: prData.title,
        author: prData.user.login,
        url: params.prUrl,
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
      },
    }),
  });
}

// ════════════════════════════════════════════════════════════════
//  ACTION: CHECK
// ════════════════════════════════════════════════════════════════

if (action === 'check') {
  if (!params.bountyId && params.bountyId !== 0) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "bountyId"' }) });
    throw new Error('Missing bountyId');
  }
  if (!params.sessionId) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "sessionId"' }) });
    throw new Error('Missing sessionId');
  }
  if (!params.claimantAddress) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "claimantAddress"' }) });
    throw new Error('Missing claimantAddress');
  }

  // Fetch session events (paginated — data field contains the array)
  var events = await agentFetch('GET', '/sessions/' + params.sessionId + '/events');
  var eventList = events.data || events.events || events;
  if (!Array.isArray(eventList)) {
    Lit.Actions.setResponse({ response: JSON.stringify({ status: 'pending', detail: 'Could not parse session events' }) });
    return;
  }

  // Look for session.status_idle (agent is done)
  var isIdle = eventList.some(function(e) { return e.type === 'session.status_idle'; });
  if (!isIdle) {
    Lit.Actions.setResponse({ response: JSON.stringify({ status: 'pending', detail: 'Agent is still reviewing' }) });
    return;
  }

  // Find the last agent.message event with verdict JSON
  var verdict = null;
  for (var i = eventList.length - 1; i >= 0; i--) {
    var evt = eventList[i];
    if (evt.type === 'agent.message' || evt.type === 'assistant' || evt.type === 'agent.text') {
      // Content may be a string, an array of blocks [{type:"text",text:"..."}], or nested
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
      // Try to extract JSON
      var jsonStr = content.trim();
      var fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) jsonStr = fenceMatch[1].trim();
      try {
        var parsed = JSON.parse(jsonStr);
        if (parsed.verdict) { verdict = parsed; break; }
      } catch (e) {
        // Try finding JSON in the text
        var firstBrace = jsonStr.indexOf('{');
        var lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          try {
            var extracted = JSON.parse(jsonStr.slice(firstBrace, lastBrace + 1));
            if (extracted.verdict) { verdict = extracted; break; }
          } catch (e2) { /* continue searching */ }
        }
      }
    }
  }

  if (!verdict) {
    Lit.Actions.setResponse({
      response: JSON.stringify({ status: 'error', detail: 'Agent completed but no verdict found in response' }),
    });
    return;
  }

  // If APPROVED, sign the release message
  if (verdict.verdict === 'APPROVED') {
    if (!params.pkpAddress) {
      Lit.Actions.setResponse({
        response: JSON.stringify({ error: 'No vault PKP — flow needs a vault set up to sign releases' }),
      });
      throw new Error('No vault PKP');
    }

    var chainId = params.chainId || 8453; // Default to Base
    var bountyId = typeof params.bountyId === 'string' ? parseInt(params.bountyId) : params.bountyId;

    // Sign: keccak256("BOUNTY_RELEASE", bountyId, claimantAddress, chainId)
    var messageHash = ethers.utils.solidityKeccak256(
      ['string', 'uint256', 'address', 'uint256'],
      ['BOUNTY_RELEASE', bountyId, params.claimantAddress, chainId]
    );

    var privateKey = await Lit.Actions.getPrivateKey({ pkpId: params.pkpAddress });
    var wallet = new ethers.Wallet(privateKey);
    var signature = await wallet.signMessage(ethers.utils.arrayify(messageHash));

    Lit.Actions.setResponse({
      response: JSON.stringify({
        status: 'approved',
        signature: signature,
        signerAddress: wallet.address,
        chainId: chainId,
        bountyId: bountyId,
        claimantAddress: params.claimantAddress,
        reasoning: verdict.reasoning,
        confidence: verdict.confidence,
        requirements_met: verdict.requirements_met || [],
        requirements_missing: verdict.requirements_missing || [],
        concerns: verdict.concerns || [],
      }),
    });
  } else {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        status: 'rejected',
        reasoning: verdict.reasoning,
        confidence: verdict.confidence,
        requirements_met: verdict.requirements_met || [],
        requirements_missing: verdict.requirements_missing || [],
        concerns: verdict.concerns || [],
      }),
    });
  }
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
