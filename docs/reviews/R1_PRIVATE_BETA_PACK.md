# Private beta pack — for a small accounting or bookkeeping practice

Everything here assumes one thing: **a practice that sends the same document requests every year and is tired of
chasing by email.** It is not a general document manager, and the beta is not a test of whether it could be.

No feedback in this pack was invented. The measures in §10 are what to *capture*, not results.

---

## 1. Onboarding, unaided

The beta's first question is whether somebody can do this without you on the phone. Print this and say nothing.

1. Open the address you were sent. You should see a welcome page, not a sign-in form.
2. Make an account. The address you type is the one your clients will see your messages from, so use your practice
   address rather than a personal one.
3. You will be asked to confirm the address — the email is from *your* server, so check spam once and mark it as not
   spam.
4. The first thing you are asked to do is choose a **passphrase**. Read the panel, then choose one and write it down
   somewhere that is not the machine you are using.
5. You will be shown a **recovery sheet**. Print it, or write the codes down. This is the only copy.
6. Make your first request: a client, a title, and the documents you want, one per line.

If step 4 or 5 did not make sense, stop and say so — that is the most useful thing you can tell us.

**Time to expect:** ten minutes, once. There is nothing to install on your machine and nothing for your client to
install either.

---

## 2. Asking a client for documents

1. **Requests → New.** Choose a client, give it a name a client would recognise ("2025 annual accounts", not "Q1 docs"),
   and list the documents one per line.
2. **Send the request.** If your server has a mail relay configured you can send it from Tickmark; if not, copy the
   message and the link into whatever you already use. Both are supported, and the page says which you have.
3. **The client gets a link.** No account, no password, no app. They open it on a phone, see the checklist, and take a
   photo or pick a PDF for each line.
4. **Watch the board.** Each line shows *still needed*, *you said…*, or *received*. You do not have to remember what is
   outstanding; that is the point.
5. **Chase only what is missing.** "Draft a reminder" writes a message that names only the outstanding items.
6. **When it is all in**, open the request, unlock with your passphrase, and either save each document or **Download
   everything** as one archive.

Two things worth saying out loud to a client, because they are the reason this works: the link needs no account, and
nothing they send is readable by the server — it is locked in their browser, to your practice's key.

---

## 3. Encryption, in plain English

Your documents are encrypted **in the browser, before they are sent**. The server stores a locked box. It has no key.

- **What the server can see:** file names, sizes, dates, who sent what to which request, and the client names on your
  board. Not contents.
- **What unlocks them:** your passphrase, which never leaves your browser, plus the key record on the server.
- **Losing the passphrase:** you cannot open documents. The **recovery sheet** you were given at setup is the way back.
  If that is lost too, the documents sealed to that key are unreadable — by you and by us. That is what end-to-end
  encryption means; there is nobody to ask.
- **Changing the passphrase** re-wraps your key. It does not change the documents.
- **If you lose a member's key copy** — they left, their laptop died — the documents are still readable by *you*, and by
  anyone else who holds a copy. That is the reason the members page shows who holds one.
- **What this does not protect against:** a compromised laptop with your passphrase typed into it, or malicious code
  running in the page. Encryption protects data at rest and in transit, not a machine that has already been taken over.

---

## 4. Data custody, in plain English

- **Where it lives:** on the server you (or your operator) run — one directory, holding a database and the encrypted
  files.
- **Who can read a document:** a member of your practice who holds a copy of the key *and* knows the passphrase. Nobody
  else, including whoever runs the server.
- **What the operator can see:** the same metadata as above, plus access logs. Not contents.
- **Your clients' data:** it is yours. Export exists; the `.zip` of a request is the documents themselves; the database
  is ordinary SQLite.
- **Deleting:** closing a request does not delete documents. Removing a practice's data is an operator action, and the
  deletion tools leave a tombstone so a restore does not resurrect what was deliberately removed.

---

## 5. Self-hosting: what a practice actually needs

| Need | Detail |
| --- | --- |
| A machine | Any small Linux box, or a container host. Two cores and 2 GB is plenty for a practice's year. |
| Node | **24 or newer.** No dependencies to install: `dependencies` is empty, deliberately. |
| Disk | Documents dominate. A year of a small practice is usually a few GB. Leave room for two backups. |
| TLS | Terminate at a reverse proxy (Caddy, nginx, Traefik). Set `TICKMARK_PUBLIC_URL` to the public address. |
| Mail | Optional. Without a relay, Tickmark drafts and you send. With one, it sends. |
| Backups | A second machine, and the two commands in §7. |
| Secrets | The SMTP password stays in the environment, never in the data directory. |

**Not needed:** a database server, a message queue, a cache, an object store, a build pipeline, or a front-end framework.
One Node process and one directory.

---

