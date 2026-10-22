# Tickmark interactive demonstration

This is a **private local demonstration**, for founder-led walkthroughs with fictional information. It is not a hosted trial, paid service, or approval to use real client material. The launcher binds to `127.0.0.1` only. It starts the regular single-practice Tickmark app with an isolated temporary database and encrypted-blob directory; it does not start the hosted gateway or configure billing, email, or SMS.

## Start and sign in

Use Node.js 24 or newer from the repository checkout:

```powershell
npm run demo
```

The command creates a new `tickmark-demo-*` folder under the operating system's temporary directory, seeds it through the normal application HTTP routes, and launches the application on `http://127.0.0.1:3000`. If that port is occupied, choose another local port before launch:

```powershell
$env:TICKMARK_DEMO_PORT = '3319'
npm run demo
```

The terminal prints fresh owner and assistant passwords, a practice-key passphrase, the guide URL, a client link, and paths to the sample PDFs. Treat those credentials and links as temporary bearer credentials; do not paste them into public channels. Sign in at the guide's workspace link with the printed owner account. The one-time invitation is already accepted for the fictional assistant account.

All names and email addresses use clear `FICTIONAL` labels and the reserved `.invalid` domain. The generated PDFs say that they contain no real financial data. The browser-side key is generated for this run. The app stores the seeded upload envelopes as ciphertext; it does not store the sample PDF bytes as uploads.

## Walkthrough

Open the printed `/demo` guide, then:

1. Sign in and inspect the practice request board. The examples include an outstanding checklist, an arrival awaiting review, a completed request, and a past-due replacement request.
2. Open Rowan Northstar's request and accept the sample arrival using the normal practice review action.
3. Open Morgan Meadow's client link in a separate browser tab. Select one of the printed fictional sample PDF paths and submit it. The client portal's regular upload module encrypts the file in the browser and shows its receipt; `/assets/preflight.js` is part of the regular allowlist.
4. Return to Morgan's request in the practice workspace, confirm the new arrival is awaiting review, and accept it.
5. Use **New request** to create another fictional checklist. The normal request form creates the associated client record; a fictional year-end template is also preloaded.
6. Open **Chase** to preview reminders. Sending is unavailable because no mail or SMS service is configured. Templates can be inspected from workspace navigation; existing requests can be raised again through the normal request actions.

The seeded sample PDFs are local files in the printed `samples` directory, so the client upload journey uses the native file picker. They are deliberately simple, synthetic, and harmless.

## Reset and cleanup

Stop the server with Ctrl+C. Copy the exact printed demo-data path and pass it to the reset command:

```powershell
npm run demo:reset -- 'C:\Users\<you>\AppData\Local\Temp\tickmark-demo-<generated-suffix>'
```

Reset accepts only a direct child of the operating-system temporary directory with the Tickmark demo prefix and a matching marker created by the demo seeder. A live launcher holds a PID lock, so reset refuses to remove its open database; an abandoned lock is cleared only after its process is confirmed gone. Reset also refuses directories reached through a symlink and refuses to delete a tree containing a symlink or junction. It never chooses a default path or uses a wildcard. If it refuses, inspect and remove the exact temporary folder manually after confirming it contains only this demo. The seed-only command, `npm run demo:synthetic`, also writes to a fresh marked temporary directory by default; provide an exact new `tickmark-demo-*` direct-child path to choose another one.

Generated credentials, databases, blobs, and sample PDFs stay outside the checkout. The script does not read `.env`, `.env` billing credentials, or production data. Do not aim `demo:reset` at any ordinary application data directory.

## Public mode

No public interactive instance is included. A shared writable demo would need per-visitor isolation, storage and request quotas, abuse/rate controls, bounded session lifetime, automated deletion, safe token handling, operational monitoring, and an independently validated hosting boundary. A read-only preview still has to prove that every mutation path is unavailable and that visitors cannot read another visitor's state. Both choices add deployment, abuse response, and ongoing maintenance work; fictional seed data alone is not an isolation control.

The marketing source therefore says **“Interactive demonstration coming soon.”** A static link is emitted only when a release builder explicitly supplies both `TICKMARK_PUBLIC_DEMO_APPROVED=1` and a valid HTTPS origin in `TICKMARK_PUBLIC_DEMO_URL`. The build refuses paths, credentials, queries, and fragments, and uses `rel="noreferrer"`. This is a founder-controlled gate, not proof that an endpoint is safe or functioning. Verify its isolation, expiry, quotas, deletion and monitoring independently before enabling it; no public mode or public endpoint has been tested or deployed by this change.

## Verification record

- `npm test`: 565 passed, 0 failed.
- `npm run coverage`: all tests pass, but the unchanged gates still fail at 91.49% lines (93% required), 88.86% functions (90% required), and 74.41% branches (75% required). The demo added meaningful production code and test coverage; it does not claim to close the repository's wider coverage gap.
- `npm run check:site`, `npm run check:style`, `npm run check:nav`, `npm run check:docs`, `npm run check:gateway`, `npm run snapshot`, and `npm run check:pages`: passed; the snapshot contains 42 pages.
- Marketing output was built with the default fallback and with a sample explicitly approved HTTPS origin. The approved CTA contains `rel="noreferrer"` and no bearer token or cookie data; the source build retains the coming-soon message.
- `git diff --check`: passed.
- Automated setup exercises the real signup, verification, practice-key setup, staff invitation, request, encrypted upload, replacement, and review HTTP paths using generated data.
- Blob checks assert the Tickmark encrypted envelope and absence of the synthetic PDF plaintext marker.
- Safe reset tests confirm that an unrelated path and an unmarked directory are refused.
- `npm run demo` binds explicitly to IPv4 loopback and sets `mailer: null` and `sms: null`; the standalone launcher does not load the SaaS gateway or Stripe provider.
- Browser automation could not initialize in this environment (`cua_repl` failed while writing its kernel assets); BrowserOS was listed as a skill but its MCP tools were not connected. No real-browser screenshots, file-picker interaction, viewport review, or browser-level upload receipt is claimed here. Existing repository browser-shim tests are not a substitute for that manual verification.
- Docker verification is not applicable to the local guided mode and no image or public environment was built or deployed.

## Limitations and next checks

The walkthrough uses the production UI and route handlers but the initial example states are seeded locally. The owner must sign in with the printed generated credential. Do not treat an open local client link as proof of the security of a hosted or publicly shared demo. The demo has no automatic timer-based cleanup: stop it and run the explicit reset command after the session.

Before considering a public demo, validate it on a disposable staging host with an independent visitor boundary, TLS, upload and total-storage caps, rate limits, session/token expiry, automatic cleanup, no live providers, and monitoring for errors and abuse. Test cross-session denial, reset and cleanup against the actual deployed storage. Public use remains separately gated on those controls and founder approval.
