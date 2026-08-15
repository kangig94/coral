import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HandoffCapsuleError,
  MAX_HANDOFF_CAPSULE_BYTES,
  createGrantRegistry,
  decodeHandoffCapsule,
  handoffOperationSetSchema,
  handoffSecretDigest,
  readHandoffCapsuleFile,
  writeHandoffCapsuleFile,
  type HandoffCapsule,
  type HandoffCapsuleV1,
  type HandoffCapsuleV2,
  type HandoffCapsuleFileEnvironment,
  type InstalledGrant,
} from '#src/provider-proxy/handoff-capsule.js';
import type { OperationIdentity } from '#src/provider-proxy/protocol.js';
import { createRealRuntime } from '#src/runtime/real.js';

const SECRET = 'c'.repeat(64);

function capsuleFor(): HandoffCapsuleV1 {
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
    orphanTimeoutMs: 30_000,
    teardownReserveMs: 14_000,
  };
}

function capsuleV2For(): HandoffCapsuleV2 {
  return {
    ...capsuleFor(),
    version: 2,
    guardianPid: 101,
    guardianIncarnation: testIncarnation(1_001),
    proxyPid: 102,
    reaperPid: 103,
    reaperIncarnation: testIncarnation(1_003),
    containmentKind: 'detached-process-group',
    proxyIncarnation: testIncarnation(1_002),
    proxyProcessGroupId: 102,
  };
}

const OPERATION_A: OperationIdentity = {
  jobId: '66666666-6666-4666-8666-666666666666',
  operationId: 'a1111111-1111-4111-8111-111111111111',
  proxyInstanceId: '55555555-5555-4555-8555-555555555555',
  buildSetId: '22222222-2222-4222-8222-222222222222',
};
const OPERATION_B: OperationIdentity = {
  ...OPERATION_A,
  operationId: 'b2222222-2222-4222-8222-222222222222',
};
const ORDERED: readonly OperationIdentity[] = [OPERATION_A, OPERATION_B];

/** The `InstalledGrant` a wire `*.handoff-install.v1` handler would build from `capsuleFor()`'s identity
 *  tuple, mirroring `guardian.ts`/`reaper.ts`/`proxy.ts`'s own construction rather than going through a
 *  capsule — the capsule carries no `operations` field for a grant to be derived from (`handoff-capsule.ts`'s
 *  own doc explains why). */
function installedGrantFor(operations: readonly OperationIdentity[]): InstalledGrant {
  const capsule = capsuleFor();
  return {
    grantId: capsule.grantId,
    secretSha256: handoffSecretDigest(capsule.secret),
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    guardianInstanceId: capsule.guardianInstanceId,
    reaperInstanceId: capsule.reaperInstanceId,
    proxyInstanceId: capsule.proxyInstanceId,
    operations,
    orphanTimeoutMs: capsule.orphanTimeoutMs,
  };
}

