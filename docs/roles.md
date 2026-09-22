# Who can do what

A practice of one has no need of this document. A practice of twenty has an office manager who chases
clients, and a question: *should the office manager be able to open a client's bank statement?*

The answer is no, and this product can say it in a way a permission checkbox cannot.

## The three roles

| Role | The client work | Opening what arrives | The keys, the members, the practice itself |
| --- | --- | --- | --- |
| **Owner** | yes | yes | yes |
| **Accountant** | yes | yes | no |
| **Assistant** | yes — ask, chase, record a call, issue a link | **no** | no |

A route names the least a member needs, in the same table as the address:

```js
['GET', '/members', membersPage, 'owner'],
['GET', /^\/requests\/([^/]+)\/files\/([^/]+)$/, serveEnvelope, 'accountant'],
```

One comparison, and the whole model reads off one screenful. The alternative — a check inside each handler —
is a system nobody can audit, including the person who wrote it.

## Why the assistant role is real rather than decorative

In every other product in this space, "cannot open the files" is a rule the software agrees to follow. The
server holds the plaintext and is choosing not to show it, so the permission is a **promise**: it survives
exactly as long as the code is correct, the administrator is honest, and nobody has a bug.

Here it is a **fact**. Files are sealed to the practice's public key, and what opens them is a wrapping of the
private key — and wrappings belong to *members*, not to the practice (`key_wrapping.practitioner_id`, and
[members.md](members.md)). An assistant has no wrapping. They hold nothing that opens anything.

That means:

- There is no setting to get wrong.
- There is no query that could return the plaintext to them, because the plaintext does not exist on the
  server at all.
- An operator with the database — including us, hosting it — cannot grant them access, because granting it
  would mean handing over a key they do not have.

The permission is enforced by the same mathematics that keeps the server out. That is the entire reason the
role is worth having, and it is why the refusal message says *"you do not hold a copy"* rather than *"you are
not allowed"*.

## Two roles deliberately absent

**Read-only.** The obvious fourth role, and it has not earned its place. An assistant who can chase a client is
more useful than a seat that can only look, and "look but change nothing" is a need nobody in the research
named. If a firm asks for it, it is one line in `RANKS` — inventing it now would be filling a slot in a table.

**A role that cannot see a client.** Every member sees the board. Somebody who cannot see that a document is
outstanding cannot help collect it, and the board holds no document contents — only labels and dates. Hiding
one client from one colleague is a different feature with a different name (a caseload, not a permission).

## What an assistant can actually do

Worth being concrete, because "coordination without reading" sounds thinner than it is:

- add a client, and make a request against them
- issue a link and send the opening ask
- chase, on the cadence, and draft or send reminders
- **record a phone call** (`request.contacted`) — the work that happens when email has failed
- see the whole board, every state, every count, who is overdue and who has answered
- use templates and ask everyone at once
- close and reopen requests
- say that a document needs re-sending, and why

What they cannot do: open a client's file, say a document has been *checked*, rotate the key, change who else
is in the practice, or rename it.

The line between "asks for it" and "says they have looked at it" is the interesting one. An assistant who
chased a client and received a file has done their job, and the judgement of whether the file is any use
belongs to somebody who can open it. So `check` is refused to them by name, in the handler rather than the
route, because the route serves four actions and only one of them is theirs.

## Changing a role

An owner changes it on the members page, and **a demotion destroys that member's copies of the key**
(`endSessionsFor`, and the wrappings). That is the point rather than a side effect: a demotion that left the
key in their possession would not be a demotion.

Two guardrails:

- **The last owner cannot demote themselves.** A practice with nobody who can reach the keys is a practice
  that cannot recover a member, and the refusal says so rather than silently doing nothing.
- **A role is read from the session**, so a demotion takes effect at the next request rather than at the next
  sign-in — which matters, because the member is still signed in when it happens.

## What is not finished

**Inviting somebody straight in as an assistant.** The database supports it — `invite.role`, and a nullable
sealed key with a `CHECK` that refuses a half-keyed row — and the handler reads the role. But the browser form
(`web/members.js`) always seals a key, so an assistant invitation cannot be made from the UI yet. Today the
path is: invite normally, then change the role on the members page, which destroys the key copies they have
just been given.

That is a two-step workaround rather than a missing capability, and it is written here rather than left to be
discovered. The work is small: a role choice on the invite form, no sealing when it is *assistant*, and a
`LEFT JOIN` in `inviteByToken`, which currently joins `practice_key` innermost and would report a keyless
invitation as an unknown address.
