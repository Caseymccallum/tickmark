/**
 * QuickBooks Online, over `fetch`, with no package.
 *
 * The same bargain as `xero.js` and `stripe.js` beside it: the OAuth 2.0 flow and the REST calls are a
 * handful of `fetch`es and a JSON transform, so an operator can read the whole integration in one
 * sitting. No `intuit` npm package, and no SDK hiding what it sends.
 *
 * ## What is here
 *
 * - `authorizationUrl` / `exchangeCode` / `refreshTokens` — the token lifecycle against Intuit's
 *   OAuth 2.0 (`appcenter.intuit.com/connect/oauth2` → `oauth.platform.intuit.com/.../tokens/bearer`).
 * - `fetchQuickBooksClients` — the practice's client list: the Customers in the connected company,
 *   which is where a practice that bills its clients keeps their name and their email.
 * - `clientsToRows` — the transform into `{ name, email }` rows, so a QuickBooks import pours into the
 *   same ingestion pipeline a CSV and a Xero import do.
 *
 * ## The one QuickBooks wrinkle: `realmId`
 *
 * QuickBooks scopes everything to a *company* (a `realmId`), and Intuit hands that back on the
 * **callback** as a query parameter alongside the code — not in the token response. So the caller
 * captures `realmId` from the callback and keeps it beside the tokens; the client list is queried
 * against it. A practice that keeps every client in one QuickBooks company is one realm; one that
 * keeps a company per client is one realm each (the shape Xero calls an organisation).
 *
 * ## Name and email, in one query
 *
 * A Customer carries `DisplayName` (its name) and `PrimaryEmailAddr.Address` (its email) — so unlike
 * Xero's `connections`, QuickBooks brings a chase-ready name *and* address in one go. That is the
 * whole reason this source is worth having: the rows arrive ready to email.
 */

export const QB_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const QB_QUERY_URL = 'https://quickbooks.api.intuit.com/v2/company';
export const QB_QUERY_URL_SANDBOX = 'https://sandbox-quickbooks.api.intuit.com/v2/company';

/**
 * What an import asks for. `com.intuit.quickbooks.accounting` is the scope that lets a query read
 * Customers; the OpenID trio is identity. Read-only — a client-list import has no business writing to
 * anybody's books.
 */
export const QB_SCOPES = ['com.intuit.quickbooks.accounting', 'openid', 'email', 'profile'].join(' ');

export class QuickBooksError extends Error {
  constructor(message, { status = null, raw = null } = {}) {
    super(message);
    this.name = 'QuickBooksError';
    this.status = status;
    this.raw = raw;
  }
}

/** Configuration from the environment, or null when QuickBooks is not set up. */
export function quickBooksFromEnvironment(env = process.env) {
  const clientId = env.TICKMARK_QB_CLIENT_ID;
  const clientSecret = env.TICKMARK_QB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const base = (env.TICKMARK_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  return {
    clientId,
    clientSecret,
    // Where Intuit sends the browser back to. Derived from one base URL so the return path cannot
    // drift from the rest of the app, but overridable for a reverse proxy.
    redirectUri: env.TICKMARK_QB_REDIRECT_URI ?? `${base}/integrations/quickbooks/callback`,
  };
}

/**
 * The redirect that starts the OAuth dance.
 *
 * `state` is the CSRF guard, exactly as in the Xero flow: the callback refuses anything that cannot
 * present the cookie this browser set on its way out.
 */
export function authorizationUrl({ config, state, scopes = QB_SCOPES }) {
  const url = new URL(QB_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('state', state);
  return url.toString();
}

/** POST to Intuit's token endpoint and hand back the JSON, or throw this module's own words. */
async function tokenRequest(config, body) {
  // Intuit takes the client secret as Basic (`client_secret_basic`) — the same leg Xero uses. This is
  // the one call where the secret is the proof, before there is a bearer to send.
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${credentials}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new QuickBooksError(
      payload?.error_description ?? payload?.error ?? `QuickBooks refused the token request (${response.status})`,
      { status: response.status, raw: payload },
    );
  }
  return payload;
}

/** Shape Intuit's token response into one vocabulary, including its own refresh-token lifetime. */
function readTokens(payload) {
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresIn: Number(payload.expires_in ?? 0),
    // Intuit reports how long the *refresh* token lives too (`x_refresh_token_expires_in`); keeping it
    // means the app can warn before a connection silently stops refreshing.
    refreshExpiresIn: Number(payload.x_refresh_token_expires_in ?? 0),
    tokenType: payload.token_type ?? 'Bearer',
    scope: payload.scope ?? '',
  };
}

/** Trade the one-time `code` the callback carries for an access token and a refresh token. */
export async function exchangeCode({ config, code }) {
  const payload = await tokenRequest(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });
  return readTokens(payload);
}

