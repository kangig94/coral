import { describe, expect, it } from 'vitest';

import type { HostRef } from '#src/providers/contract.js';
import { decodeHostRef, encodeHostRef } from '#src/providers/host-ref-codec.js';

const fingerprint = 'a'.repeat(64);

describe('provider host reference codec', () => {
  it.each<HostRef>([
    {
      provider: 'codex',
      fingerprint,
      instanceId: 'shared-instance',
      leaseMode: 'shared',
    },
    {
      provider: 'claude',
      fingerprint,
      instanceId: 'exclusive-instance',
      leaseMode: 'job-exclusive',
      ownerJobId: 'job-1',
    },
  ])('round-trips the $leaseMode HostRef in one canonical key order', (ref) => {
    const token = encodeHostRef(ref);

    expect(token).toMatch(/^ph1\.[A-Za-z0-9_-]+$/);
    expect(decodeHostRef(token)).toEqual(ref);
    expect(Buffer.from(token.slice(4), 'base64url').toString('utf8')).toBe(
      ref.leaseMode === 'shared'
        ? JSON.stringify({
            provider: ref.provider,
            fingerprint: ref.fingerprint,
            instanceId: ref.instanceId,
            leaseMode: ref.leaseMode,
          })
        : JSON.stringify({
            provider: ref.provider,
            fingerprint: ref.fingerprint,
            instanceId: ref.instanceId,
            leaseMode: ref.leaseMode,
            ownerJobId: ref.ownerJobId,
          }),
    );
  });

  it('rejects wrong versions, padded base64, non-canonical JSON, and strict-schema extras', () => {
    const ref: HostRef = {
      provider: 'codex',
      fingerprint,
      instanceId: 'instance',
      leaseMode: 'shared',
    };
    const token = encodeHostRef(ref);
    const reordered = `ph1.${Buffer.from(
      JSON.stringify({ leaseMode: 'shared', instanceId: ref.instanceId, fingerprint, provider: 'codex' }),
    ).toString('base64url')}`;
    const extra = `ph1.${Buffer.from(JSON.stringify({ ...ref, extra: true })).toString('base64url')}`;

    expect(() => decodeHostRef(token.replace('ph1.', 'ph2.'))).toThrow(/must start with 'ph1\.'/);
    expect(() => decodeHostRef(`${token}=`)).toThrow(/unpadded base64url/);
    expect(() => decodeHostRef(reordered)).toThrow(/not canonically encoded/);
    expect(() => decodeHostRef(extra)).toThrow();
  });
});
