/**
 * The letters this product writes.
 *
 * Everything here is text rather than a page: the drafts a practice edits before sending, the one message this
 * product sends on its own, and the sign-off they share. Split out of `src/app.js` because it is the part of that
 * file with no routes in it — **step one of the split proposed in `docs/audit.md` §3**, chosen first for the reason
 * the audit gives: no route coupling, and the existing suite already owns almost all of it
 * (`test/notify.test.js`, `test/chase.test.js`, `test/identity.test.js`).
 *
 * Two rules explain why these are pure functions of the facts, and why they live away from the HTTP surface:
 *
 * 1. **The wording has one home**, so a practice's letter can be read, tested and changed with no mail server and
 *    no request in hand.
 * 2. **A caller cannot invent a fact.** A subject line is derived here from what actually happened rather than
 *    passed in as a trigger, because a caller that got the trigger wrong would produce a subject that contradicts
 *    its own body.
 */
import { dateIn, todayIn } from './clock.js';
import { sendMail } from './mailer.js';
import { history, itemsOf, lastNoticeAt, ownersOf, practiceFor, recordEvent, requestOwner, uploadsOf } from './store.js';

/**
 * The message a practice gets when a client does something.
 *
 * This is the other half of the loop, and the half the research is most specific about: *"a job should flip to
 * ready when the document set is complete, not when files arrive"*, and *"a system that hides its uncertainty is
 * worse than none"*. A practice with sixty clients cannot poll a board, so without this the product knows
 * something its owner does not — which is the one thing a document-chasing tool must not do.
 *
 * Five decisions in the wording, each of them a failure this would otherwise have:
 *
 * 1. **It says what arrived *and* what has not.** "3 documents arrived" invites the question "is that all of
 *    them?", and the answer is the only thing the practice actually needs.
 * 2. **It carries the client's own words.** An answer to "why can't you send this?" is a decision waiting to be
 *    made, in the client's own phrasing — and it is quoted rather than summarised, because "I do not have this"
 *    and "I will send this later" are different situations and telling them apart is the point of asking.
 * 3. **It never says the work is ready unless it is.** All arrived is reported as all arrived; anything else
 *    carries the count still owed, and something flagged for re-sending is said outright.
 * 4. **It does not name files.** Filenames are metadata the server can see and the practice can see, but an
 *    email is a copy that leaves the building — quoted, forwarded, sync'd to a phone in plaintext — and the
 *    practice is one click from the real names. The narrower thing is the right one here; the labels are enough
 *    to know whether to go and look.
 * 5. **It is a nudge to look, not a running total.** One message per request per day (see the caller), because
 *    a client sending six files must not produce six emails — that is how a helpful notification becomes one the
 *    practice filters into a folder and stops reading.
 */
