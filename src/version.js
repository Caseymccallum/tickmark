/**
 * What version this is.
 *
 * Read from `package.json` rather than written here, so there is one place to change — and read at import
 * rather than hardcoded, so a release cannot be tagged with a number the software disagrees with. The Dockerfile
 * copies that manifest, so this works in a container as well as from a checkout.
 *
 * There is a fallback rather than a throw, because a version is not worth failing to start over: an operator
 * who has somehow lost their `package.json` needs the software running more than they need `/healthz` to be
 * precise about which build it is.
 */
import { readFileSync } from 'node:fs';

const read = () => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

export const VERSION = read();