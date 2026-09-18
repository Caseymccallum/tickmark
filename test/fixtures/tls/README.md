# The TLS fixtures

Three files that exist so the mail client's TLS paths can be tested without a network:

| File | What it is |
| --- | --- |
| `ca.pem` | A throwaway certificate authority |
| `cert.pem` | A server certificate for `localhost` and `127.0.0.1`, signed by `ca.pem` |
| `key.pem` | Its private key |
| `wrong-name-cert.pem` | A second certificate signed by the same CA, for `wrong.example` only |
| `wrong-name-key.pem` | Its private key |

## These are not secrets, and they must never be used for anything

**Every private key here is public.** They are committed deliberately, and that is safe for exactly one
reason: **the CA's own private key was deleted after these two certificates were signed.** No key in
this repository can sign another certificate, so nothing here can be used to impersonate anything.

They are also valid for a hundred years, so the tests will not start failing in 2027 for a reason that
has nothing to do with the code.

Do not point a real relay at them. Do not add them to a trust store. If a TLS test ever needs a new
certificate, regenerate a new CA, sign what is needed, and delete the new CA key the same way — the
commands are in this file's history, not in the code.

## Why the second, wrongly-named certificate exists

`wrong-name-cert.pem` is the one that makes the interesting test possible. A certificate that *should*
fail is the only way to tell "the client verified the name" apart from "the client did not check",
because a successful connection proves nothing on its own.

It matters because the mailer sends no SNI when the relay is addressed by IP address — Node refuses an
IP as `servername` — so a reader could reasonably assume the name check is skipped. It is not: Node
verifies the certificate against the address it dialled. `test/mail-tls.test.js` holds that.