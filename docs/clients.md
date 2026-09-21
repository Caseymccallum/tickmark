# Clients, as records

A practice has clients. Requests are what it does about them. For a long time the code agreed with that
sentence and the screens did not: `request.client_id` has referenced a `client` table since the first
schema, and there was no page that showed a client, no way to fix one, and no way to ask for something
without retyping their name.

This is what was wrong, what it cost, and what the fix is.

## The bug that made this urgent

`findOrCreateClient` matched on name, and — when it matched — **threw the address away**:

```js
const existing = db.prepare('SELECT id FROM client WHERE practice_id = ? AND name = ? COLLATE NOCASE').get(...);
if (existing) return existing.id;      // the email argument is never read again
return createClient(db, { ..., email });
```

So a client created before anyone knew their email could never be given one. Nothing on any page said so.
The visible symptom appeared somewhere else entirely: the chase reads the client's address, so that client
was quietly listed as *no email address on this client* — for as long as the practice kept typing their
address into the request form and watching it do nothing.

The fix is one rule, and it is the rule the whole clients system rests on:

> **A name that matches updates the address and never creates a second row.**

An empty address on a request form does *not* clear one, because a blank field there means "I am not
telling you" rather than "forget it". Clearing an address is done on the client's own page, where it can be
meant.

## The typo problem

The same name-matching that made reuse automatic also made a typo invisible. `Northwind` and
`Northwind Ltd` are two clients, the second one starting with no history, and nothing on the request form
said which names already existed — so the duplicate was created at the exact moment nobody could see it was
happening.

Two changes, and neither is a guess at the name:

- **The form offers the names that exist**, as an autocomplete list rather than a select box. The field
  stays free text — a new client is still just typed — but the names already in the practice are visible
  where the matching decision is made.
- **A client can be renamed**, and the whole history moves with it, because the requests point at the row
  and never at a name. That is what makes a typo a repair rather than a permanent fork.

**Two clients cannot end up with one name.** Renaming onto a name that is taken is refused, and so is
creating one that way. Merging two records decides which history survives, which is not a decision to make
silently because a form was filled in twice — so the practice is told, and chooses.

## The pages

| Page | What it is for |
| --- | --- |
| `/clients` | The directory: everyone the practice asks, with the address the chase will use, how many requests are open, how much is still outstanding, and when they were last written to. A client with no address is a badge on the row rather than a surprise on the chase page. |
| `/clients/:id` | One client: their requests (open and closed, with the state of each), their details — name and address, editable — and their most recent checklist, offered for "the same as last year". |
| `/requests/new?for=<id>` | The same form as ever, with the client already chosen and **carried in a hidden field**. |

That last one is the reuse: the client is decided on their page and travels in the form, so nothing on the
next screen can file the request against the wrong person. It is carried by id rather than re-matched by
name on submit, which matters because the name can be corrected on that very form — a typo noticed at the
last moment renames the client rather than forking one.

`?like=last` fills the checklist and the title from their most recent request. That is the year-two
workflow: the same list, one year on, edited rather than rewritten from scratch.

## What "outstanding" means here

The count on the client list is **not** a second definition of what is still wanted. It calls
`outstandingOf` — the same function the chase and every reminder are built from, which lives in
`src/store.js` beside the rest of the queries for exactly this reason:

An item the practice has flagged as needing attention stays on the list even though a file arrived, because
what arrived is not usable. A withdrawn item leaves it entirely. Two implementations of that rule would be
two things free to disagree, and the way they would disagree is a client chased for a document they already
sent.

The trade is a small lookup per client on the directory page, which a local SQLite file answers in
microseconds. What it buys is one definition of the thing that matters.

## Attribution, not ownership

A client records the practice that owns them and the person who created them, and those are different
columns on purpose: the practice is who the record belongs to, the person is provenance — for the audit
trail a firm eventually wants and for the question "who asked this client for this?" that a two-partner
firm will one day ask.

## What is not here

- **Merging two clients.** Named above: refused rather than done quietly.
- **Per-client notes, tags, or a client portal.** A client is a name, an address, and the requests made of
  them. When a practice needs more, that is a document-management product, and `docs/mvp.md` says why this
  is not one.
- **Deleting a client.** Nothing here is deleted, for the same reason requests are closed rather than
  removed: a record that can lose a row is not a record.