export function arrivalDraft({
  clientName,
  title,
  received,
  total,
  missing = [],
  answers = [],
  again = [],
  said = [],
  extra = 0,
  link,
  practiceName = null,
}) {
  const lines = ['Hello,', ''];
  const complete = received === total && again.length === 0 && answers.length === 0;

  if (complete) {
    lines.push(
      `Everything asked for has arrived: ${total} of ${total} ${total === 1 ? 'document' : 'documents'} for ${title}.`,
    );
  } else {
    lines.push(`${clientName} has sent ${received} of ${total} ${total === 1 ? 'document' : 'documents'} for ${title}.`);
  }
  lines.push('');

  // The client's own words, before anything else, because they change what the practice does next: a document
  // somebody has explained they cannot supply is not chased, it is decided about.
  if (answers.length > 0) {
    lines.push(
      `${answers.length === 1 ? 'One document has an answer' : `${answers.length} documents have answers`} from ${clientName}:`,
      '',
      ...answers.map((item) => `  - ${item.label} — "${item.says}"`),
      '',
      'Those are waiting on a decision from you rather than on the client.',
      '',
    );
  }

  // A message, quoted rather than summarised. The two fixed buttons cover "I cannot send this" and "I will send
  // it later"; anything else the client writes is theirs and paraphrasing it would lose the part that matters.
  if (said.length > 0) {
    lines.push(`And ${said.length === 1 ? 'a message' : `${said.length} messages`} from ${clientName}:`, '');
    for (const message of said) lines.push(`  "${message}"`, '');
  }

  // Files that answer nothing. Named rather than counted, because the practice has to decide what they are.
  if (extra > 0) {
    lines.push(
      `${extra} ${extra === 1 ? 'file was' : 'files were'} sent that nothing had asked for. They are on the request.`,
      '',
    );
  }

  if (complete) {
    lines.push('There is nothing more to wait for. Open the request to check what came in and mark it off.', '');
  } else if (missing.length > 0) {
    lines.push('Still outstanding:', '', ...missing.map((label) => `  - ${label}`), '');
  }
  // Said before the link, because it changes what the practice does next: a document that has been sent but is
  // no use is a thing to chase, not a thing to count as arrived.
  if (again.length > 0) {
    lines.push(
      `${again.length} ${again.length === 1 ? 'document has' : 'documents have'} been sent but flagged as needing sending again:`,
      '',
      ...again.map((item) => `  - ${item.label}${item.note ? ` (${item.note})` : ''}`),
      '',
    );
  }

  lines.push('The request, with the files themselves:', link);

  // Said only when the position may have moved on, because a message sent on the first file of a sitting
  // describes that moment and the client may well have sent the rest by the time it is read.
  if (!complete) {
    lines.push('', 'That is where it stood when this was sent — the request itself shows the current position.');
  }
  lines.push('', ...signOff(practiceName));
  return {
    // The subject is a fact that stays true when it is read a week later in a list, because a subject is the one
    // part of an email people read without opening it. "Sent 1 of 3" would be true when written and false minutes
    // later, and a practice scanning a column of subjects deserves better than arithmetic that has moved on. The
    // count is in the body, where the snapshot is dated.
    //
    // Which of the two things happened is *derived* from the facts rather than passed in as a "trigger", because a
    // caller that got the trigger wrong would produce a subject that contradicts its own body. Nothing received
    // and an answer present means the answer is what happened; anything else is a file.
    subject: complete
      ? `Everything has arrived for ${title}`
      : received === 0 && said.length > 0
        ? `${clientName} has written about ${title}`
        : received === 0 && answers.length > 0
          ? `${clientName} has answered about ${title}`
          : `${clientName} has sent something for ${title}`,
    body: lines.join('\n'),
  };
}

/**
 * Tell the practice that something happened on the client's side — **after the client has already been answered.**
 *
 * Two triggers reach this: a file arriving, and a client saying something ("I do not have this", "I will send it
 * later"). They share one message and one set of rules, because they are the same event from the practice's point
 * of view — the client has done something and somebody has to look. Every email this product sent before this one
 * was triggered by the practice pressing a button; this is the other half of the loop, and the half the research
 * is most specific about: *"a job should flip to ready when the document set is complete, not when files arrive"*
 * is a sentence about the person doing the work being told.
 *
 * The ordering is the whole design. The client's action is recorded and their response sent before this runs, so a
 * mail server that is down, slow, or refusing the practice's own address can never make a client's upload fail,
 * never make them wait, and never make an answer look like an error. The client is doing the practice a favour.
 *
 * Everything is wrapped, and every outcome is named rather than thrown. Returns a short word for the caller —
 * and for the tests, which is how each of these rules is checked without reading a log.
 */
