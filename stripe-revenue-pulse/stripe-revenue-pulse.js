// Stripe Revenue Pulse — daily revenue + new-customer summary.
//
// What this flow does (publisher reference shape):
//   1. Pulls yesterday's charges, new customers, active subs, and
//      sub-deletion events from the caller's Stripe account.
//   2. Computes yesterday's revenue, gross MRR snapshot, and churn.
//   3. For each new customer with a corporate email domain, fetches
//      the homepage and extracts a one-line "what does this company do"
//      summary from <title> + meta description.
//   4. Returns a single structured payload the caller can render.
//
// Required connection: Stripe (caller connects via Composio OAuth).
// Read-only — never writes to Stripe.
//
// Input (all optional):
//   params.input.tz                    IANA TZ string. Default 'UTC'.
//   params.input.muteDomains           string[] — domains to skip enrichment for.
//   params.input.customerResearchEnabled  boolean — default true.
//
// Output:
//   {
//     window:        { yesterdayStartSec, yesterdayEndSec },
//     revenue:       { totalCents, chargeCount, foreignCurrencyCount },
//     mrrSnapshot:   { mrrCents, trialingCount, pausedCount },
//     churn:         { count, lostMrrCents },
//     failedCharges: { count, atRiskCents },
//     newCustomers:  Array<{ email, summary?, unreachable?, freeEmail?, muted? }>,
//   }
//
// PII boundary: only normalized email DOMAIN ever reaches an external
// fetch. Local-parts, full emails, and customer names never leave the
// flow's compute boundary.

const STRIPE_API = 'https://api.stripe.com';
const STRIPE_VERSION = '2024-04-10';
const STRIPE_PAGE_LIMIT = 100;
const MAX_PAGES = 5;
const DEFAULT_CURRENCY = 'usd';
const ENRICHMENT_TIMEOUT_MS = 8000;
const MAX_SUMMARY_CHARS = 120;

const FREE_EMAIL_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'proton.me', 'protonmail.com', 'pm.me',
  'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'me.com', 'mac.com',
  'yahoo.com', 'ymail.com', 'rocketmail.com', 'fastmail.com', 'fastmail.fm',
  'tutanota.com', 'tuta.io', 'tutamail.com', 'zoho.com', 'zohomail.com',
  'aol.com', 'hey.com', 'duck.com', 'gmx.com', 'mail.com',
]);

// ---------- 1. Resolve token + window ---------------------------------------

const stripe = params.connections?.stripe;
if (!stripe?.accessToken) {
  return { error: 'MISSING_CONNECTION', detail: 'Stripe connection required.' };
}
const stripeBearer = stripe.accessToken;

const tz = params.input?.tz ?? 'UTC';
const muteSet = new Set((params.input?.muteDomains ?? []).map((d) => String(d).toLowerCase()));
const customerResearchEnabled = params.input?.customerResearchEnabled !== false;

const window = computeYesterdayWindow(new Date(), tz);

// ---------- 2. Stripe fetches (parallel) ------------------------------------

const [charges, customers, activeSubs, deletedSubEvents] = await Promise.all([
  paginateStripe(`/v1/charges?limit=${STRIPE_PAGE_LIMIT}&created[gte]=${window.yesterdayStartSec}`),
  paginateStripe(`/v1/customers?limit=${STRIPE_PAGE_LIMIT}&created[gte]=${window.yesterdayStartSec}`),
  paginateStripe(`/v1/subscriptions?limit=${STRIPE_PAGE_LIMIT}&status=active`),
  paginateStripe(`/v1/events?limit=${STRIPE_PAGE_LIMIT}&type=customer.subscription.deleted&created[gte]=${window.yesterdayStartSec}`),
]);

// ---------- 3. Pure compute -------------------------------------------------

const newCustomers = customers.filter(
  (c) => c.created >= window.yesterdayStartSec && c.created < window.yesterdayEndSec,
);

const revenue = computeRevenue(charges, window, DEFAULT_CURRENCY, 'succeeded');
const failedCharges = computeRevenue(charges, window, DEFAULT_CURRENCY, 'failed');
const mrrSnapshot = computeMrrSnapshot(activeSubs, DEFAULT_CURRENCY);
const churn = computeChurn(deletedSubEvents, window);

