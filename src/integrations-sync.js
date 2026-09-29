/**
 * Bringing a practice's client book across from a connected provider, and keeping it fresh.
 *
 * Three callers share one path — the import preview's run, the "Sync now" button, and the quiet refresh
 * that runs while a practitioner is working — so "importing" and "syncing" are not two behaviours that can
 * drift. Each does the same thing: read the client list, pour it through the one ingestion pipeline, stamp
 * when it was last brought across.
 *
 * ## What is read, and what is not
 *
 * Only the client list (names and addresses) and, where the source carries one, a filing profile. Never a
 * client document — those stay end-to-end encrypted and unreadable here. Never a transaction. The optional
 * "books behind" signal is a separate, opt-in read that only `books-check` makes; nothing here touches it.
 * The posture is written out in docs/security.md.
 *
 * ## Why the quiet refresh is throttled and fire-and-forget
 *
 * A background refresh runs only when the book is stale (at most once an hour per provider) and never on a
 * timer — only while the practice is actually using Tickmark. That keeps "nothing is read without a person
 * here" true, needs no scheduler this zero-dependency app does not have, and stops a page load from becoming
 * a synchronous call to Xero. A quiet refresh that fails leaves the book as it was and the next pass tries
 * again; it never breaks the page that triggered it.
 */
import { connectionFor, importClients, markSynced } from './store.js';
import { xeroClientRows } from './xero-views.js';
import { quickBooksClientRows } from './quickbooks-views.js';

const PROVIDERS = ['xero', 'quickbooks'];
/** How stale the book may get before a look-in-passing refresh: at most once an hour. */
const SYNC_EVERY_MS = 60 * 60 * 1000;
/** One in-flight refresh per practice + provider, so two page loads cannot double-import. */
const syncing = new Set();

/**
 * Read one provider's client list and pour it through the pipeline. Returns the import summary (with the
 * number read), or null when that provider is not configured or not connected — never an empty guess.
 */
export async function syncProvider(db, practiceId, provider, createdBy) {
  const rows = provider === 'xero'
    ? await xeroClientRows(db, practiceId)
    : await quickBooksClientRows(db, practiceId);
  if (!rows) return null;
  const summary = importClients(db, practiceId, createdBy, rows);
  markSynced(db, practiceId, provider);
  return { ...summary, total: rows.length };
}

/**
 * Refresh any stale connected provider in the background while the practice works. Callers fire-and-forget
 * this; it returns the in-flight promises only so a test can wait for them.
 */
export function maybeSyncOnActivity(db, practiceId, practitionerId) {
  const running = [];
  for (const provider of PROVIDERS) {
    const connection = connectionFor(db, practiceId, provider);
    if (!connection) continue;
    const last = Date.parse(connection.last_synced_at ?? '') || 0;
    if (Date.now() - last < SYNC_EVERY_MS) continue;
    const key = `${practiceId}:${provider}`;
    if (syncing.has(key)) continue;
    syncing.add(key);
    running.push(
      syncProvider(db, practiceId, provider, practitionerId)
        .catch(() => {})              // a quiet refresh that fails is not this page's problem
        .finally(() => syncing.delete(key)),
    );
  }
  return running;
}
