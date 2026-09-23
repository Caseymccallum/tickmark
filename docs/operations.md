# Running it for a practice

`README.md` says how to start the server. This file is about the rest of it: what to do every week, what to do
on the day something breaks, and which of the product's own promises depend on you rather than on the code.

Written for whoever holds the server — which for a self-hosted practice is usually the practice.

## Backing up, and why the old advice is now wrong

**`cp -r data` is no longer a backup.** It was until this release, and if you read it somewhere older than
this file, that is where you read it.

Two things changed. The database is now in **write-ahead logging**, which is what lets an operator tool read a
live database at all — and WAL keeps recent commits in a `tickmark.db-wal` sidecar rather than in the main
file. So a copy of `data/*.db` taken on its own can be missing **everything since the last checkpoint**, while
looking perfectly fine. That is the worst kind of wrong, because you find out on the day you need it.

The tool replaces it:

```
node tools/backup.mjs --data data --to /wherever/backups/2026-09-22
node tools/backup.mjs --verify /wherever/backups/2026-09-22
```

**Take the backup while the server is running.** It does not need stopping, and it does not need a quiet
moment: `VACUUM INTO` takes a transactionally consistent snapshot, so a client uploading halfway through is
either in the copy or not in it, and never half in it.

**Run `--verify`.** Not because it will usually fail, but because it is the only thing that can tell you the
difference between a backup and a directory that looks like one. It checks three things: that the database is
unchanged since it was written, that it opens, and — the one that matters — **that every uploaded document the
database names is actually present in the copy**. A backup missing every file would pass a checksum happily.

**Back up somewhere else.** A copy on the same disk is not a backup; it is a second copy of the same problem.

### What a restore involves

There is no `--restore` command, deliberately. Restoring is a decision about *which* copy and *what to do with
what is there now*, and a tool that made it one keystroke would make it one mistake away from losing the
current data as well.

The shape of it:

1. Stop the server.
2. Move the current `data` directory aside — **move it, do not delete it.** Whatever is wrong now, it is more
   information than a fresh directory is.
3. Copy the backup's `tickmark.db` and `blobs/` into a new `data` directory, keeping the layout.
4. Start the server. It will open the database, run any migrations it needs, and report them.
5. Sign in, open a request, and **decrypt one document.** That is the only end-to-end proof that the key, the
   envelope and the bytes all came across — and it is thirty seconds.

If step 5 fails, the backup is not usable and the moved-aside directory is still there.

### The honest limits

- **Do not run a backup during a key rotation's re-encryption pass.** The pass rewrites stored files and moves
  the row to the new path a moment later, and a backup taken between those two steps can capture a row pointing
  at a file that is about to be deleted. `--verify` catches it — that is exactly what it is for — but the way to
  avoid it is to take the backup when a re-encryption is not running.
- **A backup beside the original is not a backup.**
- **The manifest records counts, not every file's digest.** Hashing two gigabytes of documents on every backup
  is a real cost; what the check does instead is confirm every named file is present, which is the failure that
  actually happens. If you want digests as well, `find blobs -type f -exec sha256sum {} +` next to the manifest
  is a line of shell.

## How much one client link may store

Every link has two ceilings, and both exist so that one client — or one leaked link — cannot fill the disk. That
matters more than it sounds: a full disk does not fail that upload, it fails **SQLite's writes**, which takes the
whole install down for every practice rather than for the one client.

| | Default | Why |
| --- | --- | --- |
| Per file | 25 MB | Reading a very large file into memory is a memory problem, not a business one |
| **Per link, total** | **2 GB** | A season's documents, generously measured |
| **Per link, count** | **500 files** | A hundred thousand tiny files exhausts inodes long before bytes |

A client who hits one is told which it was and how much room is left, rather than "too large":

> That file would take this link past its limit. 340.2 MB is left of 2.0 GB. Nothing was stored.

**Nothing is stored when a limit refuses** — not the file on disk and not the row — so a client who is asked to
send less has lost nothing. What they cannot do is remove what is already there; that is the practice's call, on
the request page.

Raising them, for a client who genuinely has more:

```
TICKMARK_MAX_REQUEST_BYTES=8589934592   # 8 GB
TICKMARK_MAX_REQUEST_FILES=2000
```

Both are read at startup by `src/server.js`. In a hosted install they come from the tenant's plan instead — see
`PLANS` in `src/tenancy/registry.js`, where the `free` plan gets a tenth of these.

**These bound a link, not a practice.** A practice with sixty clients has sixty of them, so the total a practice
may store is a billing question rather than a product one, and it belongs to the hosted layer. On a self-hosted
install the answer is your disk size, and the honest advice is to look at it once a season rather than to expect
the software to.

## One thing that interacts with backups: the re-encryption pass

Covered in `docs/encryption.md`, with one operational note here. The pass rewrites a stored file and *then*
moves the row to the new path, so **a backup taken mid-pass can capture a row pointing at a file that is about
to be unlinked**. `--verify` catches it — that is precisely the check it performs — but the way to avoid it is
to take backups outside the pass.


With `MULTI_TENANT=1`, `data/` holds a registry database and a directory per practice:

```
data/saas.db            the registry: accounts, tenants, host names
data/tenants/<id>/tickmark.db
data/tenants/<id>/blobs/
```

**Each practice is backed up separately**, and the reason is the same one that made this architecture worth
having: a practice's documents are in one directory, so copying that directory is copying that practice.
`tools/backup.mjs` takes one `--data` at a time, so a full backup is a loop:

```
for tenant in data/tenants/*; do
  node tools/backup.mjs --data "$tenant" --to "backups/$(date +%F)/$(basename "$tenant")"
done
node tools/backup.mjs --data data --to "backups/$(date +%F)/registry"
```

The registry holds no documents and no plaintext — it is accounts, host names and subscription state — but a
restore needs it, or every practice is a directory nobody can sign in to.

Copies the registry's `saas.db` alongside the tenants, and `--verify` each one. A directory of practices where
one failed verification is a directory where one practice has silently lost files, and the way to find out is to
check, not to hope.
