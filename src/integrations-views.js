/**
 * The integrations home — one page that says what is connected, how fresh it is, and the one button that
 * brings a client book across.
 *
 * Xero and QuickBooks each have their own deep page (`/integrations/xero`, `/integrations/quickbooks`)
 * with the connect, import and "books behind" controls. This is the signpost that makes those reachable
 * from anywhere, the one place that answers "what have I connected?" and "how fresh is it?", and where a
 * practitioner presses **Sync now**. The connect/import controls stay on each provider's own page so each
 * flow has one home rather than two that can drift apart.
 *
 * It also says, in plain words, how bringing the client book across works: on demand and while you work,
 * never on a background timer, and never twice. A practice that expects silent nightly sync will otherwise
 * think the product is broken the morning a client they added in Xero is not here yet — so the honest
 * sentence about *when* new data appears is worth more here than any badge.
 */
import { formFields, field, readBody } from './http.js';
import { connectionFor } from './store.js';
import { syncProvider } from './integrations-sync.js';
import { xeroFromEnvironment, XeroError } from './tenancy/xero.js';
import { quickBooksFromEnvironment, QuickBooksError } from './tenancy/quickbooks.js';
import { fail, html, page, redirect, requireSignIn, sendPage } from './views.js';

/** "just now", "3 hours ago", "2 days ago" — the answer to "how fresh is this book?". */
function relative(when) {
  const then = Date.parse(when ?? '');
  if (!Number.isFinite(then)) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** One provider's card: what it is, what state it is in, how fresh, and the buttons that matter. */
function providerCard({ provider, name, href, configured, connection, about }) {
  const state = !configured
    ? html`<p class="note">Not set up on this install — the server has no ${name} OAuth app configured.</p>`
    : connection
      ? html`<p class="success"><strong>Connected.</strong> Tickmark can read this practice's ${name} client
          list, and nothing more.</p>`
      : html`<p class="note">Not connected yet.</p>`;
  const manage = !configured
    ? html`<a class="btn" href="${href}">How to set it up</a>`
    : connection
      ? html`<a class="btn" href="${href}">Manage ${name}</a>`
      : html`<a class="btn primary" href="${href}">Connect ${name}</a>`;
  const sync = connection
    ? html`<form method="post" action="/integrations/sync" class="inline">
        <input type="hidden" name="provider" value="${provider}">
        <button type="submit" class="btn primary">Sync now</button>
      </form>`
    : '';
  return html`<section class="card">
    <h2>${name}</h2>
    <p class="note">${about}</p>
    ${state}
    <div class="actions">${manage}${sync}</div>
    ${connection
      ? html`<p class="note">Last brought across: <strong>${relative(connection.last_synced_at)}</strong>.</p>`
      : ''}
  </section>`;
}

/** The integrations home. Read-only apart from the "Sync now" buttons. */
export function integrationsPage({ db, response, practitioner, practiceId, url }) {
  if (!requireSignIn({ practitioner, response })) return;
  const xeroConfigured = Boolean(xeroFromEnvironment());
  const quickBooksConfigured = Boolean(quickBooksFromEnvironment());
  const synced = url?.searchParams.get('synced');
  const added = url?.searchParams.get('added');
  const total = url?.searchParams.get('total');

  return sendPage(response, 200, page({
    title: 'Integrations',
    practitioner,
    here: '/integrations',
    body: html`
      <div class="page-head"><div class="titles">
        <h1>Integrations</h1>
        <p class="sub">Bring your client book across from the tools you already keep it in.</p>
      </div></div>

      ${synced
        ? html`<p class="success"><strong>Client list brought across just now.</strong> ${added} new or
            updated, ${total} read from ${synced === 'quickbooks' ? 'QuickBooks' : 'Xero'}.</p>`
        : ''}

      <section class="card">
        <h2>How bringing clients across works</h2>
        <p class="note">Tickmark reads your <strong>client list</strong> — names and email addresses — from
        these tools, <strong>when you press Sync now</strong> and quietly while you are working (at most
        about once an hour), and it writes nothing back. Bringing clients across never creates the same
        client twice, so you can sync whenever you like to catch up; a client you add in Xero or QuickBooks
        appears here the next time Tickmark looks.</p>
        <p class="note"><strong>What it never reads:</strong> your clients' documents — those are end-to-end
        encrypted and unreadable to this server — and never their transactions. The optional "books behind"
        signal reads a count and a date only, never the transactions themselves, and only when you turn it
        on.</p>
      </section>

      ${providerCard({
        provider: 'xero',
        name: 'Xero',
        href: '/integrations/xero',
        configured: xeroConfigured,
        connection: xeroConfigured ? connectionFor(db, practiceId, 'xero') : null,
        about: 'Import the organisations you manage in Xero as your client book.',
      })}
      ${providerCard({
        provider: 'quickbooks',
        name: 'QuickBooks',
        href: '/integrations/quickbooks',
        configured: quickBooksConfigured,
        connection: quickBooksConfigured ? connectionFor(db, practiceId, 'quickbooks') : null,
        about: 'Import the customers in your QuickBooks company as your client book.',
      })}
    `,
  }));
}

/**
 * "Sync now": bring one provider's client book across, right now, and say what happened. Reads the client
 * list alone — never a document, never a transaction.
 */
export async function integrationsSync({ db, request, response, practitioner, practiceId }) {
  if (!requireSignIn({ practitioner, response })) return;
  const fields = formFields(await readBody(request));
  const provider = field(fields, 'provider') === 'quickbooks' ? 'quickbooks' : 'xero';
  try {
    const summary = await syncProvider(db, practiceId, provider, practitioner.id);
    if (!summary) return fail(response, 409, 'That provider is not connected yet.', practitioner);
    return redirect(
      response,
      `/integrations?synced=${provider}&added=${summary.created + summary.updated}&total=${summary.total}`,
    );
  } catch (error) {
    const known = provider === 'quickbooks' ? QuickBooksError : XeroError;
    if (error instanceof known) {
      return fail(response, 502, `Could not bring the client list across: ${error.message}`, practitioner);
    }
    throw error;
  }
}