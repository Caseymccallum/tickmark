/**
 * A cap on how often the same account may be guessed at.
 *
 * This is the one endpoint in the product a stranger can reach without a link, a token or an invitation, and
 * nothing was watching it. `docs/saas.md` lists "no rate limiting on `/login` or `/signup`" as a thing that
 * would bite before charging anybody; it bites a self-hosted install sooner than that, because a practice's
 * address is on the internet the moment their clients can upload to it.
 *
 * The bucket is the **account**, not the address, and that is the whole design decision. Bucketing by IP
 * would let one attacker guess at many accounts, and — worse on a self-hosted install behind a reverse proxy,
 * where every request arrives from the proxy's address — would let one attacker lock out the entire practice
 * by failing ten times. A guessed password is a threat to one account, so one account is what is limited.
 *
 * Failures *expire* rather than locking anything: a practice where somebody mistypes their password eleven
 * times is a practice that can still sign in four minutes later. Success clears the count, and so does time.
 *
 * Kept apart from the routing on purpose — see the architectural rule in `docs/saas.md`. Nothing here knows
 * what a request is, and it can be swapped for a shared store when a hosted deployment needs one.
 */
export function createAttemptLimiter({ limit = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  /** @type {Map<string, number[]>} the times of recent failures, per key */
  const failures = new Map();

  const recent = (key, at) => (failures.get(key) ?? []).filter((time) => at - time < windowMs);

  return {
    /** Milliseconds until this key may try again, or 0 if it may try now. */
    blockedFor(key) {
      const at = now();
      const times = recent(key, at);
      if (times.length === 0) {
        failures.delete(key);
        return 0;
      }
      if (times.length < limit) {
        failures.set(key, times);
        return 0;
      }
      failures.set(key, times);
      // The oldest failure is the one that will age out first.
      return Math.max(1, windowMs - (at - Math.min(...times)));
    },

    /** Count one failure against a key. */
    failed(key) {
      const at = now();
      failures.set(key, [...recent(key, at), at]);
    },

    /** A correct password wipes the slate: the person is demonstrably who they say they are. */
    succeeded(key) {
      failures.delete(key);
    },

    /** Kept for the tests and for anything that needs to see the whole picture. */
    size: () => failures.size,
  };
}
