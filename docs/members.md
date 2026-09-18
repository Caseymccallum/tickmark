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

## The invitation, and why it looks the way it does

The constraint: the new member's wrapped copy must be produced by someone who has the key, and must
never pass through the server in a form the server can read.

**The owner invites from a page where their own key is already unlocked.** Their browser:

1. generates a random **invite secret**;
2. wraps the practice's private key under that secret;
3. puts the wrapped key and the secret in a link — the wrapped key in the path, the secret in the
   **fragment** (`#…`), which a browser never sends to a server;
4. the server stores only a digest of the invitation, exactly as it does for a client link.

**The new member opens the link.** Their browser:

1. reads the secret from the fragment (the server never sees it);
2. unwraps the practice's private key with it;
3. asks them for a password and their **own** passphrase;
4. wraps the practice's private key under *their* passphrase and posts only that.

So the server ends up holding one more wrapped copy and no more knowledge than before. This is the same
shape as the client link — a secret in a fragment, a digest on the server — which is why it is not a
new mechanism so much as the existing one used for a second purpose.

**What the owner must understand before inviting:** anyone who opens that link before the intended
person does gets the key. It expires like any link, it is single-use, and the page says so plainly
rather than in a footnote.

## The order this happens in, and what each stage leaves true

| Stage | What it does | What is true at the end |
| --- | --- | --- |
| **A** (done) | `practice` exists; `practice_id` on every tenant-owned row; a migration that gives every existing practitioner their own practice and backfills | The database is ready. **Behaviour is unchanged**, and every existing test still passes — one practitioner, one practice |
| **B** (next) | The code switches to reading and writing `practice_id`; membership; roles | Two people can be in one practice, each with their own login and passphrase |
| **C** | Invitations in the UI; a members page; removing a member | The feature is usable by a practitioner rather than by a developer |

**Why stage A is separate.** It changes an existing operator's database, which is the one thing here that
can lose data. It gets its own pass, its own migration test, and its own commit — and the old
`practitioner_id` columns are left in place during the transition so that a database that has been
migrated is still readable by the previous release. They are dropped in stage B, when nothing reads
them.