// ---------- 4. Enrichment (corporate-domain only, parallel) -----------------

const enrichmentMap = customerResearchEnabled
  ? await enrichDomainsFromCustomers(newCustomers, muteSet)
  : new Map();

const enrichedCustomers = newCustomers.map((c) => {
  const email = c.email ?? null;
  const domain = domainFromEmail(email);
  const out = { email };
  if (!domain) return out;
  if (FREE_EMAIL_PROVIDERS.has(domain)) {
    out.freeEmail = true;
    return out;
  }
  if (muteSet.has(domain)) {
    out.muted = true;
    return out;
  }
  const enrichment = enrichmentMap.get(domain);
  if (!enrichment) return out;
  if (enrichment.summary) out.summary = enrichment.summary;
  if (enrichment.unreachable) out.unreachable = true;
  return out;
});

return {
  window: {
    yesterdayStartSec: window.yesterdayStartSec,
    yesterdayEndSec: window.yesterdayEndSec,
  },
  revenue: {
    totalCents: Number(revenue.totalCents),
    chargeCount: revenue.count,
    foreignCurrencyCount: revenue.foreignCurrencyCount,
  },
  mrrSnapshot: {
    mrrCents: Number(mrrSnapshot.mrrCents),
    trialingCount: mrrSnapshot.trialingCount,
    pausedCount: mrrSnapshot.pausedCount,
    foreignCurrencyCount: mrrSnapshot.foreignCurrencyCount,
  },
  churn: {
    count: churn.count,
    lostMrrCents: Number(churn.lostMrrCents),
  },
  failedCharges: {
    count: failedCharges.count,
    atRiskCents: Number(failedCharges.totalCents),
  },
  newCustomers: enrichedCustomers,
};

// ============================================================
// Helpers (defined as functions on the same scope; the platform
// wraps the file body in `async function main(params)`).
// ============================================================

async function paginateStripe(basePath) {
  const all = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const url = cursor === null
      ? `${STRIPE_API}${basePath}`
      : `${STRIPE_API}${basePath}${sep}starting_after=${encodeURIComponent(cursor)}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${stripeBearer}`,
        'Accept': 'application/json',
        'Stripe-Version': STRIPE_VERSION,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Stripe ${res.status} on ${basePath}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const data = Array.isArray(json.data) ? json.data : [];
    all.push(...data);
    if (!json.has_more || data.length === 0) break;
    cursor = data[data.length - 1]?.id;
    if (!cursor) break;
  }
  return all;
}

function computeYesterdayWindow(now, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')?.value);
  const m = Number(parts.find((p) => p.type === 'month')?.value);
  const d = Number(parts.find((p) => p.type === 'day')?.value);

  const guessUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0);
  const tzParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(guessUtcMs));
  const tzY = Number(tzParts.find((p) => p.type === 'year')?.value);
  const tzM = Number(tzParts.find((p) => p.type === 'month')?.value);
  const tzD = Number(tzParts.find((p) => p.type === 'day')?.value);
  const tzH = Number(tzParts.find((p) => p.type === 'hour')?.value);
  const tzMin = Number(tzParts.find((p) => p.type === 'minute')?.value);
  const tzAsUtcMs = Date.UTC(tzY, tzM - 1, tzD, tzH === 24 ? 0 : tzH, tzMin, 0);
  const offsetMs = tzAsUtcMs - guessUtcMs;
  const todayStartSec = Math.floor((guessUtcMs - offsetMs) / 1000);
  return {
    yesterdayStartSec: todayStartSec - 86400,
    yesterdayEndSec: todayStartSec,
  };
}

function computeRevenue(charges, window, defaultCurrency, status) {
  let totalCents = 0n;
  let count = 0;
  let foreignCurrencyCount = 0;
  const dc = defaultCurrency.toLowerCase();
  for (const c of charges) {
    if (c.status !== status) continue;
    if (c.created < window.yesterdayStartSec || c.created >= window.yesterdayEndSec) continue;
    count++;
    if ((c.currency ?? dc).toLowerCase() === dc) {
      totalCents += BigInt(c.amount);
    } else {
      foreignCurrencyCount++;
    }
  }
  return { totalCents, count, foreignCurrencyCount };
}

