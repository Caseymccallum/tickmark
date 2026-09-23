/**
 * Enough of a browser to run the modules in `web/` inside the test runner.
 *
 * **This file is not a test, and `npm test` does not run it** — the script names the test files explicitly for the
 * reason `test/helpers.js` records.
 *
 * ## The gap this closes
 *
 * `web/tickmark-crypto.js` has always been tested directly: it is a module over Web Crypto, which is the same API in
 * Node as in a page, so `test/crypto.test.js` runs *the* implementation rather than a second one written to agree
 * with it. What was never run is the glue around it. `upload.js` and `download.js` read elements, wait for clicks and
 * hand bytes to the browser — and every one of those lines was only ever asserted to be **served**, which a file can
 * be, be perfectly valid, and still encrypt nothing.
 *
 * ## Why hand-written rather than a headless browser
 *
 * The same reason the SMTP client and the ZIP reader are: no dependency. CI deliberately installs nothing (see
 * `.github/workflows/ci.yml`), and a test run is not a good place to make an exception to the property that keeps
 * this project's supply chain short enough to read.
 *
 * It is partial on purpose, and **loud about it**: anything these pages touch that is not here throws, so a module
 * that grows a new DOM call fails visibly rather than passing quietly.
 *
 * One cost, stated rather than discovered later: a cache-busting query makes every load a **separate module
 * instance**, so `npm run coverage` counts each instance on its own — a page driven by five scenarios reads as five
 * partially-covered files rather than one well-covered one. Isolating the scenarios is worth more than a tidy
 * percentage, but the number should be read knowing that.
 */

/** An element with the little of the DOM these two pages use. Nothing more. */
function element({ children = {}, ...fields } = {}) {
  const listeners = new Map();
  return {
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
    files: [],
    classList: { toggle() {}, add() {}, remove() {} },
    querySelector: (selector) => children[selector] ?? null,
    querySelectorAll: () => [],
    addEventListener(kind, handler) {
      listeners.set(kind, [...(listeners.get(kind) ?? []), handler]);
    },
    /**
     * Everything registered for `kind`, in order, awaited — both pages listen with async functions.
     *
     * Events do **not** bubble here, which is the one place this shim is quietly different from a browser: fire the
     * element the page actually listens on. (`upload.js` listens for `change` on the file input, not the form.)
     */
    async fire(kind, event = {}) {
      if (event.preventDefault === undefined) event.preventDefault = () => {};
      for (const handler of listeners.get(kind) ?? []) await handler(event);
    },
    appendChild() {},
    remove() {},
    click() {},
    ...fields,
  };
}

/**
 * Every load gets its own module instance, and the number is **module-scoped rather than per-installer**: two tests
 * that each installed a browser would otherwise both ask for `?browser=1`, get the same cached module, and share its
 * state — an unlocked key from one test leaking into the next.
 */
let loads = 0;

/**
 * Install a document holding what `web/upload.js` and `web/download.js` look for, and hand back the handles a test
 * needs to drive them: the elements to fill in, the buttons to press, and what the page then did.
 *
 * `load` is a cache-busting import, because a module reads its elements once at import time and each scenario needs
 * its own instance of it. The query string is what makes two imports of the same file two modules.
 */
export function installBrowser({
  publicKey = null,
  keyId = null,
  wrappedKey = null,
  maxBytes = null,
  alreadySent = null,
  files = [],
  fetch: respond = null,
} = {}) {
  const sent = [];
  const saved = [];
  const revoked = [];
  const reloads = { count: 0 };
  const blobs = new Map();
  const timers = pageTimers();

  const uploadStatus = element();
  const fileInput = element({ files });
  const sendButton = element();
  const noteField = element({ value: '' });
  const uploadForm = element({
    action: '/r/a-token/upload',
    children: {
      '.status': uploadStatus,
      'input[type=file]': fileInput,
      'button[type=submit]': sendButton,
      'input[name=note]': noteField,
    },
  });

  const passphrase = element();
  const unlockButton = element();
  const unlockStatus = element();
  const saveStatus = element();
  const saveButton = element({
    dataset: { name: 'statements.pdf', url: '/files/one/download' },
    parentElement: element({ children: { '.status': saveStatus } }),
  });

  const document = {
    getElementById: (id) =>
      ({
        'practice-key': publicKey && element({ textContent: JSON.stringify({ keyId, publicKey }) }),
        'upload-limit': maxBytes === null ? null : element({ textContent: JSON.stringify({ maxBytes }) }),
        'already-sent': alreadySent === null ? null : element({ textContent: JSON.stringify(alreadySent) }),
        'key-records':
          wrappedKey === null ? null : element({ textContent: JSON.stringify({ keys: [{ wrapped: wrappedKey }] }) }),
        passphrase,
        unlock: unlockButton,
        'unlock-status': unlockStatus,
      })[id] ?? null,
    querySelectorAll: (selector) =>
      selector === 'form.upload' ? [uploadForm] : selector === 'button.save' ? [saveButton] : [],
    createElement: (tag) => {
      const node = element({ download: '', href: '' });
      // Clicking the anchor *is* the download: this is where a saved file is caught, holding the bytes the page put
      // into the blob rather than the ciphertext the server holds.
      if (tag === 'a') {
        node.click = () => saved.push({ name: node.download, url: node.href, blob: blobs.get(node.href) ?? null });
      }
      return node;
    },
    body: element(),
  };

  const url = {
    createObjectURL: (blob) => {
      const href = `blob:test/${blobs.size + 1}`;
      blobs.set(href, blob);
      return href;
    },
    revokeObjectURL: (href) => revoked.push(href),
  };

  const fetcher = async (target, options = {}) => {
    const request = { url: String(target), ...options };
    sent.push(request);
    if (!respond) throw new Error(`the page fetched ${target}, and this test gave it nothing to answer with`);
    return respond(request);
  };

  return {
    sent,
    saved,
    revoked,
    reloads,
    timers: timers.scheduled,
    uploadForm,
    uploadStatus,
    fileInput,
    sendButton,
    noteField,
    passphrase,
    unlockButton,
    unlockStatus,
    saveButton,
    saveStatus,
    load(path) {
      Object.assign(globalThis, {
        document,
        URL: url,
        fetch: fetcher,
        setTimeout: timers.setTimeout,
        location: { reload: () => { reloads.count += 1; } },
      });
      loads += 1;
      return import(`${path}?browser=${loads}`);
    },
  };
}

/**
 * A `setTimeout` for the pages: it schedules for real, and then unrefs anything long.
 *
 * One line in `download.js` releases the object URL **sixty seconds** after a save, with a comment saying why
 * (revoking at once cancels the download in some browsers). Left alone, that single timer would hold the test process
 * open for the whole minute. So it is scheduled for real — the page's behaviour is not faked — and then `unref`'d,
 * which stops it keeping the process alive without changing what it does. The delay is recorded so that a test
 * *asserts* it rather than waits for it, which is the better test anyway.
 */
function pageTimers() {
  const scheduled = [];
  const real = globalThis.setTimeout;
  return {
    scheduled,
    setTimeout(fn, ms, ...rest) {
      const handle = real(fn, ms, ...rest);
      if (ms >= 1000) {
        scheduled.push({ ms, fn, handle });
        handle.unref?.();
      }
      return handle;
    },
  };
}

