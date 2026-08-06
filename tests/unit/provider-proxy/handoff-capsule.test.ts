import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  HandoffCapsuleError,
  MAX_HANDOFF_CAPSULE_BYTES,
  createGrantRegistry,
  decodeHandoffCapsule,
  handoffSecretDigest,
  installedGrantFromCapsule,
  type HandoffCapsule,
} from '#src/provider-proxy/handoff-capsule.js';

const SECRET = 'c'.repeat(64);

function capsuleFor(operationIds: readonly string[]): HandoffCapsule {
  return {
    version: 1,
    grantId: '11111111-1111-4111-8111-111111111111',
    secret: SECRET,
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: '22222222-2222-4222-8222-222222222222',
    hostFingerprint: 'd'.repeat(64),
    guardianInstanceId: '33333333-3333-4333-8333-333333333333',
    reaperInstanceId: '44444444-4444-4444-8444-444444444444',
    proxyInstanceId: '55555555-5555-4555-8555-555555555555',
    guardianControlEndpoint: '/tmp/g.sock',
    reaperControlEndpoint: '/tmp/r.sock',
    proxyEndpoint: '/tmp/p.sock',
    operations: operationIds.map((operationId) => ({
      operation: {
        jobId: '66666666-6666-4666-8666-666666666666',
        operationId,
        proxyInstanceId: '55555555-5555-4555-8555-555555555555',
        buildSetId: '22222222-2222-4222-8222-222222222222',
      },
      carrierState: 'executing' as const,
      committedThroughProviderSeq: 4,
    })),
    orphanTimeoutMs: 30_000,
    teardownReserveMs: 14_000,
  };
}

const ORDERED = ['a1111111-1111-4111-8111-111111111111', 'b2222222-2222-4222-8222-222222222222'];

function bindingOf(grant: ReturnType<typeof installedGrantFromCapsule>) {
  return {
    generation: grant.generation,
    flavor: grant.flavor,
    buildSetId: grant.buildSetId,
    hostFingerprint: grant.hostFingerprint,
    guardianInstanceId: grant.guardianInstanceId,
    reaperInstanceId: grant.reaperInstanceId,
    proxyInstanceId: grant.proxyInstanceId,
  };
}

/** A deterministic receipt minter, so a memoized redemption is visibly the *same* receipt. */
function mintReceipt(): () => string {
  let issued = 0;
  return () => {
    issued += 1;
    return `receipt-${issued}`;
  };
}

const SUCCESSOR = 'c3333333-3333-4333-8333-333333333333';
const OTHER_SUCCESSOR = 'd4444444-4444-4444-8444-444444444444';

function encode(capsule: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(capsule));
}

