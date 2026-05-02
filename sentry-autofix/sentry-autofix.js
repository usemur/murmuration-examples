// Sentry Autofix — when Sentry reports a new issue, a Claude managed
// agent investigates the stack trace, edits the code, runs tests, and
// opens a PR authored by the Mur GitHub App.
//
// Three-phase action flow modeled on dead-drop:
//   "autofix" — spawn a managed agent session with the bug brief +
//               GitHub installation token + repo handle. Returns the
//               sessionId so the caller can poll.
//   "status"  — poll the session's lifecycle.
//   "result"  — once idle, extract the agent's structured PR verdict
//               from its final message and return it.
//
// Why three phases (and not one blocking call): managed-agent runs
// take 1-15 minutes for non-trivial fixes — far past the Lit Action
// execution budget. The platform's webhook handler kicks off
// "autofix", persists sessionId in FlowState, and a separate
// poll loop walks pending sessions to "status" + "result".
//
// Secrets (publisher-supplied — the Murmuration team's vault):
//   ANTHROPIC_API_KEY  — auth for the managed-agents API
//   MANAGED_AGENT_ID   — the agent definition with Bash + git + node
//                        tools wired in
//   MANAGED_ENV_ID     — sandbox environment with unrestricted
//                        networking (so the agent can `git clone`,
//                        hit the GitHub API, run tests against
//                        installed dependencies)
//
// Per-invocation params (autofix only):
//   action                      — 'autofix' | 'status' | 'result'
//   repoFullName                — 'owner/name' the agent will clone
//   githubInstallationToken     — short-lived token; agent uses it
//                                 for `git clone`, `git push`, and
//                                 the GitHub PR API
//   taskBrief                   — the bug summary from the Sentry
//                                 webhook (stack trace, top frame,
//                                 culprit, permalink)
//   sentryIssueId               — passed back in the agent's PR
//                                 body so resolves can link
//   baseBranch                  — optional, defaults to repo default

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
var validActions = ['autofix', 'status', 'result'];
if (!action || !validActions.includes(action)) {
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: 'Missing or invalid "action". Must be one of: ' + validActions.join(', '),
    }),
  });
  throw new Error('Invalid action');
}

// ── Helpers ─────────────────────────────────────────────────────

var AGENT_BASE = 'https://api.anthropic.com/v1';

// Dynamic pricing: this flow is published with paymentScheme: 'upto'
// at a $0.05 max — that's cost-recovery for the Anthropic API calls
// the flow makes (session create + message send + polls). The
// CUSTOMER-facing $1.00-per-PR price lives at the cofounder webhook
// handler layer (`sentry.handler.ts` debits via cofounderCredits),
// which is the canonical billing path and the only path that
// implements "no charge when the agent gives up" via refund. Direct
// invocations of this published flow pay cost-recovery prices, and
// the catalog YAML / cofounder registry are explicit that the $1
// outcome price comes from the webhook path.
//
//   autofix → $0.05  (session create + events POST — bounded burn)
//   status  → $0.001 (one Anthropic GET to poll session events)
//   result  → $0.001 (one Anthropic GET + transcript parse)
//
// Validation failures (missing repoFullName etc.) throw, so the
// invoke route sees `success: false` and full-refunds the max.
var COST_AUTOFIX = 50000;
var COST_POLL = 1000;

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