function bindingOf(grant: InstalledGrant) {
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
    const decoded = decodeHandoffCapsule(encode(capsuleFor()));

    expect(decoded.grantId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('decodes a v2 capsule with the complete containment identity', () => {
    expect(decodeHandoffCapsule(encode(capsuleV2For()))).toEqual(capsuleV2For());
  });

  it('refuses an oversize capsule before parsing it', () => {
    const bytes = new Uint8Array(MAX_HANDOFF_CAPSULE_BYTES + 1);

    expect(() => decodeHandoffCapsule(bytes)).toThrow(/exceeded/u);
  });

  it('refuses an unknown field', () => {
    expect(() => decodeHandoffCapsule(encode({ ...capsuleFor(), extra: true }))).toThrow(HandoffCapsuleError);
  });

  it('refuses a capsule carrying an operation set — that fact has no home here', () => {
    // The capsule's own schema is `.strict()`: an `operations` field, however shaped, is unknown to it.
    expect(() => decodeHandoffCapsule(encode({ ...capsuleFor(), operations: [] }))).toThrow(HandoffCapsuleError);
  });

  it('encodes and decodes round-trip well inside the read cap', () => {
    // Fixed-size record now that the capsule carries no operation set: nothing here scales with how many
    // operations the grant covers, so there is no "largest legal capsule" to budget for any more.
    const encoded = encode(capsuleFor());

    expect(encoded.byteLength).toBeLessThan(MAX_HANDOFF_CAPSULE_BYTES);
    expect(decodeHandoffCapsule(encoded)).toEqual(capsuleFor());
  });

  it('installs idempotently for the identical value and refuses a different one', () => {
    const registry = createGrantRegistry(mintReceipt());
    const grant = installedGrantFor(ORDERED);

    expect(registry.install(grant)).toEqual({ state: 'installed-dormant', grantId: grant.grantId });
    expect(registry.install(grant).state).toBe('installed-dormant');

    const other = installedGrantFor([OPERATION_A]);
    expect(() => registry.install(other)).toThrow(/different grant/u);
  });

  it('redeems once, and returns that same redemption — including the installed operation set — to the same successor retrying', () => {
    const registry = createGrantRegistry(mintReceipt());
    const grant = installedGrantFor(ORDERED);
    registry.install(grant);
    const request = {
      grantId: grant.grantId,
      secret: SECRET,
      successorInstanceId: SUCCESSOR,
      binding: bindingOf(grant),
    };

    const redeemed = registry.redeem(request);

    expect(redeemed.grant.grantId).toBe(grant.grantId);
    // The set was never presented in `request` above — it comes back only because `install` recorded it.
    expect(redeemed.grant.operations).toEqual(ORDERED);
    expect(redeemed.redemptionReceipt).toBe('receipt-1');
    // A successor whose reply was lost retries with the identical request. Refusing it would hand the set
    // to a teardown it had already earned the right to prevent, so it gets back exactly what it earned —
    // the same receipt, not a fresh one that would invalidate the first.
    expect(registry.redeem(request)).toEqual(redeemed);
    expect(registry.redemption()).toEqual(redeemed);
  });

  it('lets a successor rotate the standing credential for another control epoch', () => {
    // Role processes outlive each coordinator, so the same registry must allow recovery through multiple
    // control losses instead of making the first redemption the last recoverable epoch.
    const registry = createGrantRegistry(mintReceipt());
    const first = installedGrantFor(ORDERED);
    registry.install(first);
    registry.redeem({
      grantId: first.grantId,
      secret: SECRET,
      successorInstanceId: SUCCESSOR,
      binding: bindingOf(first),
    });

    const nextSecret = 'a'.repeat(64);
    const next: InstalledGrant = {
      ...installedGrantFor(ORDERED),
      grantId: randomUUID(),
      secretSha256: handoffSecretDigest(nextSecret),
    };

    expect(registry.install(next)).toEqual({ state: 'installed-dormant', grantId: next.grantId });
    // The stale redemption record named the *first* grant's successor; it must not still answer for the
    // fresh grant now installed, or a probe against the new grant would wrongly read as already redeemed.
    expect(registry.redemption()).toBeNull();

    const redeemedAgain = registry.redeem({
      grantId: next.grantId,
      secret: nextSecret,
      successorInstanceId: OTHER_SUCCESSOR,
      binding: bindingOf(next),
    });
    expect(redeemedAgain.grant.grantId).toBe(next.grantId);
  });

  it('refuses a second, different successor presenting the same valid grant', () => {
    const registry = createGrantRegistry(mintReceipt());
    const grant = installedGrantFor(ORDERED);
    registry.install(grant);
    const request = {
      grantId: grant.grantId,
      secret: SECRET,
      successorInstanceId: SUCCESSOR,
      binding: bindingOf(grant),
    };
    registry.redeem(request);

    // Two racing coordinators reading the same capsule must not both come away believing they own the set.
    expect(() => registry.redeem({ ...request, successorInstanceId: OTHER_SUCCESSOR })).toThrow(
      /control epoch remains live/u,
    );
    // A caller branches on the discriminated code, never on message text — `control-endpoint.ts` documents
    // `grant_replayed` as the code that means "give up", distinct from a retryable `grant_invalid`.
    try {
      registry.redeem({ ...request, successorInstanceId: OTHER_SUCCESSOR });
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'grant_replayed' });
    }
    expect(registry.redemption()?.successorInstanceId).toBe(SUCCESSOR);
  });

  it('carries exact-set membership into later epochs only after incumbent liveness ends', () => {
    let incumbentLive = true;
    const registry = createGrantRegistry(mintReceipt(), { mayReplaceRedemption: () => !incumbentLive });
    const grant = installedGrantFor([]);
    registry.install(grant);
    registry.register(OPERATION_A);
    const request = {
      grantId: grant.grantId,
      secret: SECRET,
      successorInstanceId: SUCCESSOR,
      binding: bindingOf(grant),
    };

    const incumbent = registry.redeem(request);
    expect(incumbent.grant.operations).toEqual([OPERATION_A]);
    expect(() => registry.redeem({ ...request, successorInstanceId: OTHER_SUCCESSOR })).toThrow(
      /control epoch remains live/u,
    );
    expect(() =>
      registry.redeem({
        ...request,
        successorInstanceId: OTHER_SUCCESSOR,
        binding: { ...request.binding, proxyInstanceId: randomUUID() },
      }),
    ).toThrow(/different guardian\/reaper\/proxy set/u);

    incumbentLive = false;
    const successor = registry.redeem({ ...request, successorInstanceId: OTHER_SUCCESSOR });

    expect(successor.successorInstanceId).toBe(OTHER_SUCCESSOR);
    expect(successor.redemptionReceipt).toBe('receipt-2');
    expect(successor.grant.operations).toEqual([OPERATION_A]);
  });

  it('refuses redemption presenting the wrong secret', () => {
    const registry = createGrantRegistry(mintReceipt());
    const grant = installedGrantFor(ORDERED);
    registry.install(grant);

    expect(() =>
      registry.redeem({
        grantId: grant.grantId,
        secret: 'e'.repeat(64),
        successorInstanceId: SUCCESSOR,
        binding: bindingOf(grant),
      }),
    ).toThrow(/did not present the installed grant/u);
    expect(registry.redemption()).toBeNull();
  });

  it('refuses redemption from another set even when the secret matches', () => {
    const registry = createGrantRegistry(mintReceipt());
    const grant = installedGrantFor(ORDERED);
    registry.install(grant);

    // A capsule replayed from a different build set is a grant that was never for this one.
    expect(() =>
      registry.redeem({
        grantId: grant.grantId,
        secret: SECRET,
        successorInstanceId: SUCCESSOR,
        binding: { ...bindingOf(grant), buildSetId: '99999999-9999-4999-8999-999999999999' },
      }),
    ).toThrow(/different guardian\/reaper\/proxy set/u);
    expect(registry.redemption()).toBeNull();
  });

  it('refuses an unsorted or duplicated operation set at handoffOperationSetSchema itself', () => {
    // No longer reachable through the capsule (it carries no operation set), but every `*.handoff-install.v1`
    // ingress still parses through this schema — worth a direct, fast unit check independent of any socket.
    expect(handoffOperationSetSchema.safeParse([OPERATION_B, OPERATION_A]).success).toBe(false);
    expect(handoffOperationSetSchema.safeParse([OPERATION_A, OPERATION_A]).success).toBe(false);
    expect(handoffOperationSetSchema.safeParse([OPERATION_A, OPERATION_B]).success).toBe(true);
  });

  it('refuses redemption when nothing is installed', () => {
    const registry = createGrantRegistry(mintReceipt());

    expect(() =>
      registry.redeem({
        grantId: randomUUID(),
        secret: SECRET,
        successorInstanceId: SUCCESSOR,
        binding: bindingOf(installedGrantFor(ORDERED)),
      }),
    ).toThrow(/No grant is installed/u);
  });
});

