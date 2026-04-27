// Gmail Read — lists emails from one hardcoded Gmail label.
//
// Required connection: Gmail (caller connects via OAuth on the platform)
//
// Input:
// - params.maxResults (optional number, defaults to 10, clamped to 1-20)
//
// Output:
// - { emails: [{ id, threadId, from, subject, snippet, internalDate }] }

const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_CAP = 20;
const FETCH_TIMEOUT_MS = 10_000;

// Access token + config injected by the platform via Composio OAuth connection.
// The caller must have connected Gmail and configured an allowed label.
const gmail = params.connections?.gmail;
if (!gmail?.accessToken) {
  return {
    error: 'MISSING_CONNECTION',
    detail: 'Gmail connection required — connect Gmail at /dashboard/integrations',
  };
}

const accessToken = gmail.accessToken;
const ALLOWED_LABEL_ID = gmail.config?.allowedLabelId;
if (!ALLOWED_LABEL_ID) {
  return {
    error: 'MISSING_CONFIG',
    detail: 'No label configured — set an allowed label in your Gmail connection settings',
  };
}

function getTimeoutSignal() {
  return AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

function coerceMaxResults(value) {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_MAX_RESULTS;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_RESULTS;
  }

  return Math.min(MAX_RESULTS_CAP, Math.max(1, Math.floor(parsed)));
}

function sanitizeHeaderValue(value) {
  if (typeof value !== 'string') {
    return null;
  }

  return value.replace(/[\r\n]+/g, ' ').trim();
}

function getHeader(headers, name) {
  const expectedName = name.toLowerCase();
  for (const header of Array.isArray(headers) ? headers : []) {
    if (typeof header?.name === 'string' && header.name.toLowerCase() === expectedName) {
      return sanitizeHeaderValue(header.value);
    }
  }
  return null;
}

async function readResponseDetail(response) {
  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json();
      const message = data?.error?.message || data?.error_description;
      if (typeof message === 'string' && message) {
        return message;
      }
      return JSON.stringify(data).slice(0, 500);
    }

    const text = await response.text();
    return text.slice(0, 500) || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function mapGmailErrorCode(status) {
  if (status === 401) {
    return 'GMAIL_AUTH_FAILED';
  }
  if (status === 429) {
    return 'GMAIL_RATE_LIMITED';
  }
  if (status >= 500) {
    return 'GMAIL_SERVER_ERROR';
  }
  return 'GMAIL_API_ERROR';
}

async function gmailJsonRequest(url) {
  let response;

  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: getTimeoutSignal(),
    });
  } catch (error) {
    return {
      error: 'GMAIL_API_ERROR',
      detail: error?.message || `Gmail request failed after ${FETCH_TIMEOUT_MS}ms`,
    };
  }

  if (!response.ok) {
    return {
      error: mapGmailErrorCode(response.status),
      detail: await readResponseDetail(response),
    };
  }

  try {
    return { data: await response.json() };
  } catch {
    return {
      error: 'GMAIL_API_ERROR',
      detail: 'Gmail API response was not valid JSON',
    };
  }
}

async function fetchMessageMetadata(messageId) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set('format', 'metadata');
  url.searchParams.append('metadataHeaders', 'From');
  url.searchParams.append('metadataHeaders', 'Subject');

  const result = await gmailJsonRequest(url.toString());
  if (result.error) {
    return result;
  }

  const message = result.data;
  const headers = message?.payload?.headers;
  return {
    email: {
      id: message?.id ?? messageId,
      threadId: message?.threadId ?? null,
      from: getHeader(headers, 'From'),
      subject: getHeader(headers, 'Subject'),
      snippet: typeof message?.snippet === 'string' ? message.snippet : '',
      internalDate: message?.internalDate ?? null,
    },
  };
}

const maxResults = coerceMaxResults(params.maxResults);
const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
listUrl.searchParams.set('labelIds', ALLOWED_LABEL_ID);
listUrl.searchParams.set('maxResults', String(maxResults));

const listResult = await gmailJsonRequest(listUrl.toString());
if (listResult.error) {
  return listResult;
}

const messages = Array.isArray(listResult.data?.messages) ? listResult.data.messages : [];
const messageIds = messages
  .map((message) => (typeof message?.id === 'string' ? message.id : ''))
  .filter(Boolean);

if (messageIds.length === 0) {
  return { emails: [] };
}

const metadataResults = await Promise.all(
  messageIds.map((id) => fetchMessageMetadata(id)),
);

for (const result of metadataResults) {
  if (result?.error) {
    return result;
  }
}

return {
  emails: metadataResults.map((result) => result.email),
};