/**
 * A fresh pair from the refresh token.
 *
 * Intuit rotates refresh tokens as well, so the caller stores what comes back — keeping the old one
 * after a successful refresh is a lockout waiting to happen.
 */
export async function refreshTokens({ config, refreshToken }) {
  const payload = await tokenRequest(config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return readTokens(payload);
}

/**
 * The connected company's Customers — the practice's client list, with a name *and* an email.
 *
 * `realmId` is the company (Intuit hands it back on the callback). The query is QuickBooks' SQL
 * dialect; `Customer` is the entity a practice that bills its clients keeps them as. A sandbox
 * company lives on a different host, so `sandbox` switches the base.
 */
export async function fetchQuickBooksClients({ accessToken, realmId, sandbox = false }) {
  const base = sandbox ? QB_QUERY_URL_SANDBOX : QB_QUERY_URL;
  const query = encodeURIComponent('select * from Customer');
  const response = await fetch(`${base}/${realmId}/query?query=${query}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new QuickBooksError(`QuickBooks refused the client list (${response.status})`, {
      status: response.status,
      raw: payload,
    });
  }
  // QuickBooks wraps a query's rows in `QueryResponse.Customer`; a bare array is tolerated so a change
  // of wrapper becomes a clear refusal rather than a silently-empty import.
  return Array.isArray(payload) ? payload : (payload?.QueryResponse?.Customer ?? []);
}

/**
 * Customers into `{ name, email }` rows — the same shape `connectionsToRows` and
 * `practiceManagerClientsToRows` produce, so every source pours into one ingestion pipeline.
 *
 * Name is `DisplayName` (falling back to `CompanyName`); email is `PrimaryEmailAddr.Address`. A
 * customer with no email still comes through as a name — the pipeline counts those as chased by
 * phone rather than dropping them.
 */
export function clientsToRows(customers) {
  return (customers ?? [])
    .map((customer) => ({
      name: String(customer?.DisplayName ?? customer?.CompanyName ?? '').trim(),
      email: String(customer?.PrimaryEmailAddr?.Address ?? '').trim(),
    }))
    .filter((row) => row.name !== '');
}

/**
 * The connected company's own record — its legal entity type, tax identifier and fiscal year, which
 * are the facts a document request is built from. Read through the same query endpoint as the client
 * list; `CompanyInfo` is a singleton per company (realm), so it comes back as one row.
 */
export async function fetchCompanyInfo({ accessToken, realmId, sandbox = false }) {
  const base = sandbox ? QB_QUERY_URL_SANDBOX : QB_QUERY_URL;
  const query = encodeURIComponent('select * from CompanyInfo');
  const response = await fetch(`${base}/${realmId}/query?query=${query}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new QuickBooksError(`QuickBooks refused the company record (${response.status})`, {
      status: response.status,
      raw: payload,
    });
  }
  const rows = Array.isArray(payload) ? payload : (payload?.QueryResponse?.CompanyInfo ?? []);
  return rows[0] ?? null;
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** `FiscalYearStartMonth` is the month the year *starts*, so it ends the month before. */
function fiscalYearEndMonth(startMonth) {
  const raw = String(startMonth ?? '').trim().toLowerCase();
  let start = Number(raw);
  if (!Number.isInteger(start) || start < 1 || start > 12) start = MONTHS[raw] ?? 0;
  if (start < 1 || start > 12) return 0;
  return start === 1 ? 12 : start - 1;
}

/**
 * The CompanyInfo record into the same filing profile `organisationToProfile` produces, so Xero and
 * QuickBooks feed one downstream and the request logic never has to know which provider it came from.
 *
 * QuickBooks states a *fiscal year start* month rather than a year-end date, so the year-end month is
 * the month before it and the **day is left null rather than invented** — the last day of a month is
 * not fixed (February), and a wrong due date is worse than none. Everything else is a fact the record
 * states outright.
 */
export function companyInfoToProfile(companyInfo) {
  if (!companyInfo) return null;
  const endMonth = fiscalYearEndMonth(companyInfo.FiscalYearStartMonth);
  const taxNumber = String(companyInfo.TaxIdentifier ?? '').trim();
  return {
    name: String(companyInfo.Name ?? companyInfo.LegalName ?? '').trim(),
    entityType: String(companyInfo.EntityType ?? '').trim() || null,
    yearEnd: endMonth > 0 ? { day: null, month: endMonth } : null,
    taxNumber: taxNumber || null,
    // QuickBooks' CompanyInfo carries no stable base-currency field, so it is reported as unknown.
    baseCurrency: null,
    countryCode: String(companyInfo.Country ?? '').trim() || null,
  };
}