describe('provider-proxy handoff capsule', () => {
  it('decodes a well-formed capsule', () => {
    const decoded = decodeHandoffCapsule(encode(capsuleFor(ORDERED)));

    expect(decoded.grantId).toBe('11111111-1111-4111-8111-111111111111');
    expect(decoded.operations).toHaveLength(2);
  });

  it('refuses an oversize capsule before parsing it', () => {
    const bytes = new Uint8Array(MAX_HANDOFF_CAPSULE_BYTES + 1);

    expect(() => decodeHandoffCapsule(bytes)).toThrow(/exceeded/u);
  });

  it('refuses an unsorted or duplicated operation set', () => {
    expect(() => decodeHandoffCapsule(encode(capsuleFor([...ORDERED].reverse())))).toThrow(HandoffCapsuleError);
    expect(() => decodeHandoffCapsule(encode(capsuleFor([ORDERED[0], ORDERED[0]])))).toThrow(HandoffCapsuleError);
  });

  it('refuses an unknown field', () => {
    expect(() => decodeHandoffCapsule(encode({ ...capsuleFor(ORDERED), extra: true }))).toThrow(HandoffCapsuleError);
  });

  it('derives an installable grant that carries the digest, never the secret', () => {
    const grant = installedGrantFromCapsule(capsuleFor(ORDERED));

    expect(grant.secretSha256).toBe(handoffSecretDigest(SECRET));
    expect(JSON.stringify(grant)).not.toContain(SECRET);
  });

  it('installs idempotently for the identical value and refuses a different one', () => {
    const registry = createGrantRegistry(mintReceipt());
    const grant = installedGrantFromCapsule(capsuleFor(ORDERED));

    expect(registry.install(grant)).toEqual({ state: 'installed-dormant', grantId: grant.grantId });
    expect(registry.install(grant).state).toBe('installed-dormant');

    const other = installedGrantFromCapsule(capsuleFor([ORDERED[0]]));
    expect(() => registry.install(other)).toThrow(/different grant/u);
  });

  it('redeems once, and returns that same redemption to the same successor retrying', () => {
    const registry = createGrantRegistry(mintReceipt());
    const grant = installedGrantFromCapsule(capsuleFor(ORDERED));
    registry.install(grant);
    const request = {
      grantId: grant.grantId,
      secret: SECRET,
      successorInstanceId: SUCCESSOR,
      operationIds: ORDERED,
      binding: bindingOf(grant),
    };

    const redeemed = registry.redeem(request);

    expect(redeemed.grant.grantId).toBe(grant.grantId);
    expect(redeemed.redemptionReceipt).toBe('receipt-1');
    // A successor whose reply was lost retries with the identical request. Refusing it would hand the set
    // to a teardown it had already earned the right to prevent, so it gets back exactly what it earned —
    // the same receipt, not a fresh one that would invalidate the first.
    expect(registry.redeem(request)).toEqual(redeemed);
    expect(registry.redemption()).toEqual(redeemed);
  });

  it('refuses a second, different successor presenting the same valid grant', () => {
    const registry = createGrantRegistry(mintReceipt());
    const grant = installedGrantFromCapsule(capsuleFor(ORDERED));
    registry.install(grant);
    const request = {
      grantId: grant.grantId,
      secret: SECRET,
      successorInstanceId: SUCCESSOR,
      operationIds: ORDERED,
      binding: bindingOf(grant),
    };
    registry.redeem(request);

    // Single-use means one successor, not one call: two racing coordinators reading the same capsule must
    // not both come away believing they own the set.
    expect(() => registry.redeem({ ...request, successorInstanceId: OTHER_SUCCESSOR })).toThrow(
      /already redeemed by another successor/u,
    );
    expect(registry.redemption()?.successorInstanceId).toBe(SUCCESSOR);
  });

  it('refuses redemption presenting the wrong secret', () => {
    const registry = createGrantRegistry(mintReceipt());
    const grant = installedGrantFromCapsule(capsuleFor(ORDERED));
    registry.install(grant);

    expect(() =>
      registry.redeem({
        grantId: grant.grantId,
        secret: 'e'.repeat(64),
        successorInstanceId: SUCCESSOR,
        operationIds: ORDERED,
        binding: bindingOf(grant),
      }),
    ).toThrow(/did not present the installed grant/u);
    expect(registry.redemption()).toBeNull();
  });

  it('refuses redemption from another set even when the secret and operation list match', () => {
    const registry = createGrantRegistry(mintReceipt());
    const grant = installedGrantFromCapsule(capsuleFor(ORDERED));
    registry.install(grant);

    // A capsule replayed from a different build set is a grant that was never for this one.
    expect(() =>
      registry.redeem({
        grantId: grant.grantId,
        secret: SECRET,
        successorInstanceId: SUCCESSOR,
        operationIds: ORDERED,
        binding: { ...bindingOf(grant), buildSetId: '99999999-9999-4999-8999-999999999999' },
      }),
    ).toThrow(/different guardian\/reaper\/proxy set/u);
    expect(registry.redemption()).toBeNull();
  });

  it('encodes the largest legal capsule well inside the read cap', () => {
    // The plan budgets 384 bytes per operation and 4096 for the envelope, so the maximal capsule must fit
    // 53,376 bytes and leave headroom under the 64 KiB pre-parse cap. If those budgets drift apart, a
    // legitimate full-size capsule would be rejected as oversize in production.
    const longest = Array.from(
      { length: 128 },
      (_, index) => `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
    ).sort();
    const encoded = new TextEncoder().encode(JSON.stringify(capsuleFor(longest)));

    expect(encoded.byteLength).toBeLessThanOrEqual(53_376);
    expect(encoded.byteLength).toBeLessThan(MAX_HANDOFF_CAPSULE_BYTES);
    expect(decodeHandoffCapsule(encoded).operations).toHaveLength(128);
  });

  it('refuses redemption naming a different operation set', () => {
    const registry = createGrantRegistry(mintReceipt());
    const grant = installedGrantFromCapsule(capsuleFor(ORDERED));
    registry.install(grant);

    expect(() =>
      registry.redeem({
        grantId: grant.grantId,
        secret: SECRET,
        successorInstanceId: SUCCESSOR,
        operationIds: [ORDERED[0]],
        binding: bindingOf(grant),
      }),
    ).toThrow(/different operation set/u);
    expect(registry.redemption()).toBeNull();
  });

  it('refuses redemption when nothing is installed', () => {
    const registry = createGrantRegistry(mintReceipt());

    expect(() =>
      registry.redeem({
        grantId: randomUUID(),
        secret: SECRET,
        successorInstanceId: SUCCESSOR,
        operationIds: [],
        binding: bindingOf(installedGrantFromCapsule(capsuleFor(ORDERED))),
      }),
    ).toThrow(/No grant is installed/u);
  });
});
