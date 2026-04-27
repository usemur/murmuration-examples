// Twenty Deployer — deploys Twenty CRM (https://twenty.com) to the caller's
// Railway account using their Railway API token from the Murmuration vault.
//
// First flow in the repo to declare a `manifest` with `userSecrets`.
// The caller (or their agent) grants this flow access to a vault-stored
// RAILWAY_API_KEY; at runtime the TEE auto-decrypts it into
// `params.secrets.RAILWAY_API_KEY` just like a publisher secret.
//
// What this flow automates so the user doesn't have to:
//   1. Provisions Twenty's Railway template (postgres + server + worker + volume)
//   2. Renames the Railway project to `projectName`
//   3. Generates a cryptographically random APP_SECRET inside the TEE and
//      sets it as an env var on the Twenty server service so first-login works
//   4. Returns the generated *.up.railway.app URL to open Twenty in a browser
//
// Input:
//   params.projectName (string, required) — display name for the new Railway project.
//   params.workspaceId (string, optional) — Railway workspace/team ID. Defaults to personal.
//
// Output: { projectId, workflowId, dashboardUrl, twentyUrl, services, appSecretSet, message }

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

// Twenty's official Railway template (see https://railway.com/deploy/nAL3hA).
// If Twenty's template moves, bump this constant; everything else is generic.
const TWENTY_TEMPLATE_CODE = 'nAL3hA';
const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

async function railwayGraphQL(apiKey, query, variables) {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) {
    throw new Error(
      `Railway API error (${res.status}): ${JSON.stringify(data.errors || data)}`,
    );
  }
  return data.data;
}

function hexRandom(byteLength) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function pickTwentyService(services) {
  // Prefer a service explicitly named "twenty" / "server", avoid postgres/redis/worker.
  const notInfra = (name) => !/postgres|redis|worker|database|pgbouncer/i.test(name || '');
  const explicit = services.find((s) => /twenty|server/i.test(s.name || '') && notInfra(s.name));
  if (explicit) return explicit;
  // Otherwise: first service that has a public domain and isn't obviously infra.
  return services.find((s) => notInfra(s.name) && s.domains.length > 0) || null;
}

const apiKey = params.secrets && params.secrets.RAILWAY_API_KEY;
if (!apiKey) {
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: 'Missing RAILWAY_API_KEY. Grant this flow access to your Railway token via POST /api/flows/<flowVersionId>/grants.',
    }),
  });
  throw new Error('Missing RAILWAY_API_KEY');
}

const projectName = params.projectName;
if (!projectName || typeof projectName !== 'string' || projectName.length > 80) {
  Lit.Actions.setResponse({
    response: JSON.stringify({
      error: 'projectName is required (string, ≤ 80 chars).',
    }),
  });
  throw new Error('Invalid projectName');
}