export async function notifyPracticeOfChange({ db, requestRow, mailer, origin }) {
  try {
    const practice = practiceFor(db, requestRow.practice_id);
    if (!practice) return 'no-practice';
    if (!mailer) return 'no-mail-server';
    if (!practice.notifyOnUpload) return 'turned-off';

    const owner = requestOwner(db, requestRow.id);
    if (!owner?.email) return 'nobody-to-tell';

    // Once per request per day, on the practice's own calendar. Without this, a client sending six files sends
    // six emails — and the sixth is the reason the practice turns the whole thing off. The day is counted from
    // the practice's timezone, which is the one piece of time arithmetic this product does.
    const last = lastNoticeAt(db, requestRow.id);
    if (last && dateIn(practice.timezone, new Date(last)) === todayIn(practice.timezone)) return 'already-told';

    const items = itemsOf(db, requestRow.id).filter((item) => !item.withdrawn);
    if (items.length === 0) return 'nothing-asked-for';

    const message = arrivalDraft({
      clientName: requestRow.client_name,
      title: requestRow.title,
      received: items.filter((item) => item.received).length,
      total: items.length,
      missing: items.filter((item) => !item.received).map((item) => item.label),
      // What the client said, which is the reason this email fires on an answer as well as on a file: an item the
      // client has explained they cannot supply is still outstanding, and a practice that does not know is a
      // practice that nags them about it.
      answers: items
        .filter((item) => item.clientSays)
        .map((item) => ({ label: item.label, says: item.clientSays })),
      // Flagged documents are listed apart, because "we have all of it" and "we have all of it and one of them is
      // the wrong year" are different mornings for the person reading this.
      again: items
        .filter((item) => item.needsAttention)
        .map((item) => ({ label: item.label, note: item.attentionNote })),
      // A client's own words are quoted, and their own documents are counted. Both are facts about the request;
      // neither is a "reason this email was sent", which is why the subject is derived from them rather than
      // passed in as a trigger that a caller could get wrong.
      said: history(db, requestRow.id)
        .filter((event) => event.kind === 'client.messaged')
        .map((event) => event.detail),
      extra: uploadsOf(db, requestRow.id).filter((upload) => upload.request_item_id === null).length,
      link: `${origin}/requests/${requestRow.id}`,
      practiceName: practice.name,
    });

    const { messageId } = await sendMail(mailer, { to: owner.email, subject: message.subject, body: message.body });
    recordEvent(db, { requestId: requestRow.id, kind: 'notice.sent', detail: `${owner.email} — ${messageId}` });
    return 'sent';
  } catch (error) {
    // A failed notification is recorded and swallowed. It is never the client's problem and never worth failing
    // their action over: what happened is on the board either way, and with no `notice.sent` written the next
    // change will try again rather than being suppressed by a day that never happened.
    try {
      recordEvent(db, { requestId: requestRow.id, kind: 'notice.failed', detail: error.message });
    } catch {
      // If even that fails, the log is the last resort. The client has already had their answer.
    }
    console.error(`tickmark: could not tell the practice about a change to ${requestRow.id}:`, error);
    return 'failed';
  }
}

/**
 * How a letter from the practice ends: the practice's own name.
 *
 * It was `Thanks,` and nothing else, which is the one thing an email asking a stranger for their bank
 * statements must not be: unsigned. A client who has never heard of Tickmark, receiving a message from an
 * address they may not recognise, asking them to open a link and upload documents, needs the sender's name in
 * front of them — and the name on the portal they land on. This is a *draft*, so a practice that signs its
 * letters differently can change it; the point is that the default is not anonymous.
 */
export const signOff = (practiceName) => (practiceName ? ['Thanks,', '', practiceName] : ['Thanks,']);

/**
 * The message a practice sends when it first asks for something.
 *
 * A different letter from a reminder, and the difference is the whole point: nothing has gone wrong yet, so
 * there is nothing to chase and nobody to correct. It introduces the request, lists everything wanted, and
 * says who is asking.
 *
 * The practice's own note to the client is quoted at the top when there is one, because that note was
 * written *for this client* — "here is the list for your 2026 filing, please upload these by Friday" — and
 * a letter that made the client open the portal to read it would be hiding the practice's own words behind
 * a click.
 *
 * Like the reminder, this is a pure function of the facts so the wording has one home and can be tested
 * without a mail server, and like the reminder it is a **draft**: the page puts it in a textarea the
 * practice edits, because the tool does not know this client and the practice does.
 */
