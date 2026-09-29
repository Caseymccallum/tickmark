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
  const line = { ts: new Date().toISOString(), level, event, ...fields };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

/** A log that records nothing — for tests and for deployments that keep their access log elsewhere. */
export const NULL_LOG = () => {};
