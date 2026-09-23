/**
 * Who can do what.
 *
 * The whole model is four short tables in one file, because a permission system that has to be assembled
 * by reading fifteen handlers is a permission system nobody can audit — including the person who wrote it,
 * six months later.
 *
 * ## The three roles, and why there are three
 *
 * A practice of two needs none of this. A practice of twenty wants to hand the chasing to somebody who
 * should not be reading bank statements, and wants the keys to stay with the person who answers for them.
 * Those are the two real boundaries, and they produce three roles rather than a menu:
 *
 *   owner       The person who answers for the firm. Everything, including who else is in it and the
 *               keys that open every document.
 *   accountant  The client work: requests, links, chasing, and reading what arrives.
 *   assistant   Coordination without reading. They can ask a client for a document, chase it, and see
 *               what is outstanding — **and they cannot open the documents themselves.**
 *
 * The assistant role is the one worth explaining, because it is the one a competitor cannot copy without
 * giving up their architecture. In every other product "cannot open the files" is a rule the software
 * agrees to follow: the server has the plaintext and is choosing not to show it, so the permission is a
 * promise. Here it is a fact. Files are sealed to the practice's public key, and a wrapping of the private
 * key is what opens them — and wrappings belong to **members**, not to the practice
 * (`key_wrapping.practitioner_id`, and `docs/members.md`). A member with no wrapping holds nothing that
 * opens anything, so "this person cannot read what the client sent" is enforced by the same mathematics
 * that keeps the server out. There is no setting to get wrong and no bug that can undo it.
 *
 * ## Two roles are deliberately absent
 *
 * **Read-only.** The obvious fourth role, and it has not earned its place. An assistant who can chase a
 * client is more useful than a seat that can only look, and "look but change nothing" is a need nobody in
 * this product's research named. If a firm asks for it, it is one line in `RANKS` — but inventing it now
 * would be inventing a role to fill a slot in a table.
 *
 * **A role that cannot see a client.** Every member of a practice sees the board. Somebody who cannot see
 * that a document is outstanding cannot help collect it, and the board holds no document contents — only
 * labels and dates. Hiding one client from one colleague is a different feature with a different name (a
 * caseload, not a permission), and it is not this.
 */
export const ROLES = ['assistant', 'accountant', 'owner'];

/** Higher wins. A route names the least a member needs, and the check is one comparison. */
const RANKS = { assistant: 1, accountant: 2, owner: 3 };

export const ROLE_WORDS = {
  owner: 'Owner',
  accountant: 'Accountant',
  assistant: 'Assistant',
};

/** One line each, for the picker on the members page. The trade, not the job title. */
export const ROLE_BLURBS = {
  owner: 'Everything: the client work, the keys, and who else is in the practice.',
  accountant: 'The client work — including opening what clients send.',
  assistant: 'Can ask for documents and chase them, but cannot open what comes back.',
};

/**
 * What a nothing-in-this-column means, and the project's convention: the behaviour before the column
 * existed. Before roles, every member could do everything, so that is what an absent role reads as.
 *
 * It applies to a fresh sign-up too — the person who created the practice is its owner, and the column is
 * set explicitly there rather than left to mean it.
 */
export const DEFAULT_ROLE = 'owner';

/**
 * A member's rank, with corruption reading as capable rather than as downgraded.
 *
 * An unrecognised value can only arrive by somebody hand-editing the database, and both possible readings
 * are wrong in some way. Failing *closed* would silently strip a member of access to a practice's records
 * — a thing they would notice only later, and only if it was them. Failing open restores exactly what
 * every member had before roles existed. The second is the recoverable mistake, so it is the one made.
 */
const rankOf = (role) => RANKS[role] ?? RANKS[DEFAULT_ROLE];

/** Whether this member's role is enough for something that needs `minimum`. */
export const roleMeets = (role, minimum) => rankOf(role) >= rankOf(minimum);

/** A role name that is safe to show, for a value that should not be corrupt but is. */
export const roleName = (role) => (ROLES.includes(role) ? role : DEFAULT_ROLE);

/** Whether this role holds a copy of the practice key. The assistant is the one that does not. */
export const holdsKey = (role) => roleMeets(role, 'accountant');

/**
 * The addresses that are not "any signed-in member", written as shapes rather than as a list of routes.
 *
 * The route table carries a role on the routes that need one, and `test/roles.test.js` walks that table
 * and fails if an address matching one of these has no role. That is the piece that keeps this
 * maintainable: a new route under `/members` cannot be added without somebody deciding who may use it,
 * because the test refuses to pass until they have.
 *
 * The last two are the ones a prefix rule would miss and which matter most. A client’s document does not
 * live under `/files` — it hangs off the request it answers, at `/requests/:id/files/:fileId` — and the
 * review loop is spelled out per item. Neither is an "area", and both are exactly the things an assistant
 * must not be able to do, so they are named by shape here rather than left to a list somebody has to
 * remember to update.
 */
export const SENSITIVE_PATTERNS = [
  /^\/setup$/, // making or rotating the key that opens every document in the practice
  /^\/members(\/|$)/,
  /^\/keys(\/|$)/,
  /^\/admin(\/|$)/,
  /^\/files(\/|$)/,
  /\/files\//, // a client’s document, wherever it hangs — matches the pattern text and a real address alike
  /\/check(-all)?$/, // saying a document has been looked at
];

/** A route's path as text, whether it is a fixed string or a pattern. */
export function routePath(path) {
  if (typeof path === 'string') return path;
  return String(path)
    .slice(1, -1)
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/');
}

/**
 * Whether an address is one that must declare who may use it.
 *
 * The list has grown twice, and the second growth is the one worth noting: the per-request document address
 * hangs off `/requests/…/files/…` rather than under `/files`, so a prefix rule alone would have missed a
 * client's actual documents. Patterns rather than prefixes, for that reason.
 */
export const isSensitive = (path) => SENSITIVE_PATTERNS.some((pattern) => pattern.test(routePath(path)));


/**
 * What a member is told when they reach for something they cannot have.
 *
 * Deliberately specific about *why*, because the honest answer here is informative rather than secret: an
 * assistant who cannot invite members is not being kept in the dark about anything, they are being told
 * whose job it is. The case that matters most is the key, and it says so plainly — a permission that
 * explains itself is a permission people do not spend a fortnight trying to work around.
 */
export function refusalFor(needed, role) {
  if (needed === 'owner') {
    return `That one is the owner's: the keys, the members, or how the practice itself works. Yours is ${ROLE_WORDS[roleName(role)].toLowerCase()}.`;
  }
  if (needed === 'accountant') {
    return 'That needs a member who holds the practice key, and you do not hold a copy. Ask an owner for one — they will need a passphrase from you to do it.';
  }
  return 'That is not something your role can do.';
}