export function openingDraft({ clientName, title, dueAt, items, note = null, link, practiceName = null }) {
  const lines = [`Hello ${clientName},`, ''];

  if (note) {
    lines.push(note, '');
  } else {
    lines.push(`We need the following for ${title}:`, '');
  }

  lines.push(`  - ${items.join('\n  - ')}`, '');

  lines.push('You can send them at this link — no account or password needed:', link);
  if (dueAt) lines.push('', `We would like these by ${dueAt}.`);
  lines.push(
    '',
    'If something on the list does not apply to you, reply and tell us — it is easier than sending the wrong thing.',
    '',
    ...signOff(practiceName),
  );

  return { subject: `Documents we need for ${title}`, body: lines.join('\n') };
}

/**
 * The message a practice sends when something has not arrived.
 *
 * A pure function of the facts, exported so the wording has one home and can be tested directly. It is
 * a *draft*: the page puts it in a textarea the practice edits before sending, because the tool does
 * not know this client and the practice does.
 *
 * Two lists rather than one, because "we have not seen this" and "what you sent does not work" are
 * different sentences to receive, and the second one needs to say what was wrong.
 *
 * The escape hatch near the end is not politeness. A reminder listing a document the client cannot
 * supply — because it does not apply to them, or they have already explained why — is a reminder that
 * gets ignored, and the cheapest way to prevent that is to invite the reply.
 */
export function reminderDraft({
  clientName,
  title,
  dueAt,
  outstanding,
  again = [],
  theySaid = [],
  link,
  practiceName = null,
}) {
  const lines = [`Hello ${clientName},`, ''];

  if (outstanding.length > 0) {
    lines.push(
      `We are still waiting on ${outstanding.length === 1 ? 'one document' : `${outstanding.length} documents`} for ${title}:`,
      '',
      ...outstanding.map((label) => `  - ${label}`),
      '',
    );
  }

  if (again.length > 0) {
    lines.push(
      outstanding.length > 0 ? 'These need sending again:' : `These need sending again for ${title}:`,
      '',
      ...again.map((item) => `  - ${item.label}${item.note ? ` (${item.note})` : ''}`),
      '',
    );
  }

  // What the client already told us, repeated back so they can see it was read — and so the practice
  // has to look at it before sending. Chasing somebody about a document they have already explained
  // they cannot produce is the fastest way to make a client stop answering.
  if (theySaid.length > 0) {
    lines.push(
      'You told us about these already, so this is just a note rather than a request:',
      '',
      ...theySaid.map((item) => `  - ${item.label} (you said: ${item.says})`),
      '',
    );
  }

  lines.push('You can send them at this link — no account or password needed:', link);
  if (dueAt) lines.push('', `We had these marked as needed by ${dueAt}.`);
  lines.push(
    '',
    'If something on the list does not apply to you, reply and tell us — it is easier than sending the wrong thing.',
    '',
    ...signOff(practiceName),
  );

  return { subject: `Still needed for ${title}`, body: lines.join('\n') };
}

/**
 * Tell the practice's owners that something changed about the people or keys that open its documents.
 *
 * This is the second automatic email the product sends, and its reason is **detection** rather than
 * bookkeeping. The attack `src/totp.js` describes — a signed-in member adds a wrapping of their own
 * and every future client document is silently sealed to them — looks like nothing anywhere in the
 * interface. It cannot be prevented (the member is legitimately signed in), so the only defence is
 * that somebody hears about it while it is still routine. Key added, member removed, role changed:
 * the three events that decide who can read what from then on.
 *
 * Best effort by design, like the client notification: none of those three acts may fail because a
 * mail relay was down, so a failure here is logged and swallowed.
 */
export async function tellOwners(db, practiceId, mailer, { subject, lines }) {
  try {
    if (!mailer) return 'no-mail-server';
    const practice = practiceFor(db, practiceId);
    const owners = ownersOf(db, practiceId);
    if (owners.length === 0) return 'nobody-to-tell';
    const body = [...lines, '', 'If this was not you, sign in and check the members and keys pages.', '', ...signOff(practice?.name ?? null)].join('\n');
    for (const owner of owners) {
      await sendMail(mailer, { to: owner.email, subject, body });
    }
    return 'sent';
  } catch (error) {
    console.error(`tickmark: could not tell the practice about "${subject}":`, error);
    return 'failed';
  }
}
