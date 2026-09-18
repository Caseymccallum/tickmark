# Several people in one practice

Phase 2b. This file is the design decision first, because the roadmap called it "a design question,
not a coding one" and it is right: the answer decides the shape of the data, and the shape of the data
is expensive to change later.

## The problem, stated exactly

A two-partner firm has one login today. That is worse than inconvenient, because it means a shared
password and **a shared passphrase** — and a passphrase is what unwraps the key that opens every
client's documents. Two people who share it cannot be told apart by anything the software does, and
neither can revoke the other's access without changing what both of them know.

The second sentence of that is the hard part. Sharing a *password* is a UI problem. Sharing a
*passphrase* means the practice's private key exists in two people's heads, and there is no way to
express "Ada can open these files and Sam can no longer".

## The decision: one key for the practice, wrapped once per person

**The practice has one key pair. Each member has their own copy of the private key, wrapped under
their own passphrase.**

```
practice
  └── practice_key          the key pair, as a history (rotation already works this way)
        └── key_wrapping    one per member: the private key, wrapped under *their* passphrase
```

### Why the key belongs to the practice and not to the person

The alternative is a key pair per person. It is tempting — it makes "Ada can no longer open these"
trivially true — and it is wrong for this product, for three reasons that are all the same reason:

1. **The documents belong to the practice.** A client's records are the firm's records. If the key is
   Ada's, then Ada leaving makes four years of client files unopenable by the firm that is legally
   obliged to keep them.
2. **A request has one recipient.** The client's browser fetches one public key to encrypt to. Per-person
   keys would mean the request has to name *whose* key, which makes every request a question about
   staffing rather than about documents.
3. **A sole practitioner is the buyer.** For them the two designs are identical. The per-person design
   buys nothing for the common case and costs correctness in the uncommon one.

### What this costs, stated rather than discovered

- **Adding a member means giving them the private key.** There is no way around this: a wrapped copy
  cannot be created by the server, because the server does not have the key. The invitation flow below
  is designed around that constraint rather than pretending it away.
- **Removing a member does not un-disclose anything.** If Ada had the key, Ada can still open every file
  she already copied, and any copy she kept of the wrapped key still opens under her passphrase. The
  honest statement is the one `docs/encryption.md` already makes about rotation: **revoking access
  changes what happens next; it cannot change what has already happened.** A firm that needs more than
  that needs a key per client, or a trust model this format deliberately does not have.
- **A shared passphrase stops being necessary but does not become impossible.** Two members may still
  choose the same passphrase. Nothing here prevents that, and nothing here can.

## Removing a member, which is not built

**The state is visible; the act is not.** The members page has a column saying whether each person holds a
copy of the newest key, so a member who cannot open recent files is a fact on a screen rather than a
mystery. There is no button that removes anyone, and that is deliberate rather than unfinished.

What it would need, written down so it is not improvised later:

1. **Their sessions end.** Straightforward: delete the session rows. `endAllSessions` was removed as dead
   code in stage B; this is the thing that would bring it back.
2. **Their sealed copies go.** Delete the `key_wrapping` rows for them. This is what stops them signing in
   later and opening anything new.
3. **And none of it un-discloses anything.** If they had the key — and they did, or they could not have
   worked there — then any copy of the wrapped record they kept still opens under their passphrase, and any
   document they downloaded is theirs. Removing a member is a statement about the future. `docs/encryption.md`
   already says the same thing about rotation, and it is the same fact seen twice.
4. **The honest answer for a firm that needs more than that** is a key per client, or a trust model this
   format deliberately does not have — and the removal page should say so rather than implying a party the
   software cannot deliver.

The reason it is not built yet is the third point. A button that looked like revocation and was not would
be worse than no button, so the decision to add one should come with the sentence that goes next to it.

**Built in two parts: the crypto and the storage (done), then the pages (next).** The constraint: the new
member's sealed copy must be produced by someone who has the key, and the server must never hold the key
or the secret that opens the invitation.

**The owner's browser** (this is C-ii, not yet built):

1. generates a random **invite secret** — 32 bytes, produced by the browser and sent nowhere;
2. unwraps the practice's private key with the owner's passphrase, getting PKCS#8 bytes;
3. seals those bytes under the secret, and posts **only the sealed blob**;
4. the server stores the blob and a digest of a fresh token, and the link is
   `/invite/<token>#<secret>`. The server never sees the fragment, because browsers do not send it —
   the same trick a client link uses, for a second purpose.

**The new member's browser:**

1. reads the secret from the fragment;
2. fetches the sealed blob for that token;
3. opens it with the secret, then re-seals the same key under **their own** passphrase;
4. posts only the re-sealed record, which is stored as their `key_wrapping` row.

So the server ends up holding one more sealed copy and no more knowledge than before. What the owner must
understand before inviting, and what the page will say plainly: **anyone who opens that link before the
intended person does gets the key.** It expires like any link, it is single-use, and there is no way to
make it selective beyond keeping it private.

## The order this happens in, and what each stage leaves true

| Stage | What it does | What is true at the end |
| --- | --- | --- |
| **A** (done) | `practice` exists; `practice_id` on every tenant-owned row; a migration that gives every existing practitioner their own practice and backfills | The database is ready. **Behaviour is unchanged**, and every existing test still passes — one practitioner, one practice |
| **B** (done) | The code reads and writes `practice_id`; `createdBy` records the person; sign-up creates a practice; sessions carry the practice | Two people in one practice see the same client's records — a capability the old shape could not express |
| **C** (done) | C-i: the invitation crypto and one sealed copy of the key per member. C-ii: the members page, the invitation pages, two browser halves, and a practice name you can change | A two-partner firm can use this |

**Why stage A was separate.** It changed an existing operator's database, which is the one thing here that
can lose data. It got its own pass, its own migration test, and its own commit. The old `practitioner_id`
columns are still in place and still written, so a migrated database remains readable by the previous
release — and stage B added `createdBy` rather than repurposing them, which keeps that property true.

**Why stage B needed its own pass too.** Sixty-nine call sites across `src/`, plus a schema change. Doing
it in the same pass as A would have meant a single commit where a data migration and a mechanical rename
could not be told apart — and when something failed, the culprit would have been unclear. It was still
worth doing in one pass with A already banked: with one member, the switch is behaviour-preserving, and
the 113 tests that existed before it were the guard.