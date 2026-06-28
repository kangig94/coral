import { describe, expect, it } from 'vitest';

import {
  assertRemoteAddressLiteral,
  isLoopbackRemoteAddress,
  normalizeRemoteAddressLiteral,
} from '#src/infra/remote-address.js';

describe('remote address helpers', () => {
  it('normalizes IPv4-mapped IPv6 addresses to IPv4 literals', () => {
    expect(normalizeRemoteAddressLiteral('::ffff:203.0.113.10')).toBe('203.0.113.10');
  });

  it('canonicalizes equivalent IPv6 literals', () => {
    expect(normalizeRemoteAddressLiteral('2001:0db8:0000:0000:0000:ff00:0042:8329')).toBe('2001:db8::ff00:42:8329');
    expect(normalizeRemoteAddressLiteral('[2001:db8::ff00:42:8329]')).toBe('2001:db8::ff00:42:8329');
  });

  it('recognizes loopback literals after normalization', () => {
    expect(isLoopbackRemoteAddress('[::1]')).toBe(true);
    expect(isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects hostnames for remote allowlist entries', () => {
    expect(() => assertRemoteAddressLiteral('localhost', 'TEST_ALLOWLIST')).toThrow(
      'TEST_ALLOWLIST must be an IP address literal',
    );
  });
});