describe('provider-proxy handoff capsule file I/O', () => {
  let tempRoot: string;
  let capsulePath: string;
  let env: HandoffCapsuleFileEnvironment;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'coral-handoff-capsule-'));
    capsulePath = join(tempRoot, 'handoff.capsule.json');
    const storage = createRealRuntime('dev', { baseDir: tempRoot }).storage;
    const uid = Number(statSync(tempRoot, { bigint: true }).uid);
    env = { storage, uid };
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  /** A single invocation, not two: several cases below mutate the filesystem as a side effect of the read
   *  itself (a mid-read swap), so calling `readHandoffCapsuleFile` a second time to inspect the error would
   *  be reading the *post*-mutation state rather than observing the race. */
  function readCapsuleFailure(path: string, environment: HandoffCapsuleFileEnvironment): HandoffCapsuleError {
    try {
      readHandoffCapsuleFile(path, environment);
    } catch (error: unknown) {
      if (error instanceof HandoffCapsuleError) return error;
      throw error;
    }
    throw new Error('expected readHandoffCapsuleFile to throw');
  }

  it('writes a private mode-0600 capsule and reads it back unchanged', () => {
    writeHandoffCapsuleFile(capsulePath, capsuleFor(), env);

    const stat = statSync(capsulePath, { bigint: true });
    expect(stat.uid).toBe(BigInt(env.uid));
    expect(stat.mode & 0o777n).toBe(0o600n);
    expect(readHandoffCapsuleFile(capsulePath, env)).toEqual(capsuleFor());
  });

  it('returns null for an absent capsule', () => {
    expect(readHandoffCapsuleFile(capsulePath, env)).toBeNull();
  });

  it('refuses a capsule whose mode is not 0600', () => {
    writeHandoffCapsuleFile(capsulePath, capsuleFor(), env);
    chmodSync(capsulePath, 0o644);

    expect(readCapsuleFailure(capsulePath, env).code).toBe('handoff_capsule_not_private');
  });

  it('refuses a capsule whose filesystem owner is not the reading uid', () => {
    writeHandoffCapsuleFile(capsulePath, capsuleFor(), env);

    expect(readCapsuleFailure(capsulePath, { ...env, uid: env.uid + 1 }).code).toBe('handoff_capsule_not_private');
  });

  // A prior implementation compared only `opened.size !== stat.size` between the ownership check and the
  // read, with no device/inode check and no re-verification after the read completed — a capsule swapped for
  // a same-length twin between those two points would pass silently. `readBoundedFileAtIdentity`
  // (`infra/bundle-manifest.ts`) closes that: swapping the underlying inode is caught even when the byte
  // count never moves.
  it('refuses a capsule swapped for a same-length twin between the ownership check and the open', () => {
    const capsuleA = capsuleFor();
    const capsuleB: HandoffCapsule = { ...capsuleA, grantId: '99999999-9999-4999-8999-999999999999' };
    expect(JSON.stringify(capsuleA).length).toBe(JSON.stringify(capsuleB).length);
    writeHandoffCapsuleFile(capsulePath, capsuleA, env);

    const swappingStorage: HandoffCapsuleFileEnvironment['storage'] = {
      ...env.storage,
      openSync: (path, flags) => {
        env.storage.writeAtomicDurableSync(capsulePath, JSON.stringify(capsuleB), { encoding: 'utf-8', mode: 0o600 });
        return env.storage.openSync(path, flags);
      },
    };
    const swappedEnv: HandoffCapsuleFileEnvironment = { ...env, storage: swappingStorage };

    expect(readCapsuleFailure(capsulePath, swappedEnv).code).toBe('handoff_capsule_unreadable');
  });

  it('refuses a capsule swapped for a symlink while the read was still in flight', () => {
    writeHandoffCapsuleFile(capsulePath, capsuleFor(), env);
    const targetPath = join(tempRoot, 'elsewhere.json');

    let readCount = 0;
    const swappingStorage: HandoffCapsuleFileEnvironment['storage'] = {
      ...env.storage,
      readSync: (fd, buffer, offset, length, position) => {
        const read = env.storage.readSync(fd, buffer, offset, length, position);
        readCount += 1;
        if (readCount === 1) {
          writeFileSync(targetPath, JSON.stringify(capsuleFor()), { encoding: 'utf-8', mode: 0o600 });
          unlinkSync(capsulePath);
          symlinkSync(targetPath, capsulePath);
        }
        return read;
      },
    };
    const swappedEnv: HandoffCapsuleFileEnvironment = { ...env, storage: swappingStorage };

    expect(readCapsuleFailure(capsulePath, swappedEnv).code).toBe('handoff_capsule_unreadable');
  });
});
