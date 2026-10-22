/**
 * One line per operational event, in a shape a person can read and a log aggregator can parse.
 *
 * The app's own diagnostics have always been prose on the console, and for a self-host that is right —
 * an operator reads them. What was missing for a *hosted* install is something a machine can grep and
 * alert on across many practices: a request that failed, a letter that went out, a subscription that
 * changed. Each of those is one JSON line here, with the fields that make it searchable.
 *
 * `NULL_LOG` is the same shape doing nothing, so a test (or a deployment that logs to a reverse proxy
 * instead) can silence these without every call site growing an `if`. The one place this is injected is
 * `createApp`'s `log`, alongside `mailer`, `onLinkIssued` and the rest — a seam, not a global.
 */

/** A single event. `level` is `info` or `error`; `event` is a stable dotted name, not a sentence. */
export function log(level, event, fields = {}) {
  const line = { ts: new Date().toISOString(), level, event, ...sanitize(fields) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

const PRIVATE_FIELD = /password|token|secret|cookie|authorization|recovery|private.?key|bearer/i;

/** Remove bearer credentials embedded in route paths or common secret query parameters. */
export function redactSensitiveText(value) {
  return String(value)
    .replace(/(\/(?:r|invite|reset|verify)\/)[A-Za-z0-9_-]{12,}/gi, '$1[redacted]')
    .replace(/([?&](?:access_token|refresh_token|token|code|secret|key|recovery|password|authorization|auth|signature|sig|api_key|session)=)[^&#\s]*/gi, '$1[redacted]');
}

function sanitize(value, key = '') {
  if (PRIVATE_FIELD.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey)]));
  }
  return value;
}

/** A log that records nothing — for tests and for deployments that keep their access log elsewhere. */
export const NULL_LOG = () => {};
