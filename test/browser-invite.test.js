/**
 * The two halves of an invitation, run rather than served.
 *
 * `web/members.js` creates one and `web/invite.js` accepts it, and between them they carry the practice's private
 * key from one person to another without the server ever holding anything it can open. Both were served on their
 * pages and executed by nothing — and writing this file found a real fault on its first run: `members.js` was posting
 * the invitation secret to the server, which both `src/members-views.js` and the page's own copy say never happens.
 * The assertion that keeps it out is the one below that names the fields an invitation is allowed to carry.
 *
 * The crypto is not re-implemented here either: what the creating page seals is opened with `openInviteBytes` from
 * `web/tickmark-crypto.js`, and what the accepting page writes into its form is opened with
 * `privateKeyBytesForTransfer`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answer, element, installPage } from './fake-dom.js';
import {
  MIN_PASSPHRASE,
  generatePracticeKey,
  newInviteSecret,
  openInviteBytes,
  privateKeyBytesForTransfer,
  wrapBytesForInvite,
} from '../web/tickmark-crypto.js';

const PASSPHRASE = 'a passphrase long enough';
const NEW_PASSPHRASE = 'the new member\u2019s passphrase';
const ORIGIN = 'http://practice.test';

const fields = (body) => new URLSearchParams(String(body));

let practice = null;
const fixture = async () => {
  practice ??= generatePracticeKey(PASSPHRASE);
  return practice;
};

test('an invitation that carries a key seals it to a secret the server is never given', async () => {
  const { wrappedPrivateKey } = await fixture();
  const keyRecord = element({ textContent: JSON.stringify({ wrapped: wrappedPrivateKey, keyId: 'k1' }) });
  const passphraseField = element({ value: PASSPHRASE });
  const roleField = element({ value: 'accountant' });
  const passphraseRow = element();
  const form = element({
    children: { '#passphrase': passphraseField, '#invite-role': roleField, '#passphrase-row': passphraseRow },
  });
  const status = element();
  const link = element({ hidden: true });
  const page = installPage({
    ids: { 'invite-key': keyRecord, 'invite-form': form, 'invite-status': status, 'invite-link': link },
    fetch: () => answer({ json: { token: 'tok-123', days: 7, keyed: true } }),
  });
  await page.load('../web/members.js');

  assert.equal(passphraseRow.hidden, false, 'an invitation that carries a key asks for the passphrase that opens it');
  await form.fire('submit');

  assert.equal(page.sent.length, 1, 'the secret survives the response because this is a fetch, not a form post');
  const [request] = page.sent;
  assert.equal(request.url, '/members/invite');
  assert.equal(request.headers.accept, 'application/json');

  const posted = fields(request.body);
  assert.deepEqual(
    [...posted.keys()].sort(),
    ['key_id', 'role', 'sealed_key'],
    'three fields, and no secret among them — the part after the # is for the link and nothing else',
  );
  assert.ok(posted.get('sealed_key').startsWith('invite$sha-256$'), 'what travels is a sealed blob, not a key');
  assert.equal(passphraseField.value, '', 'and the passphrase field has done its job by the time the link is shown');

  // The link the page builds, and the only other place the secret exists.
  assert.equal(link.hidden, false, 'the practice is given the link rather than told to go and find it');
  assert.equal(link.appended.length, 1, 'exactly one code block');
  const shown = link.appended[0].textContent;
  assert.ok(shown.startsWith(`${ORIGIN}/invite/tok-123#`), `the link is the origin, the token, and a fragment — got ${shown}`);
  const secret = shown.slice(shown.indexOf('#') + 1);

  // The claim, checked the only way it can be: the blob in the link opens with the fragment, to the practice's own
  // key — and the passphrase it was unwrapped with is not in the link either.
  const opened = await openInviteBytes(posted.get('sealed_key'), secret);
  const expected = await privateKeyBytesForTransfer(wrappedPrivateKey, PASSPHRASE);
  assert.deepEqual(Array.from(opened), Array.from(expected), 'the fragment opens the invitation to the practice key');
  assert.ok(!shown.includes(PASSPHRASE), 'and the passphrase is not in the link');

  assert.match(status.textContent, /Ready\. They will be able to open what clients send\./, 'the page says what was made');
  assert.match(status.textContent, /7 days/, 'including how long it lasts');
});

test('an assistant invitation carries no key, so it stops asking for a passphrase', async () => {
  const { wrappedPrivateKey } = await fixture();
  const keyRecord = element({ textContent: JSON.stringify({ wrapped: wrappedPrivateKey, keyId: 'k1' }) });
  const passphraseField = element({ value: PASSPHRASE });
  const roleField = element({ value: 'accountant' });
  const passphraseRow = element();
  const form = element({
    children: { '#passphrase': passphraseField, '#invite-role': roleField, '#passphrase-row': passphraseRow },
  });
  const status = element();
  const link = element({ hidden: true });
  const page = installPage({
    ids: { 'invite-key': keyRecord, 'invite-form': form, 'invite-status': status, 'invite-link': link },
    fetch: () => answer({ json: { token: 'tok-456', days: 7, keyed: false } }),
  });
  await page.load('../web/members.js');

  // The role picker is the only thing that decides this, and the passphrase field disappears with it: a field
  // somebody does not need is a field they will fill in.
  roleField.value = 'assistant';
  await roleField.fire('change');
  assert.equal(passphraseRow.hidden, true, 'nothing is being handed over, so nothing is asked for');

  await form.fire('submit');

  const posted = fields(page.sent[0].body);
  assert.deepEqual([...posted.keys()].sort(), ['role'], 'one field: what the invitation grants');
  assert.equal(posted.get('role'), 'assistant');
  assert.ok(!String(page.sent[0].body).includes(PASSPHRASE), 'and the passphrase — still typed in the form — goes nowhere');

  const shown = link.appended[0].textContent;
  assert.equal(shown, `${ORIGIN}/invite/tok-456`, 'an invitation with no key has no secret, so its link is a plain address');
  assert.ok(!shown.includes('#'), 'and nothing to put after a #');
  assert.match(status.textContent, /able to chase documents but not open them/);
});

test('accepting an invitation re-seals the key, and the fragment never enters the form', async () => {
  const { wrappedPrivateKey } = await fixture();
  const secret = newInviteSecret();
  const sealed = await wrapBytesForInvite(await privateKeyBytesForTransfer(wrappedPrivateKey, PASSPHRASE), secret);

  const blob = element({ textContent: JSON.stringify({ sealed }) });
  const passphraseField = element({ value: NEW_PASSPHRASE });
  const againField = element({ value: NEW_PASSPHRASE });
  const wrappedField = element();
  const form = element({
    children: { '#passphrase': passphraseField, '#again': againField, '#wrapped_private_key': wrappedField },
  });
  const status = element();

  // What the form holds *at the moment it is submitted* — the only way to check that the passphrase boxes are
  // cleared before the browser takes the form anywhere, rather than afterwards.
  let atSubmit = null;
  form.submit = () => {
    atSubmit = { passphrase: passphraseField.value, again: againField.value, wrapped: wrappedField.value };
    form.submitted += 1;
  };

  const page = installPage({
    ids: { 'invite-blob': blob, 'accept-form': form, 'accept-status': status },
    hash: `#${secret}`,
    fetch: () => {
      throw new Error('the accepting page posts the form; it must not fetch anything');
    },
  });
  await page.load('../web/invite.js');

  passphraseField.value = 'short';
  againField.value = 'short';
  await form.fire('submit');
  assert.equal(status.textContent, `Use at least ${MIN_PASSPHRASE} characters.`);

  passphraseField.value = NEW_PASSPHRASE;
  againField.value = 'something else entirely';
  await form.fire('submit');
  assert.equal(status.textContent, 'Those two are not the same.');
  assert.equal(form.submitted, 0, 'neither refusal reached the browser, so nothing was posted');

  againField.value = NEW_PASSPHRASE;
  await form.fire('submit');

  assert.equal(form.submitted, 1, 'the invitation is submitted as a form, which is what keeps the fragment out of it');
  assert.equal(atSubmit.passphrase, '', 'the passphrase is cleared before the form goes anywhere');
  assert.equal(atSubmit.again, '', 'both boxes');
  assert.ok(
    !Object.values(atSubmit).some((value) => String(value).includes(secret)),
    'and the secret from the fragment is in no field of the form',
  );

  const opened = await privateKeyBytesForTransfer(atSubmit.wrapped, NEW_PASSPHRASE);
  const expected = await privateKeyBytesForTransfer(wrappedPrivateKey, PASSPHRASE);
  assert.deepEqual(
    Array.from(opened),
    Array.from(expected),
    'what travels is the practice key, re-sealed under the new member\u2019s own passphrase',
  );
  assert.equal(status.textContent, 'Joining…');
});

test('a link with no fragment is refused, and says which part is missing', async () => {
  const { wrappedPrivateKey } = await fixture();
  const secret = newInviteSecret();
  const sealed = await wrapBytesForInvite(await privateKeyBytesForTransfer(wrappedPrivateKey, PASSPHRASE), secret);

  const blob = element({ textContent: JSON.stringify({ sealed }) });
  const passphraseField = element({ value: NEW_PASSPHRASE });
  const wrappedField = element();
  const form = element({
    children: { '#passphrase': passphraseField, '#again': element({ value: NEW_PASSPHRASE }), '#wrapped_private_key': wrappedField },
  });
  const status = element();
  const page = installPage({
    ids: { 'invite-blob': blob, 'accept-form': form, 'accept-status': status },
    hash: '',
    fetch: () => {
      throw new Error('there is nothing to fetch on a page whose link cannot be opened');
    },
  });
  await page.load('../web/invite.js');

  await form.fire('submit');

  assert.match(status.textContent, /the part after the # is what opens it/, 'it names the part of the link that is missing');
  assert.equal(form.submitted, 0, 'and nothing is sent for the server to refuse');
  assert.equal(wrappedField.value, '', 'and no re-sealed copy was written into the form');
});
