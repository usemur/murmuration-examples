# sentry-autofix

When Sentry reports a new error, a Claude managed agent inside the TEE
clones your repo, reads the offending code, runs your tests, pushes a
branch, and opens a PR authored by the Mur GitHub App bot. **$1.00 per
PR opened**, refunded if the agent gives up. Hook the Sentry webhook
once and future issues fix themselves while you sleep.

This is a **cofounder flow** — it fires automatically off a Sentry
webhook into the Mur platform, not via direct `/invoke` like
`twenty-deployer` or `dead-drop`. There's no MCP wiring; once the
flow is enabled and configured, every new Sentry issue runs through it.

> **Auth model during dogfood.** Each developer mints a per-account
> `sentryWebhookToken` at install time and pastes
> `<base>/api/webhooks/sentry/t/<token>` into a Sentry Internal
> Integration in their own org. URL secrecy is the auth — no HMAC.
> The Sentry auth token from that integration goes into the user's
> Mur vault as `SENTRY_AUTH_TOKEN` (used by the agent for richer issue
> context). HMAC verification can be layered on later when we
> graduate to a public Sentry Integration with OAuth.

## Pipeline

```
Sentry issue.created webhook
         ↓
POST /api/webhooks/sentry/t/<devToken>  (URL-token attributed, request-id-deduped)
         ↓
sentry.handler.ts
  ├── atomic claim by Sentry issue id (one PR per bug)
  ├── resolve GitHub install for the mapped repo
  ├── debit $1.00 (refunded if no PR opens)
  └── spawn Claude managed agent via the published Lit Action
         ↓
Agent inside the TEE
  ├── git clone <repo> with installation token
  ├── read code + run tests
  ├── propose fix
  └── git push + open PR via GitHub API
         ↓
PR appears, authored by mur[bot]
```

## Setup checklist

You need three things to be true:

1. **The Mur GitHub App is installed on your target repo** — already
   handled if you ran `/mur connect github` and selected the repo (or
   went through the cofounder install flow). The App needs
   `pull_requests:write` + `contents:write`.
2. **A Sentry Internal Integration exists** in your Sentry org with
   its webhook pointed at the per-developer URL Mur returned in the
   install response (`<base>/api/webhooks/sentry/t/<token>`).
3. **A Sentry-project → GitHub-repo mapping is configured** so the
   agent knows which repo to clone when an error fires.

The rest of this README walks you through the parts you do.

## Step 1 — install the flow

Run the install first — the response includes the per-developer
webhook URL and a deeplink to your vault that you'll use in step 2.

The curl examples below use `$MUR_API_BASE` and `$MUR_API_KEY`.
Set them once before running anything:

```bash
# Read from ~/.murmur/account.json (the file `claim-connect.mjs`
# writes after a successful claim):
export MUR_API_BASE=$(jq -r .apiBase ~/.murmur/account.json)
export MUR_API_KEY=$(jq -r .accountKey ~/.murmur/account.json)
# Sanity check — should print "https://usemur.dev" or your
# self-hosted base URL:
echo "$MUR_API_BASE"
```

If you're not using Mur's claim flow, set them by hand:
`export MUR_API_BASE=https://your-deployment` /
`export MUR_API_KEY=mur_...`.

```bash
curl -X POST $MUR_API_BASE/api/flows/install \
  -H "Authorization: Bearer $MUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "slug": "sentry-autofix" }'
```

Or just say `/mur install sentry-autofix` to your coding agent and it'll
walk through it.

The 201 response includes `setupInstructions.webhookUrl`,
`setupInstructions.vaultUrl`, and `setupInstructions.steps[]` —
copy the webhook URL and the vault deeplink for the next step. The
install also flips the per-project `enabled` gate; without it the
handler returns `flow_not_enabled` and nothing happens.

## Step 2 — Sentry side + paste your token

In your Sentry org's dashboard:

1. **Settings → Custom Integrations → Create New Integration → Internal**
2. **Name:** "Mur Autofix" (or whatever)
3. **Webhook URL:** the `setupInstructions.webhookUrl` from the
   install response (`<base>/api/webhooks/sentry/t/<token>`). This
   URL is per-developer — don't share it.
4. **Permissions:** `Issue & Event: Read` is the minimum. Add
   `Issue & Event: Read & Write` if you want the agent to mark issues
   resolved when its PR merges (future feature).
5. **Webhooks:** subscribe to **Issues**. The flow specifically listens
   for `issue.created`.
6. **Save.** Copy the integration's **auth token** shown after
   creation.
7. Open `setupInstructions.vaultUrl` in your browser — it deeplinks to
   the Mur vault with the secret name (`SENTRY_AUTH_TOKEN`) already
   prefilled. Paste the token, save, and you're done.

## Step 3 — map your Sentry projects to GitHub repos

The webhook payload tells us which Sentry **project** an error came
from (e.g. `my-app-backend`); we need to know which **GitHub repo**
to clone. One Sentry project can map to one repo. You can map
multiple projects.

```bash
curl -X POST $MUR_API_BASE/api/flows/sentry-autofix/config \
  -H "Authorization: Bearer $MUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "repos": {
      "my-app-backend": "acme/api",
      "my-app-frontend": "acme/web"
    }
  }'
```

Replace the keys with your **Sentry project slugs** and the values
with the matching `owner/repo` on GitHub. Both sides are case-sensitive.

