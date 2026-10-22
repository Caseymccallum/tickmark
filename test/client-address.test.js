import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clientAddress } from '../src/tenancy/client-address.js';

test('forwarded addresses are ignored when the socket peer is not trusted', () => {
  assert.equal(clientAddress({
    socket: { remoteAddress: '203.0.113.8' },
    headers: { 'x-forwarded-for': '198.51.100.7' },
  }, ['127.0.0.1']), '203.0.113.8');
});

test('a trusted proxy chain stops at the first untrusted hop and ignores spoofed values to its left', () => {
  assert.equal(clientAddress({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '192.0.2.99, 198.51.100.7, 10.0.0.2' },
  }, ['127.0.0.1', '10.0.0.2']), '198.51.100.7');
});

test('invalid forwarding data falls back to the trusted peer', () => {
  assert.equal(clientAddress({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': 'attacker, 198.51.100.7' },
  }, ['127.0.0.1']), '127.0.0.1');
});

test('IPv4-mapped IPv6 peers match an IPv4 trusted-proxy entry', () => {
  assert.equal(clientAddress({
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: { 'x-forwarded-for': '198.51.100.7' },
  }, ['127.0.0.1']), '198.51.100.7');
});