## 6. Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| "That form came from another site" | A form was posted from a foreign origin and the server refused it | Open Tickmark in its own tab. If it happens in normal use behind a proxy, `TICKMARK_PUBLIC_URL` is probably unset or wrong |
| An integration "is not set up on this install" | No OAuth app configured — a state, not a fault | Set the client id and secret, or ignore it and use the CSV import |
| "That passphrase does not open any of this practice's keys" | Wrong passphrase, or a rotated key | Try the recovery sheet. Files sealed to an older key need the older passphrase |
| "… of 2 keys unlocked" | The passphrase opened some keys but not all | Expected after a passphrase change; files under the other key will not open |
| A download says "could not be opened" | The envelope is damaged, or sealed to a key this tab does not hold | Unlock every key, then **Download everything**. If it still fails, the backup is the source |
| "Nothing was packed" | One document could not be opened, so the archive was abandoned | Deliberate: a half-archive is worse than an error |
| A member's role says "Unrecognised" | A database value this version does not understand | The members page warns you; set a real role on that row |
| Email never arrives | No relay, wrong relay, or a spam verdict | `node tools/smtp-transcript.mjs`, then check the mailbox and the DNS records |
| The server will not start after an upgrade | Migrations are forward-only | Restore the backup you took first — that is why it is step one |

---

## 7. Backup checklist for a practice

**Nightly** (the operator's job, but you should know it happens):

```
node tools/backup.mjs --data <data> --to <elsewhere>/<date>
node tools/backup.mjs --verify <elsewhere>/<date>
```

**Once a quarter,** prove a restore on a copy and decrypt one document out of it. A backup nobody has restored is a hope.
`docs/reviews/evidence/r1-restore-drill.mjs` is the automated version: it backs up, restores into a fresh directory and
decrypts a document, and should print 12/12.

---

## 8. Test plan with fictional documents

Before a real client is involved. Twenty minutes, and it exercises every path that has ever broken.

| # | Step | What should happen |
| --- | --- | --- |
| 1 | Make a practice called "Test Practice" with a made-up address | Welcome page, then setup |
| 2 | Choose a passphrase; print the recovery sheet | Shown once; you are told it is the only copy |
| 3 | Add a client "Fictional Ltd" with a made-up email | Client appears, no requests yet |
| 4 | Create a request with three documents | Board shows three still needed |
| 5 | Open the client link on a **phone** | Checklist renders; no sign-in asked for |
| 6 | Photograph any object for one line | The line becomes received |
| 7 | Send a PDF for another line, plus an extra "not asked for" file | Both arrive; the extra is listed as the client's own |
| 8 | Use "I'll send it later" on the third line | Records what the client said; still outstanding |
| 9 | Draft a reminder | Names only the outstanding item |
| 10 | Unlock and download one file | Opens; the name matches |
| 11 | Download everything | One archive holding the files you sent |
| 12 | Type a wrong passphrase | Refused with a sentence; nothing saved |
| 13 | Reuse the checklist for a new client | A new request with the same three lines |
| 14 | Close the request | Leaves the open board, stays findable |
| 15 | Point another practice at the request id | Nothing: another practice cannot see it |
| 16 | Revoke the client link, then open it | Refused, with an explanation |

Any step that needed you to explain something is a finding. Write down which one.

---

## 9. Real-device accessibility checklist

Nobody in this milestone used a screen reader or a physical device, so this is a checklist rather than a result. On the
oldest phone and the smallest laptop you have:

- [ ] Every control is reachable by keyboard alone, with a visible focus ring
- [ ] Tab order follows the page, and the skip link works
- [ ] Zoom to 200% does not clip a primary control
- [ ] The client page works at 320 px wide without the *page* scrolling sideways (a table may scroll in its own box, and now shows an edge)
- [ ] A screen reader announces the file input as "Upload one or more files for: *document name*", not "choose file"
- [ ] Status messages ("Saved…", "Nothing was packed") are announced without moving focus
- [ ] The passphrase panel announces itself as a disclosure, and opens by itself when a save needs it
- [ ] Colour is never the only signal: state badges carry words
- [ ] Dark mode keeps body text legible
- [ ] A photo taken in the field uploads, and progress is visible

---

## 10. The feedback that decides the next milestone

Ask these six, and record the four numbers. Do not ask "do you like it" — it produces politeness.

| Measure | How to capture it | What would be encouraging |
| --- | --- | --- |
| **1. Onboarding unaided** | Did they finish §1 with no help? | yes, and where they stopped if not |
| **2. Clients upload unaided** | Count requests where the client sent everything with no phone call | more than half |
| **3. Chase cycles per request** | reminders drafted ÷ requests sent | fewer than they do today |
| **4. Review is convenient** | "Was finding and opening what arrived easier than your current way?" | yes, without a hedge |
| **5. Would use again next year** | Asked once, after a real season | yes |
| **6. Willingness to pay** | "If this were £X a month, would you keep it?" — with a number, never in the abstract | a number, not a nod |

**Record the number, not the adjective.** "Three practices, one completed onboarding unaided, two clients uploaded
without a call, 0.7 reminders per request" is a result. "Positive feedback" is not.

Do not run outreach for this without the owner's approval, and do not treat a beta practice's politeness as commercial
validation.