If you map a Sentry project but the Mur GitHub App isn't installed on
that repo (or doesn't have `pull_requests:write`), the handler will
log `no_installation_for_repo:<owner>/<repo>` and skip. Re-install
the App with the right permissions and re-fire the issue from Sentry
to retry.

## Step 4 — trigger a test error

Pick a repo you mapped. Add the Sentry SDK if it's not already there:

```bash
npm install @sentry/node
```

```js
import * as Sentry from '@sentry/node';
Sentry.init({ dsn: 'https://your-dsn@sentry.io/...' });

// Anywhere in your code. The Date.now() suffix is intentional —
// Sentry groups by stack-trace fingerprint, so replaying the same
// error won't fire `issue.created` again. Always make the message
// unique to land a NEW Sentry issue:
throw new Error('mur autofix smoke test ' + Date.now());
```

Run the app, trigger the error, watch Sentry capture it. Within a
minute, Sentry sends an `issue.created` webhook to Mur. The agent
typically takes 2–8 minutes for a real fix, longer for harder bugs.

You'll see a PR appear on the mapped repo, authored by `mur[bot]`,
with a body that links the Sentry issue.

## Pricing

Customer-facing: **$1.00 per PR opened**. No charge if the agent
gives up without opening a PR. No charge on duplicate webhook
deliveries (we dedupe by Sentry issue id).

Direct invocations of the published Lit Action (rare — most callers
are the webhook handler) pay cost-recovery rates set per phase via
`paymentScheme: 'upto'`:

| Action | Cost |
|---|---|
| `autofix` (session create + events POST) | $0.05 |
| `status` (one Anthropic poll) | $0.001 |
| `result` (poll + transcript parse) | $0.001 |

## What the agent has access to

Inside the TEE sandbox the agent gets:

- A short-lived GitHub installation token (~1h TTL) embedded in the
  clone URL. Scoped to **only** the repo this Sentry issue maps to.
  Cannot touch your other repos even if the App grants more.
- The Sentry issue brief: title, culprit, top stack frame, permalink.
  No Sentry API access yet — the agent works from the webhook
  payload alone. (Adding API access via OAuth integration is a
  near-term follow-up that unlocks "fix the whole backlog" flows.)
- Bash, Node.js, git, and outbound network in the managed-agent
  sandbox. Standard Anthropic managed-agent runtime.

It does NOT get:

- Your other repos (App scope is repo-narrowed by the mapping)
- Any other GitHub tokens, environment variables, or secrets
- The ability to merge — only opens PRs, you review and merge

## Marker lifecycle

Each Sentry issue gets one row in FlowState. Status transitions:

| Status | Meaning | Terminal? |
|---|---|---|
| `claimed` | Run is in flight | no — stuck rows clear via ops sweep |
| `pr_opened` | Agent shipped a PR | yes |
| `completed_no_pr` | Agent gave up cleanly, refund issued | yes |
| `abandoned` | Agent timed out or had a poll error mid-run; the managed-agent session may still be running. `sessionId` persisted for a future poll worker. Refund issued. | yes |

A duplicate webhook delivery for the same Sentry issue short-circuits
on a terminal marker. The dispatcher's atomic-claim primitive
(`tryCreateFlowState`) prevents two concurrent deliveries from both
spawning agents.

## Operator notes (self-hosting)

If you're running your own Mur deployment, you need:

| Env var | What it is |
|---|---|
| `SENTRY_AUTOFIX_FLOW_ID` | The published Flow.id of `examples/sentry-autofix/sentry-autofix.js`. Pin after running `prod-e2e --flow sentry-autofix` once. |

The Lit Action's publisher vault also needs:

| Vault key | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Auth for the managed-agents API |
| `MANAGED_AGENT_ID` | Anthropic managed-agent definition with Bash + git + Node tools |
| `MANAGED_ENV_ID` | Sandbox environment with unrestricted networking |

## Revoking access

Two ways to stop the flow from firing on a project:

```bash
# Disable for a project (keeps the repo map in case you re-enable):
curl -X POST $MUR_API_BASE/api/flows/uninstall \
  -H "Authorization: Bearer $MUR_API_KEY" \
  -d '{ "slug": "sentry-autofix" }'

# Or clear all Sentry-project mappings (replaces the whole map —
# this is PUT semantics, so to drop just one project, re-POST with
# the others still listed):
curl -X POST $MUR_API_BASE/api/flows/sentry-autofix/config \
  -H "Authorization: Bearer $MUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "repos": {} }'
```

Either way: any in-flight agent session keeps running on Anthropic's
side until it terminates naturally — the platform stops processing
**new** webhooks for the disabled project.

## Architecture

The actual implementation:

- **Webhook ingest:** `src/api/routes/webhook.routes.ts` (per-dev
  URL token attribution, ingest into `WebhookEvent`)
- **Handler:** `src/services/webhooks/sentry.handler.ts` (gate, claim,
  debit, spawn, marker lifecycle)
- **Coding-agent orchestrator:** `src/services/codingAgent.service.ts`
  (three-phase invoke of the published Lit Action, version-pinned)
- **Lit Action:** `examples/sentry-autofix/sentry-autofix.js` (runs in
  TEE, calls Anthropic managed-agents API)

The Lit Action is published with `paymentScheme: 'upto'` and pricing
that's pure cost-recovery. The customer-visible $1/PR price is
debited at the cofounder webhook handler layer, so refunds and
"no charge on dedup" semantics live in one place.