try {
  // 1a. Look up the template by code → get its id + serializedConfig. Railway's
  //     deploy API (templateDeployV2) wants both: the id identifies the template,
  //     the serializedConfig is the concrete service/volume/variable graph.
  const templateData = await railwayGraphQL(
    apiKey,
    `query Template($code: String!) {
      template(code: $code) {
        id
        serializedConfig
      }
    }`,
    { code: TWENTY_TEMPLATE_CODE },
  );
  const templateId = templateData.template && templateData.template.id;
  const rawConfig = templateData.template && templateData.template.serializedConfig;
  if (!templateId || !rawConfig) {
    throw new Error(`Could not resolve Railway template "${TWENTY_TEMPLATE_CODE}"`);
  }

  // Twenty's template declares a `Bucket` resource (Railway object storage,
  // S3-compatible) but doesn't pin a region. Railway then defaults to the
  // workspace's compute `preferredRegion` (e.g. `us-east4-eqdc4a`), which
  // is a *compute* region code and not a valid *bucket* region — the
  // deploy workflow Errors out with `Bucket region X is invalid` and
  // Twenty's STORAGE_S3_* vars end up empty, which crashes Twenty on first
  // upload (`Cannot read properties of undefined (reading 'send')`).
  //
  // Bucket regions are a separate, smaller taxonomy: `sjc | iad | ams |
  // sin`. We pin to `iad` (US-East, Virginia) — geographically central for
  // most users and the lowest-latency US option. Users who care about a
  // specific region can adjust later via the Railway dashboard.
  const serializedConfig = { ...rawConfig };
  if (serializedConfig.buckets) {
    serializedConfig.buckets = Object.fromEntries(
      Object.entries(serializedConfig.buckets).map(([id, b]) => [
        id,
        { ...b, region: 'iad' },
      ]),
    );
  }

  // 1b. Deploy the template. Railway creates the project + all services
  //     synchronously; the build runs async after.
  const deployData = await railwayGraphQL(
    apiKey,
    `mutation TemplateDeployV2($input: TemplateDeployV2Input!) {
      templateDeployV2(input: $input) {
        projectId
        workflowId
      }
    }`,
    {
      input: {
        templateId,
        serializedConfig,
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      },
    },
  );
  const { projectId, workflowId } = deployData.templateDeployV2 || {};
  if (!projectId) {
    throw new Error('Railway did not return a projectId');
  }

  // 2. Rename the project (best-effort).
  await railwayGraphQL(
    apiKey,
    `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
      projectUpdate(id: $id, input: $input) { id name }
    }`,
    { id: projectId, input: { name: projectName } },
  ).catch(() => null);

  // 3. Wait for Railway's template workflow to finish creating all services.
  //    Mutating services (variableUpsert, serviceDomainCreate) while the
  //    workflow is still running causes the remaining services never to be
  //    created, so we block on `workflowStatus` first.
  let workflowErr = null;
  if (workflowId) {
    const WORKFLOW_POLL_ATTEMPTS = 25;
    const WORKFLOW_POLL_DELAY_MS = 1000;
    for (let attempt = 0; attempt < WORKFLOW_POLL_ATTEMPTS; attempt++) {
      try {
        const wfData = await railwayGraphQL(
          apiKey,
          `query Workflow($id: String!) {
            workflowStatus(workflowId: $id) { status error }
          }`,
          { id: workflowId },
        );
        const status = (wfData.workflowStatus || {}).status;
        const error = (wfData.workflowStatus || {}).error;
        if (status === 'Complete') break;
        if (status === 'Error') {
          workflowErr = error || 'Workflow reported Error';
          break;
        }
      } catch (e) {
        workflowErr = e instanceof Error ? e.message : String(e);
      }
      if (attempt < WORKFLOW_POLL_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, WORKFLOW_POLL_DELAY_MS));
      }
    }
  }

  // 4. Query the project for services + environments.
  let services = [];
  let productionEnvironmentId = null;
  let queryErr = null;
  try {
    const projectData = await railwayGraphQL(
      apiKey,
      `query Project($id: String!) {
        project(id: $id) {
          environments { edges { node { id name } } }
          services { edges { node { id name } } }
        }
      }`,
      { id: projectId },
    );
    const envEdges = ((projectData.project || {}).environments || {}).edges || [];
    const prodEnv = envEdges.find((e) => (e.node.name || '').toLowerCase() === 'production') || envEdges[0];
    productionEnvironmentId = prodEnv ? prodEnv.node.id : null;

    const svcEdges = ((projectData.project || {}).services || {}).edges || [];
    services = svcEdges.map((edge) => ({
      id: edge.node.id,
      name: edge.node.name,
      domains: [],
    }));
  } catch (e) {
    queryErr = e instanceof Error ? e.message : String(e);
  }

  // 4. Generate APP_SECRET inside the TEE and set it on the Twenty service.
  //    Randomness comes from Web Crypto (`crypto.getRandomValues`) which is
  //    available in the Lit Action runtime. The plaintext never leaves the TEE
  //    — Railway receives it over TLS and stores it as an encrypted env var.
  //    STORAGE_S3_* vars are auto-populated from the `Bucket` resource
  //    (template variable references, e.g. `${{Bucket.ACCESS_KEY_ID}}`).
  const appSecret = hexRandom(32);
  const twentyService = pickTwentyService(services);
  let appSecretSet = false;
  let appSecretErr = null;

  if (twentyService && productionEnvironmentId) {
    try {
      await railwayGraphQL(
        apiKey,
        `mutation VariableUpsert($input: VariableUpsertInput!) {
          variableUpsert(input: $input)
        }`,
        {
          input: {
            projectId,
            environmentId: productionEnvironmentId,
            serviceId: twentyService.id,
            name: 'APP_SECRET',
            value: appSecret,
          },
        },
      );
      appSecretSet = true;
    } catch (e) {
      appSecretErr = e instanceof Error ? e.message : String(e);
    }
  } else {
    appSecretErr = queryErr || 'Could not resolve Twenty service + production environment';
  }

  // 5. Create a public domain for the Twenty service. Twenty listens on 3000.
  //    The service instance doesn't exist the moment templateDeployV2 returns,
  //    so poll until it does (usually ≤5s after services appear).
  let twentyUrl = null;
  let domainErr = null;
  if (twentyService && productionEnvironmentId) {
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        const domainData = await railwayGraphQL(
          apiKey,
          `mutation ServiceDomainCreate($input: ServiceDomainCreateInput!) {
            serviceDomainCreate(input: $input) { domain }
          }`,
          {
            input: {
              environmentId: productionEnvironmentId,
              serviceId: twentyService.id,
              targetPort: 3000,
            },
          },
        );
        const domain = domainData.serviceDomainCreate && domainData.serviceDomainCreate.domain;
        if (domain) {
          twentyUrl = `https://${domain}`;
          break;
        }
      } catch (e) {
        domainErr = e instanceof Error ? e.message : String(e);
        // "ServiceInstance not found" → workflow hasn't provisioned it yet, retry.
        if (!/ServiceInstance not found/i.test(domainErr)) break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const nextSteps = appSecretSet && twentyUrl
    ? `Twenty is building. Once Railway finishes (~5–10 min), open twentyUrl in your browser. APP_SECRET has been set for you — no manual config needed to log in.`
    : !twentyUrl
    ? `Twenty project created. Railway did not surface a public domain yet (${domainErr || 'still provisioning'}). Check the dashboard — a *.up.railway.app domain will appear on the Twenty service once the service instance is live.`
    : `Twenty is building. Open twentyUrl in ~5–10 min. APP_SECRET was NOT set automatically (${appSecretErr || 'unknown error'}); set it manually: \`openssl rand -hex 32\`.`;

  Lit.Actions.setResponse({
    response: JSON.stringify({
      projectId,
      workflowId,
      dashboardUrl: `https://railway.com/project/${projectId}`,
      twentyUrl,
      services,
      appSecretSet,
      ...(appSecretErr ? { appSecretError: appSecretErr } : {}),
      ...(domainErr && !twentyUrl ? { domainError: domainErr } : {}),
      ...(workflowErr ? { workflowError: workflowErr } : {}),
      message: nextSteps,
    }),
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: message }),
  });
  throw err;
}