function computeMrrSnapshot(subs, defaultCurrency) {
  const perMonthMultiplier = { day: 30, week: 4.345, month: 1, year: 1 / 12 };
  const dc = defaultCurrency.toLowerCase();
  let mrrCents = 0n;
  let trialingCount = 0;
  let pausedCount = 0;
  let foreignCurrencyCount = 0;
  for (const sub of subs) {
    if (sub.status === 'trialing') { trialingCount++; continue; }
    if (sub.status !== 'active') continue;
    if (sub.pause_collection) { pausedCount++; continue; }
    if ((sub.currency ?? dc).toLowerCase() !== dc) { foreignCurrencyCount++; continue; }
    for (const it of sub.items?.data ?? []) {
      const amount = it.price?.unit_amount;
      if (typeof amount !== 'number' || amount <= 0) continue;
      const interval = it.price?.recurring?.interval;
      if (!interval) continue;
      const intervalCount = Math.max(it.price?.recurring?.interval_count ?? 1, 1);
      const qty = Math.max(it.quantity ?? 1, 1);
      const perMonth = (amount * (perMonthMultiplier[interval] ?? 0)) / intervalCount;
      mrrCents += BigInt(Math.round(perMonth * qty));
    }
  }
  return { mrrCents, trialingCount, pausedCount, foreignCurrencyCount };
}

function computeChurn(deletedEvents, window) {
  let count = 0;
  let lostMrrCents = 0n;
  for (const e of deletedEvents) {
    if (e.created < window.yesterdayStartSec || e.created >= window.yesterdayEndSec) continue;
    count++;
    const items = e.data?.object?.items?.data ?? [];
    const perMonthMultiplier = { day: 30, week: 4.345, month: 1, year: 1 / 12 };
    for (const it of items) {
      const amount = it.price?.unit_amount;
      const interval = it.price?.recurring?.interval;
      if (!amount || !interval) continue;
      const intervalCount = Math.max(it.price?.recurring?.interval_count ?? 1, 1);
      const qty = Math.max(it.quantity ?? 1, 1);
      const perMonth = (amount * (perMonthMultiplier[interval] ?? 0)) / intervalCount;
      lostMrrCents += BigInt(Math.round(perMonth * qty));
    }
  }
  return { count, lostMrrCents };
}

function domainFromEmail(email) {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || !domain.includes('.') || domain.includes(' ')) return null;
  return domain;
}

async function enrichDomainsFromCustomers(customers, muteSet) {
  const seen = new Set();
  const targets = [];
  for (const c of customers) {
    const d = domainFromEmail(c.email ?? null);
    if (!d) continue;
    if (seen.has(d)) continue;
    seen.add(d);
    if (FREE_EMAIL_PROVIDERS.has(d)) continue;
    if (muteSet.has(d)) continue;
    targets.push(d);
  }
  const results = await Promise.all(targets.map((d) => enrichOneDomain(d)));
  const map = new Map();
  for (const r of results) map.set(r.domain, r);
  return map;
}

async function enrichOneDomain(domain) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ENRICHMENT_TIMEOUT_MS);
  try {
    const res = await fetch(`https://${domain}`, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'StripeRevenuePulse/1.0',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) {
      return { domain, summary: null, unreachable: res.status >= 500 || res.status === 404 };
    }
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('text/html')) {
      return { domain, summary: null, unreachable: false };
    }
    const html = (await res.text()).slice(0, 100_000);
    return { domain, summary: summarizeHtml(html), unreachable: false };
  } catch {
    return { domain, summary: null, unreachable: true };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeHtml(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? collapseAndDecode(titleMatch[1]) : null;
  const descMatch =
    html.match(/<meta[^>]+name=["']description["'][^>]*?content=["']([^"']{0,500})["']/i) ??
    html.match(/<meta[^>]+property=["']og:description["'][^>]*?content=["']([^"']{0,500})["']/i);
  const desc = descMatch ? collapseAndDecode(descMatch[1]) : null;
  if (!title && !desc) return null;
  let combined;
  if (title && desc && !desc.toLowerCase().startsWith(title.toLowerCase())) {
    combined = `${title} — ${desc}`;
  } else {
    combined = desc ?? title;
  }
  if (combined.length <= MAX_SUMMARY_CHARS) return combined;
  return combined.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd() + '…';
}

function collapseAndDecode(s) {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}
