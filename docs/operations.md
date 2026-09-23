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

**Hosting several practices?** `tools/backup-all.mjs` does all of the above for every one of them, and the registry
that names them, in one command with each practice verified as it goes. See *Multi-tenant installs* at the bottom of
this file.

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

**This whole shape is drilled on every run.** `test/backup.test.js` takes a backup while the server is
running, deletes the original, performs these steps, and decrypts a document out of the result — step
5 automated, which is the only end-to-end proof that the key, the envelope and the bytes all came
across. It also proves `--verify` has teeth and that backups are never overwritten. If that test is
red, nothing in this section is true any more.

**The multi-tenant version is drilled too.** `test/backup-all.test.js` builds a registry with two practices, each
holding a real encrypted document, takes the whole fleet, verifies it, and decrypts a document out of one practice's
copy. It also proves the things a fleet adds: that a practice the registry has forgotten is still backed up, that one
broken practice is named rather than claimed and does not cost the others their backup, and that a run interrupted
before `fleet.json` was written is refused from the top.

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

## Upgrading

**There is nothing to install and nothing to compile.** No dependencies is not a slogan here — it means an upgrade
cannot break on a transitive package, and it means the steps are short enough to read.

```
node tools/backup.mjs --data data --to /wherever/backups/before-upgrade   # and --verify it
git pull                       # or unpack the new release over the old one
node src/server.js
```

Then **read the lines the server prints.** It says its version and what the schema did:

```
tickmark 0.2.0 listening on http://localhost:3000
schema:   up to date, no migration needed
```

or

```
schema:   upgraded — 2 columns added, 1 files reattached to their requests. Nothing was deleted.
```

Migrations run at startup, are idempotent, and are written to be checked rather than trusted: the ones that
rebuild a table verify their own row counts and **refuse to run** rather than finish with a row missing, because a
database that will not open is recoverable and a file nobody can find is not. That is also why the report is
printed rather than logged quietly.

**Which version is running is answerable without signing in:**

```
curl localhost:3000/healthz
{"ok":true,"version":"0.2.0","practices":1}
```

**Downgrading is not supported.** Migrations only go forwards, and a database that has been through a rebuild is
not readable by the release before it. If an upgrade goes wrong, restore the backup from step one — which is why
that step is first.

## Multi-tenant installs

With `MULTI_TENANT=1`, `data/` holds a registry database and a directory per practice:

```
data/saas.db            the registry: accounts, tenants, host names
data/tenants/<id>/tickmark.db
data/tenants/<id>/blobs/
```

**Each practice is backed up separately, and all of them in one command:**

```
node tools/backup-all.mjs --data data --to /wherever/backups/2026-09-23
node tools/backup-all.mjs --verify /wherever/backups/2026-09-23
```

That walks every directory under `data/tenants` that holds a database, takes each practice's backup, **verifies it
before moving to the next one**, then takes the registry, and finally writes `fleet.json` — the file that says which
practices this backup holds. `node tools/backup.mjs --verify` checks a fleet backup too, from the top, so you do not
have to remember which tool checks which kind.

The reasons for the shape, in the order they matter:

- **The registry is included, and a shell loop could not do it.** The registry holds no documents and no plaintext —
  accounts, host names and subscription state — but without it every practice is a directory nobody can sign in to.
  `tools/backup.mjs --data data` looks for `data/tickmark.db`, which a multi-tenant install does not have, so the
  loop this file used to give would have failed on its last line every time.
- **A practice is backed up because its directory has a database in it, not because the registry mentions it.** A
  tenant the registry has forgotten still has a practice's documents in its directory, so it is taken, and the
  discrepancy is reported so somebody looks at it.
- **One broken practice does not stop the run, and is never quietly claimed.** Every practice is verified as it
  goes. A practice that fails is named, the rest are still taken, and it is **left out of `fleet.json`** rather than
  counted as a success.
- **`fleet.json` is written last, so an interrupted run is refused rather than mistaken.** A directory with fifty
  verified practices and no `fleet.json` is not a fleet backup, and both tools say so. That is the same rule as a
  practice's own manifest, one level up.
- **Free re-take for one practice:** `--only <id>` backs up a named practice into a fresh directory, which is how
  one failed practice is re-taken without rewriting the backup you already have.

**Restoring a fleet** is restoring one practice at a time — each practice's directory in this backup *is* a complete
copy of that practice, in the layout `data/tenants/<id>/` expects — plus the registry's `saas.db` into `data/`, or
nobody can sign in to any of them. Restore the practice whose day is on fire first, and take your time over the
rest.
