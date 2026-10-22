import { isIP } from 'node:net';

const normalise = (value) => {
  const address = String(value ?? '').trim().toLowerCase();
  if (!isIP(address)) return null;
  return address.startsWith('::ffff:') ? address.slice(7) : address;
};

/**
 * Return the network address used for coarse abuse throttling.
 *
 * Forwarded headers are ignored unless the immediate socket peer is explicitly trusted. When a
 * trusted proxy is present, walk the forwarded chain from the right and stop at its first untrusted
 * hop; attacker-supplied values to the left of that point are never used.
 */
export function clientAddress(request, trustedProxies = []) {
  const peer = normalise(request?.socket?.remoteAddress);
  if (!peer) return 'unknown';
  const trusted = new Set(trustedProxies.map(normalise).filter(Boolean));
  if (!trusted.has(peer)) return peer;

  const forwarded = String(request?.headers?.['x-forwarded-for'] ?? '')
    .split(',')
    .map(normalise);
  if (forwarded.length === 0 || forwarded.some((address) => !address)) return peer;

  let current = peer;
  for (let index = forwarded.length - 1; index >= 0 && trusted.has(current); index -= 1) {
    current = forwarded[index];
  }
  return current;
}