// Extract the trailing JSON object from a string. The agent is
// instructed to terminate its final message with `RESULT: { ... }`,
// but we defend against (a) fenced code blocks earlier in the
// transcript and (b) conversational preamble (Sonnet sometimes
// wraps even when told not to). The TRAILING block is what matters
// — earlier code/JSON snippets are scratch work the agent showed
// while reasoning. Order:
//   1. If a `RESULT:` marker exists, prefer the JSON immediately
//      after the LAST occurrence of it.
//   2. Else, prefer the LAST fenced code block (not the first).
//   3. Else, walk back from the last `}` to find balanced JSON.
function extractTrailingJson(text) {
  if (typeof text !== 'string') return null;
  var trimmed = text.trim();

  // 1. Trailing `RESULT:` marker — strongest signal.
  var resultIdx = trimmed.lastIndexOf('RESULT:');
  if (resultIdx >= 0) {
    var afterMarker = trimmed.slice(resultIdx + 'RESULT:'.length).trim();
    var afterParsed = parseFirstObject(afterMarker);
    if (afterParsed) return afterParsed;
  }

  // 2. Last fenced JSON block. Walk all matches, keep the last.
  var fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  var lastFence = null;
  var fm;
  while ((fm = fenceRe.exec(trimmed)) !== null) {
    lastFence = fm[1];
  }
  if (lastFence) {
    try {
      var parsed = JSON.parse(lastFence.trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) { /* fall through */ }
  }

  // 3. Forward scan for the LAST balanced top-level JSON object.
  //    String-aware: braces inside `"..."` are skipped, and `\"` /
  //    other escapes don't end the string. A naive byte-count parser
  //    would misidentify object boundaries when the agent's
  //    `summary` or `reason` quotes code containing `{` / `}`.
  return findLastBalancedObject(trimmed);
}

// Forward scan that returns the LAST balanced JSON object found in
// the string, or null if none parses. Tracks string-literal state so
// braces inside quotes are ignored.
function findLastBalancedObject(s) {
  if (typeof s !== 'string') return null;
  var lastParsed = null;
  var i = 0;
  var len = s.length;
  while (i < len) {
    if (s[i] === '{') {
      var end = matchBalancedObjectEnd(s, i);
      if (end > i) {
        try {
          var candidate = JSON.parse(s.slice(i, end + 1));
          if (candidate && typeof candidate === 'object') {
            lastParsed = candidate;
          }
        } catch (e) { /* not parseable, skip */ }
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return lastParsed;
}

// Parse the first complete JSON object embedded in a string. Used to
// pull a JSON payload that follows a marker like `RESULT:`.
function parseFirstObject(s) {
  if (typeof s !== 'string') return null;
  var start = s.indexOf('{');
  if (start < 0) return null;
  var end = matchBalancedObjectEnd(s, start);
  if (end < 0) return null;
  try {
    var parsed = JSON.parse(s.slice(start, end + 1));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) { /* fall through */ }
  return null;
}

// Given a string and an index of an opening `{`, return the index of
// the matching closing `}` — counting only braces OUTSIDE string
// literals. Returns -1 if no match. JSON strings start with `"`, end
// with the next unescaped `"`, and `\\` / `\"` are escapes.
function matchBalancedObjectEnd(s, start) {
  var depth = 0;
  var inString = false;
  var i = start;
  var len = s.length;
  while (i < len) {
    var ch = s[i];
    if (inString) {
      if (ch === '\\') {
        // Skip the next char (\" or \\ or \n etc.)
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
    i++;
  }
  return -1;
}

// Pull all assistant text out of a session events list.
function collectAgentText(eventList) {
  if (!Array.isArray(eventList)) return '';
  var out = '';
  for (var i = 0; i < eventList.length; i++) {
    var evt = eventList[i];
    if (evt.type !== 'agent.message' && evt.type !== 'assistant' && evt.type !== 'agent.text') continue;
    if (typeof evt.content === 'string') {
      out += evt.content + '\n';
    } else if (Array.isArray(evt.content)) {
      for (var ci = 0; ci < evt.content.length; ci++) {
        if (evt.content[ci] && evt.content[ci].text) out += evt.content[ci].text + '\n';
      }
    } else if (typeof evt.text === 'string') {
      out += evt.text + '\n';
    }
  }
  return out;
}

function deriveSessionStatus(eventList) {
  if (!Array.isArray(eventList)) return 'unknown';
  for (var i = eventList.length - 1; i >= 0; i--) {
    if (eventList[i].type === 'session.status_idle') return 'idle';
    if (eventList[i].type === 'session.status_terminated') return 'terminated';
  }
  return 'running';
}

// ════════════════════════════════════════════════════════════════
//  ACTION: AUTOFIX
// ════════════════════════════════════════════════════════════════

if (action === 'autofix') {
  if (!params.repoFullName || typeof params.repoFullName !== 'string') {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "repoFullName" (e.g. "acme/api")' }) });
    throw new Error('Missing repoFullName');
  }
  if (!params.githubInstallationToken || typeof params.githubInstallationToken !== 'string') {
    Lit.Actions.setResponse({
      response: JSON.stringify({ error: 'Missing "githubInstallationToken". Mint via the GitHub App and pass per-call.' }),
    });
    throw new Error('Missing githubInstallationToken');
  }
  if (!params.taskBrief || typeof params.taskBrief !== 'string') {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "taskBrief"' }) });
    throw new Error('Missing taskBrief');
  }
  if (!params.sentryIssueId) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "sentryIssueId"' }) });
    throw new Error('Missing sentryIssueId');
  }

  var baseBranch = params.baseBranch || 'main';
  var branchName = 'mur/sentry-autofix-' + params.sentryIssueId + '-' + Date.now();

  // The agent's marching orders. The installation token is embedded
  // directly in the clone URL + curl Authorization headers (rather
  // than passed as an env var) — that's how dead-drop and other
  // managed-agent flows in this codebase pass secrets. The token is
  // short-lived (~1h) so the agent must finish in that budget. The
  // PR commits/pushes as the Mur GitHub App's bot identity by
  // virtue of authenticating with the installation token, which
  // renders as `<bot>[bot]` on github.com.
  //
  // Final message MUST end with `RESULT:` followed by JSON; the
  // `result` action parses the trailing block.
  var token = params.githubInstallationToken;
  var spawnPrompt = '';
  spawnPrompt += 'A new error was reported by Sentry. Investigate, propose a fix, and open a PR.\n\n';
  spawnPrompt += '═══ BUG BRIEF ═══\n';
  spawnPrompt += params.taskBrief + '\n\n';
  spawnPrompt += '═══ REPO ═══\n';
  spawnPrompt += 'Repo: ' + params.repoFullName + '\n';
  spawnPrompt += 'Base branch: ' + baseBranch + '\n';
  spawnPrompt += 'Working branch (create this): ' + branchName + '\n';
  spawnPrompt += 'Sentry issue id: ' + params.sentryIssueId + '\n\n';
  spawnPrompt += '═══ STEPS ═══\n';
  spawnPrompt += '1. Clone the repo (the GitHub installation token is\n';
  spawnPrompt += '   embedded in the URL — short-lived, do not log it):\n';
  spawnPrompt += '     git clone https://x-access-token:' + token + '@github.com/' + params.repoFullName + '.git repo\n';
  spawnPrompt += '2. Read the offending file based on the stack trace. Read related files\n';
  spawnPrompt += '   to understand the code, then make the smallest change that addresses\n';
  spawnPrompt += '   the root cause. No drive-by refactors.\n';
  spawnPrompt += '3. Run the test suite if one exists. If you cannot make tests pass with\n';
  spawnPrompt += '   confidence, mark the PR as draft (see step 5).\n';
  spawnPrompt += '4. Configure the git author (the sandbox image may not\n';
  spawnPrompt += '   have a global identity, in which case `git commit` fails\n';
  spawnPrompt += '   with "Please tell me who you are"):\n';
  spawnPrompt += '     git -C repo config user.email "mur-bot@usemur.dev"\n';
  spawnPrompt += '     git -C repo config user.name  "Mur Autofix Bot"\n';
  spawnPrompt += '   The PR will still render as authored by the Mur GitHub App\n';
  spawnPrompt += '   on github.com because the push is authenticated with the\n';
  spawnPrompt += '   installation token in the clone URL.\n';
  spawnPrompt += '5. Commit + push the fix on a new branch (run these from\n';
  spawnPrompt += '   inside the cloned repo, e.g. `cd repo` first or use `-C repo`):\n';
  spawnPrompt += '     git -C repo checkout -b ' + branchName + '\n';
  spawnPrompt += '     git -C repo add -A\n';
  spawnPrompt += '     git -C repo commit -m "fix: <one-line summary>"\n';
  spawnPrompt += '     git -C repo push -u origin ' + branchName + '\n';
  spawnPrompt += '6. Open a PR via the GitHub API (use the same token from the\n';
  spawnPrompt += '   clone URL above as the Bearer token here):\n';
  spawnPrompt += '     curl -X POST https://api.github.com/repos/' + params.repoFullName + '/pulls \\\n';
  spawnPrompt += '       -H "Authorization: Bearer ' + token + '" \\\n';
  spawnPrompt += '       -H "Accept: application/vnd.github+json" \\\n';
  spawnPrompt += '       -H "X-GitHub-Api-Version: 2022-11-28" \\\n';
  spawnPrompt += '       -d \'{"title":"...","head":"' + branchName + '","base":"' + baseBranch + '","body":"...","draft":false}\'\n';
  spawnPrompt += '   PR body MUST link the Sentry issue and explain root cause + fix.\n';
  spawnPrompt += '7. If you cannot identify a fix with reasonable confidence, do NOT push\n';
  spawnPrompt += '   a placeholder PR. Skip steps 5-6 and report `prOpened: false` with\n';
  spawnPrompt += '   a `reason` field explaining what blocked you.\n\n';
  spawnPrompt += '═══ FINAL OUTPUT ═══\n';
  spawnPrompt += 'After (success or give-up), end your final assistant message with:\n\n';
  spawnPrompt += 'RESULT: {\n';
  spawnPrompt += '  "prOpened": true | false,\n';
  spawnPrompt += '  "prNumber": <number> | null,\n';
  spawnPrompt += '  "prUrl": "<url>" | null,\n';
  spawnPrompt += '  "branch": "' + branchName + '",\n';
  spawnPrompt += '  "summary": "<1-3 sentences on what you did>",\n';
  spawnPrompt += '  "reason": "<only if prOpened=false: why you gave up>"\n';
  spawnPrompt += '}\n';

  // Create the session. The token is already embedded in the prompt
  // (in the clone URL + curl Authorization header) — that's the
  // pattern dead-drop and other managed-agent flows use here, since
  // we can't rely on `environment_variables` being exposed to bash
  // tool calls in this runtime.
  var session = await agentFetch('POST', '/sessions', {
    agent: managedAgentId,
    environment_id: managedEnvId,
  });

  // Once /sessions returns, a managed-agent session EXISTS on
  // Anthropic's side and may start running on its own. From this
  // point we MUST surface session.id back to the caller, even if
  // the events POST below fails — otherwise the caller would see
  // a generic throw, treat it as pre-spawn, and let a retry spawn
  // a duplicate session against the same Sentry issue.
  try {
    await agentFetch('POST', '/sessions/' + session.id + '/events', {
      events: [{
        type: 'user.message',
        content: [{ type: 'text', text: spawnPrompt }],
      }],
    });
  } catch (eventsErr) {
    // Session was created but the message send failed (network blip,
    // Anthropic 5xx, etc.). Return the sessionId with a partial
    // status so the caller records it and treats the run as
    // abandoned instead of retrying into a duplicate.
    Lit.Actions.setResponse({
      response: JSON.stringify({
        status: 'spawn_partial',
        sessionId: session.id,
        branch: branchName,
        sentryIssueId: params.sentryIssueId,
        repoFullName: params.repoFullName,
        error: 'session created but message send failed: ' +
               (eventsErr && eventsErr.message ? eventsErr.message : String(eventsErr)),
        _actualCost: COST_AUTOFIX,
      }),
    });
    return;
  }

  Lit.Actions.setResponse({
    response: JSON.stringify({
      status: 'spawned',
      sessionId: session.id,
      branch: branchName,
      sentryIssueId: params.sentryIssueId,
      repoFullName: params.repoFullName,
      _actualCost: COST_AUTOFIX,
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
  var sessionStatus = deriveSessionStatus(statusList);

  Lit.Actions.setResponse({
    response: JSON.stringify({
      status: sessionStatus,
      sessionId: params.sessionId,
      eventCount: Array.isArray(statusList) ? statusList.length : 0,
      _actualCost: COST_POLL,
    }),
  });
}

// ════════════════════════════════════════════════════════════════
//  ACTION: RESULT
// ════════════════════════════════════════════════════════════════

if (action === 'result') {
  if (!params.sessionId) {
    Lit.Actions.setResponse({ response: JSON.stringify({ error: 'Missing "sessionId"' }) });
    throw new Error('Missing sessionId');
  }

  var resultEvents = await agentFetch('GET', '/sessions/' + params.sessionId + '/events');
  var resultList = resultEvents.data || resultEvents.events || resultEvents;
  var resultStatus = deriveSessionStatus(resultList);

  if (resultStatus !== 'idle' && resultStatus !== 'terminated') {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        status: 'pending',
        sessionId: params.sessionId,
        detail: 'Agent is still working',
        _actualCost: COST_POLL,
      }),
    });
    return;
  }

  var transcript = collectAgentText(resultList);
  var verdict = extractTrailingJson(transcript);

  if (!verdict || typeof verdict.prOpened !== 'boolean') {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        status: 'error',
        sessionId: params.sessionId,
        detail: 'Agent finished but no parseable RESULT block was found',
        // Surface the tail of the transcript so a human can debug.
        transcriptTail: transcript.slice(-2000),
        _actualCost: COST_POLL,
      }),
    });
    return;
  }

  Lit.Actions.setResponse({
    response: JSON.stringify({
      status: 'completed',
      sessionId: params.sessionId,
      sessionStatus: resultStatus,
      prOpened: verdict.prOpened,
      prNumber: typeof verdict.prNumber === 'number' ? verdict.prNumber : null,
      prUrl: typeof verdict.prUrl === 'string' ? verdict.prUrl : null,
      branch: typeof verdict.branch === 'string' ? verdict.branch : null,
      summary: typeof verdict.summary === 'string' ? verdict.summary : '',
      ...(typeof verdict.reason === 'string' ? { reason: verdict.reason } : {}),
      _actualCost: COST_POLL,
    }),
  });
}
