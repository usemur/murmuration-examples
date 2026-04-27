# twenty-deployer

Deploys [Twenty CRM](https://twenty.com) to **your** Railway account using
**your** Railway API token stored in the Murmuration vault. Uses Twenty's official
Railway template ([railway.com/deploy/nAL3hA](https://railway.com/deploy/nAL3hA)). Intentionally minimal —
this is the reference example for a **user-secret** flow (first flow in the
repo to declare `manifest.userSecrets`).

After invoke, you get a Railway project + a generated `*.up.railway.app` URL
to open Twenty in your browser. **First-login just works** — the flow
generates a cryptographically random `APP_SECRET` inside the TEE and sets it
on the Twenty service for you, so there's no manual env-var setup required.
Railway's build typically finishes 5–10 minutes later; the URL comes online
once Twenty's server service finishes building.

## Who owns what

| Artifact | Owner | Where it lives |
|---|---|---|
| Flow source (IPFS CID) | Publisher (whoever published this flow) | Public, auditable IPFS |
| `RAILWAY_API_KEY` plaintext | You (the consumer) | Never leaves your machine or the TEE |
| `RAILWAY_API_KEY` ciphertext | You | Murmuration vault, encrypted with your own PKP |
| Railway project that gets created | You | Your Railway account |

The Murmuration platform never sees your token plaintext. The TEE verifies the
flow's CID before Lit releases the decryption share, so the only code that
can ever read your token is the exact flow source the publisher registered.

## What you need

1. **A Railway API token.** Generate one at
   https://railway.com/account/tokens. Needs permission to create projects
   and deploy templates. Any Railway account works — personal or team.
2. **A Murmuration consumer API key** (dashboard → developer settings).
3. **The flow's `flowVersionId`** — opened a grant is version-pinned in
   Murmuration, so you bind to a specific published version. Fetch it with:

   ```bash
   curl -s https://usemur.dev/api/flows/public/twenty-deployer \
     | jq -r '.versions[0].id'
   ```

## Manual end-to-end (curl)

```bash
export MUR_API_KEY="mur_..."              # your consumer key
export RAILWAY_TOKEN="rlw_..."               # your Railway token

# 1. Find the current flowVersionId.
export FLOW_VERSION_ID=$(curl -s \
  https://usemur.dev/api/flows/public/twenty-deployer \
  | jq -r '.versions[0].id')
echo "flowVersionId=$FLOW_VERSION_ID"

# 2. Deposit your Railway token into your vault.
export SECRET_ID=$(curl -s -X POST https://usemur.dev/api/vault/secrets \
  -H "Authorization: Bearer $MUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "RAILWAY_API_KEY",
    "type": "railway_api_key",
    "plaintext": "'"$RAILWAY_TOKEN"'"
  }' | jq -r .id)
echo "secretId=$SECRET_ID"

# 3. Grant the flow version access to your secret.
export GRANT_ID=$(curl -s -X POST \
  "https://usemur.dev/api/flows/$FLOW_VERSION_ID/grants" \
  -H "Authorization: Bearer $MUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "bindings": { "RAILWAY_API_KEY": "'"$SECRET_ID"'" }
  }' | jq -r .grantId)
echo "grantId=$GRANT_ID"

# 4. Invoke. The TEE decrypts your token inside a sealed enclave, calls
#    Railway's templateDeploy, queries the new project for service domains,
#    and returns the URL you'll open in your browser once the build finishes.
curl -X POST https://usemur.dev/api/flows/twenty-deployer/invoke \
  -H "Authorization: Bearer $MUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "grantId": "'"$GRANT_ID"'",
    "params": { "projectName": "my-crm" }
  }'
```

### What you get back

```json
{
  "projectId": "9b4…",
  "workflowId": "wf_…",
  "dashboardUrl": "https://railway.com/project/9b4…",
  "twentyUrl": "https://twenty-production-abcd.up.railway.app",
  "services": [
    { "id": "svc_1", "name": "twenty",   "domains": ["https://twenty-production-abcd.up.railway.app"] },
    { "id": "svc_2", "name": "postgres", "domains": [] },
    { "id": "svc_3", "name": "worker",   "domains": [] }
  ],
  "appSecretSet": true,
  "message": "Twenty is building. Once Railway finishes (~5–10 min), open twentyUrl in your browser. APP_SECRET has been set for you — no manual config needed to log in."
}
```

`twentyUrl` is the URL to open in your browser. It's assigned immediately but
won't respond until Railway finishes building the server service.
`appSecretSet: true` means the flow already wrote a random 32-byte
`APP_SECRET` onto the Twenty service; if it's `false`, the response also
includes `appSecretError` with the reason.

### What's already configured for you

| Thing | Who set it | Source |
|---|---|---|
| Postgres database | Railway template | Provisioned service, DATABASE_URL wired via service reference |
| Worker service | Railway template | Background jobs |
| Volume for file storage | Railway template | Local storage on the Twenty service, durable across restarts |
| `STORAGE_TYPE=local` | Railway template | Default; Twenty writes user uploads to the mounted volume |
| `APP_SECRET` | **This flow** | 32 random bytes generated inside the TEE via `crypto.getRandomValues`, set via Railway's `variableUpsert` mutation. Plaintext never leaves the TEE or Railway. |

You should be able to go straight from `twentyUrl` → Twenty's sign-up page.

### Optional: upgrade to Railway Object Storage

`STORAGE_TYPE=local` on a Railway Volume is fine for solo use and demos.
If you want durable object storage (multi-region replication, S3 API), open
the Twenty service → Storage in the Railway dashboard → attach a Storage
Bucket, then swap `STORAGE_TYPE=local` → `s3` and copy the generated
`RAILWAY_STORAGE_*` env vars into Twenty's S3 settings (`STORAGE_S3_ENDPOINT`
etc.). Left manual for now — Railway's Object Storage API is still beta and
the shape keeps changing.

## Automated end-to-end (the repo's e2e harness)

```bash
RAILWAY_API_KEY=rlw_... \
PROD_ADMIN_API_KEY=... \
PROD_CONSUMER_API_KEY=... \
npm run test:prod -- --flow=twenty-deployer
```

Under the hood this publishes (or re-publishes) the flow, deposits your
Railway token into the consumer's vault, opens a grant against the freshly
published `flowVersionId`, invokes with `grantId`, and prints the project ID
+ dashboard URL + Twenty URL.

## Revoking access

```bash
curl -X POST "https://usemur.dev/api/grants/$GRANT_ID/revoke" \
  -H "Authorization: Bearer $MUR_API_KEY"
```

Revocation drops this flow's IPFS CID from your secret's Lit group. Any
future TEE execution that tries to decrypt your token fails at
`Lit.Actions.Decrypt` with "not authorized". Already-running projects on
your Railway account are untouched — revoke only blocks **future** deploys.

## Shape

Input

| Field | Type | Required | Notes |
|---|---|---|---|
| `projectName` | string | yes | Display name for the new Railway project (≤ 80 chars). |
| `teamId` | string | no | Railway team ID. Defaults to your personal workspace. |

Output (top-level)

| Field | Description |
|---|---|
| `projectId` | New Railway project ID. |
| `workflowId` | Railway workflow (build job) ID. |
| `dashboardUrl` | Direct link to the project in Railway's dashboard. |
| `twentyUrl` | Generated `*.up.railway.app` URL for the Twenty web service. `null` if Railway's shape has changed — fall back to `dashboardUrl`. |
| `services` | Every service in the project with its generated domains. |
| `appSecretSet` | `true` when the flow wrote `APP_SECRET` onto the Twenty service inside the TEE. `false` only if the post-deploy API calls failed; see `appSecretError`. |
| `appSecretError` | Present only when `appSecretSet` is `false`. |
| `message` | Human-readable next steps. |

## Why `manifest.userSecrets`

Publisher-secret flows (`lob-postcard`, `identity-verify`, etc.) share one
vendor API key across every caller — the flow owner puts it in the flow's
own vault. That's fine for "fetch public data" style APIs. It doesn't work
for deploying into **your** Railway account.

`twenty-deployer` declares:

```js
export const manifest = {
  userSecrets: [
    {
      name: 'RAILWAY_API_KEY',
      type: 'railway_api_key',
      purpose: 'Deploy Twenty CRM into your Railway account',
      required: true,
    },
  ],
};
```

At publish time `parseManifestSecrets` reads this AST and upserts a
`FlowSecretRequirement` row. Consent UIs discover required secrets via:

```
GET /api/flows/:flowVersionId/secret-requirements   (no auth)
```

## Scope-narrowing (next step)

A raw Railway token can deploy anything, delete projects, rotate
environments, etc. The ideal next step is a **capability-narrowing wrapper**:
another flow that takes the raw `RAILWAY_API_KEY` user-secret and exposes
**only** a `deploy_twenty_only` capability with the template code hard-coded
and the other GraphQL mutations refused. Consumers grant the narrow wrapper
access instead of this flow, and the wrapper's CID is the only one allowed
in their secret's Lit group. That's how `twenty-deployer` stops being "a
blank token with training wheels" and becomes a bounded, auditable
capability.
