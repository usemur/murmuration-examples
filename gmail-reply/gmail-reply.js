// Gmail Reply — replies to a single message, but only when the original
// message carries the hardcoded allowed Gmail label.
//
// Required connection: Gmail (caller connects via OAuth on the platform)
//
// Input:
// - params.messageId (string, required)
// - params.replyBody (string, required, plain text only, max 5000 chars)
//
// Output:
// - { sent: true, replyMessageId }

const MAX_REPLY_BODY_LENGTH = 5000;
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

function sanitizeHeaderValue(value) {
  if (typeof value !== 'string') {
    return '';
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
  return '';
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

function mapGmailErrorCode(status, options = {}) {
  if (status === 404 && options.notFoundCode) {
    return options.notFoundCode;
  }
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

async function gmailJsonRequest(url, init = {}, options = {}) {
  let response;

  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.headers || {}),
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
      error: mapGmailErrorCode(response.status, options),
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

function buildReferencesHeader(existingReferences, messageIdHeader) {
  const cleanReferences = sanitizeHeaderValue(existingReferences);
  if (!cleanReferences) {
    return messageIdHeader;
  }
  if (cleanReferences.includes(messageIdHeader)) {
    return cleanReferences;
  }
  return `${cleanReferences} ${messageIdHeader}`;
}

function encodeMimeMessage(mimeMessage) {
  try {
    // `unescape` is deprecated, but this UTF-8 bridge keeps `btoa` compatible
    // in the Lit Action runtime where Buffer is not available.
    return btoa(unescape(encodeURIComponent(mimeMessage)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch {
    return null;
  }
}

const messageId = typeof params.messageId === 'string' ? params.messageId.trim() : '';
if (!messageId) {
  return {
    error: 'INVALID_INPUT',
    detail: 'messageId is required',
  };
}

const replyBody = typeof params.replyBody === 'string' ? params.replyBody : '';
if (!replyBody.trim()) {
  return {
    error: 'CONTENT_BLOCKED',
    detail: 'replyBody must not be empty',
  };
}

if (replyBody.length > MAX_REPLY_BODY_LENGTH) {
  return {
    error: 'CONTENT_BLOCKED',
    detail: `replyBody exceeds ${MAX_REPLY_BODY_LENGTH} characters`,
  };
}

const messageUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
messageUrl.searchParams.set('format', 'metadata');
messageUrl.searchParams.append('metadataHeaders', 'From');
messageUrl.searchParams.append('metadataHeaders', 'Subject');
messageUrl.searchParams.append('metadataHeaders', 'Message-ID');
messageUrl.searchParams.append('metadataHeaders', 'References');

const originalMessageResult = await gmailJsonRequest(
  messageUrl.toString(),
  {},
  { notFoundCode: 'MESSAGE_NOT_FOUND' },
);
if (originalMessageResult.error) {
  return originalMessageResult;
}

const originalMessage = originalMessageResult.data;
const labelIds = Array.isArray(originalMessage?.labelIds) ? originalMessage.labelIds : [];
if (!labelIds.includes(ALLOWED_LABEL_ID)) {
  return {
    error: 'SCOPE_VIOLATION',
    detail: 'Message not in allowed label scope',
  };
}

const headers = originalMessage?.payload?.headers;
const originalFrom = getHeader(headers, 'From');
if (!originalFrom) {
  return {
    error: 'MISSING_FROM_HEADER',
    detail: 'Original message is missing a From header',
  };
}

const originalSubject = getHeader(headers, 'Subject');
const originalMessageIdHeader = getHeader(headers, 'Message-ID');
if (!originalMessageIdHeader) {
  return {
    error: 'MISSING_MESSAGE_ID_HEADER',
    detail: 'Original message is missing a Message-ID header',
  };
}

const profileResult = await gmailJsonRequest('https://gmail.googleapis.com/gmail/v1/users/me/profile');
if (profileResult.error) {
  return profileResult;
}

const fromEmail = sanitizeHeaderValue(profileResult.data?.emailAddress);
if (!fromEmail) {
  return {
    error: 'GMAIL_API_ERROR',
    detail: 'Authenticated Gmail profile did not include emailAddress',
  };
}

const replySubject = /^re:/i.test(originalSubject)
  ? originalSubject
  : originalSubject
    ? `Re: ${originalSubject}`
    : 'Re:';

const referencesHeader = buildReferencesHeader(
  getHeader(headers, 'References'),
  originalMessageIdHeader,
);

const normalizedReplyBody = replyBody.replace(/\r?\n/g, '\r\n');
const mimeMessage = [
  `From: ${fromEmail}`,
  `To: ${originalFrom}`,
  `Subject: ${replySubject}`,
  `In-Reply-To: ${originalMessageIdHeader}`,
  `References: ${referencesHeader}`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  normalizedReplyBody,
].join('\r\n');

const raw = encodeMimeMessage(mimeMessage);
if (!raw) {
  return {
    error: 'MIME_ENCODING_FAILED',
    detail: 'Failed to encode reply MIME message',
  };
}

const sendPayload = { raw };
if (typeof originalMessage?.threadId === 'string' && originalMessage.threadId) {
  sendPayload.threadId = originalMessage.threadId;
}

const sendResult = await gmailJsonRequest(
  'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(sendPayload),
  },
);
if (sendResult.error) {
  return sendResult;
}

return {
  sent: true,
  replyMessageId: sendResult.data?.id ?? null,
};
