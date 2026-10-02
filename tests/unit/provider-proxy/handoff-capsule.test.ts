import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createGrantRegistry,
  decodeHandoffCapsule,
  handoffSecretDigest,
  writeHandoffCapsuleFile,
  type HandoffCapsuleV1,
  type HandoffCapsuleV3,
  type HandoffCapsuleV4,
  type InstalledGrant,
} from '#src/provider-proxy/handoff-capsule.js';
import type { ControlTenancyHolder } from '#src/provider-proxy/control-endpoint.js';
import type { ControllerBuild } from '#src/provider-proxy/controller-succession.js';
import type { OperationIdentity } from '#src/provider-proxy/protocol.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { controllerBuild } from '#src/coordinator-launch/controller-build.js';
import { providerHandoffCapsulePath } from '#src/infra/path/index.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';

const SECRET = 'c'.repeat(64);

/** The build of the host every fixture capsule describes, and of the controller that installed its grant. */
const HOST_BUILD: ControllerBuild = {
  generation: 'gen2',
  flavor: 'prod',
  buildSetId: '22222222-2222-4222-8222-222222222222',
};

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

function capsuleV3For(): HandoffCapsuleV3 {
  return {
    ...capsuleFor(),
    version: 3,
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
    controllerBuild: HOST_BUILD,
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

const SUCCESSOR: ControlTenancyHolder = {
  instanceId: 'c3333333-3333-4333-8333-333333333333',
  pid: 201,
  incarnation: testIncarnation(9_001),
};
const OTHER_SUCCESSOR: ControlTenancyHolder = {
  instanceId: 'd4444444-4444-4444-8444-444444444444',
  pid: 202,
  incarnation: testIncarnation(9_002),
};

describe('provider-proxy handoff capsule', () => {
  // Spelled out rather than derived, and that is the whole point. Every other fixture here is built from the
  // current schema, so a rename moves the fixture with it and nothing fails — which is how V2 came to be
  // renamed in place while still calling itself version 2, and how a build that could not boot against a
  // v0.10.6-v0.10.8 capsule passed every gate. This literal is what those builds actually wrote. It may be
  // corrected only against a real capsule from one of those versions, never to match a schema change.
  const SHIPPED_V2_CAPSULE = {
    version: 2,
    grantId: '11111111-1111-4111-8111-111111111111',
    secret: 'a'.repeat(64),
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: '22222222-2222-4222-8222-222222222222',
    hostFingerprint: 'b'.repeat(64),
    guardianInstanceId: '33333333-3333-4333-8333-333333333333',
    reaperInstanceId: '44444444-4444-4444-8444-444444444444',
    proxyInstanceId: '55555555-5555-4555-8555-555555555555',
    guardianControlEndpoint: '/tmp/coral-shipped-guardian.sock',
    reaperControlEndpoint: '/tmp/coral-shipped-reaper.sock',
    proxyEndpoint: '/tmp/coral-shipped-proxy.sock',
    orphanTimeoutMs: 30_000,
    teardownReserveMs: 14_000,
    guardianPid: 101,
    guardianProcessStartedAtSeconds: 1_700_000_001,
    proxyPid: 102,
    reaperPid: 103,
    reaperProcessStartedAtSeconds: 1_700_000_003,
    containmentKind: 'detached-process-group',
    proxyProcessStartedAtSeconds: 1_700_000_002,
    proxyProcessGroupId: 102,
  } as const;

  it('still decodes the v2 capsule v0.10.6 through v0.10.8 wrote', () => {
    const decoded = decodeHandoffCapsule(new TextEncoder().encode(JSON.stringify(SHIPPED_V2_CAPSULE)));

    // Seconds stay seconds. Promoting them to a `ProcessIncarnation` would make a live process compare unequal
    // to its own record and read as absent, which mints a disappearance receipt for a running set.
    expect(decoded).toEqual(SHIPPED_V2_CAPSULE);
    expect(decoded.version).toBe(2);
  });

  it('redeems once, and returns that same redemption — including the installed operation set — to the same successor retrying', () => {
    const registry = createGrantRegistry(mintReceipt());
    const grant = installedGrantFor(ORDERED);
    registry.install(grant);
    const request = {
      grantId: grant.grantId,
      secret: SECRET,
      successor: SUCCESSOR,
      successorBuild: HOST_BUILD,
      binding: bindingOf(grant),
    };

    const redeemed = registry.redeem(request);

    expect(redeemed.grant.grantId).toBe(grant.grantId);
    // The set was never presented in `request` above — it comes back only because `install` recorded it.
    expect(redeemed.grant.operations).toEqual(ORDERED);
    expect(redeemed.redemptionReceipt).toBe('receipt-1');
    // Redemption identity must bind the complete process identity, not only the instance id.
    expect(redeemed.successor).toEqual(SUCCESSOR);
    // A successor whose reply was lost retries with the identical request. Refusing it would hand the set
    // to a teardown it had already earned the right to prevent, so it gets back exactly what it earned —
    // the same receipt, not a fresh one that would invalidate the first.
    expect(registry.redeem(request)).toEqual(redeemed);
    expect(registry.redemption()).toEqual(redeemed);
  });

  it('refuses a second, different successor presenting the same valid grant', () => {
    const registry = createGrantRegistry(mintReceipt());
    const grant = installedGrantFor(ORDERED);
    registry.install(grant);
    const request = {
      grantId: grant.grantId,
      secret: SECRET,
      successor: SUCCESSOR,
      successorBuild: HOST_BUILD,
      binding: bindingOf(grant),
    };
    registry.redeem(request);

    // Two racing coordinators reading the same capsule must not both come away believing they own the set.
    expect(() => registry.redeem({ ...request, successor: OTHER_SUCCESSOR, successorBuild: HOST_BUILD })).toThrow(
      /control epoch remains live/u,
    );
    // A caller branches on the discriminated code, never on message text — `control-endpoint.ts` documents
    // `grant_replayed` as the code that means "give up", distinct from a retryable `grant_invalid`.
    try {
      registry.redeem({ ...request, successor: OTHER_SUCCESSOR, successorBuild: HOST_BUILD });
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'grant_replayed' });
    }
    expect(registry.redemption()?.successor).toEqual(SUCCESSOR);
  });
});

describe('provider-proxy grant registry controller succession', () => {
  const SUCCESSOR_BUILD: ControllerBuild = { ...HOST_BUILD, buildSetId: 'e5555555-5555-4555-8555-555555555555' };

  function transferRequest(grant: InstalledGrant) {
    return { grantId: grant.grantId, secret: SECRET, successor: SUCCESSOR, binding: bindingOf(grant) };
  }

  it('admits the transferred build only after the controller authorizes it, and keeps the controller build', () => {
    // Every later redemption below happens after the previous holder's control lapsed.
    const registry = createGrantRegistry(mintReceipt(), { mayReplaceRedemption: () => true });
    const grant = installedGrantFor([OPERATION_A]);
    registry.install(grant);

    expect(() => registry.redeem({ ...transferRequest(grant), successorBuild: SUCCESSOR_BUILD })).toThrow(
      /build this grant does not authorize/u,
    );
    registry.authorizeTransfer({ grantId: grant.grantId, attemptId: 'attempt-1', successor: SUCCESSOR_BUILD });
    const transferred = registry.redeem({ ...transferRequest(grant), successorBuild: SUCCESSOR_BUILD });
    expect(transferred.successorBuild).toEqual(SUCCESSOR_BUILD);
    expect(transferred.grant.operations).toEqual([OPERATION_A]);

    // The successor fails before it serves: the old controller's build reclaims with the same grant.
    const reclaimed = registry.redeem({
      ...transferRequest(grant),
      successor: OTHER_SUCCESSOR,
      successorBuild: HOST_BUILD,
    });
    expect(reclaimed.successorBuild).toEqual(HOST_BUILD);
  });
});

describe('provider-proxy handoff capsule file I/O', () => {
  it('counts V3 and V4 capsules left by a migration crash as one set', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-capsule-migration-'));
    try {
      const runtime = createRealRuntime('dev', { baseDir: join(root, '.coral') });
      const runDir = runtime.paths.coral.coordinator.runDir;
      const incarnation = probeProcessIncarnation(process.pid);
      if (incarnation === null) throw new Error('Test process has no incarnation');
      const oldCapsule: HandoffCapsuleV3 = {
        ...capsuleV3For(),
        flavor: 'dev',
        proxyPid: process.pid,
        proxyIncarnation: incarnation,
      };
      const newController = '66666666-6666-4666-8666-666666666666';
      const newCapsule: HandoffCapsuleV4 = {
        ...oldCapsule,
        version: 4,
        controllerBuildSetId: newController,
      };
      const pathOptions = { baseDir: dirname(runtime.paths.coral.generation.root) };
      mkdirSync(runDir, { recursive: true });
      const oldPath = providerHandoffCapsulePath(oldCapsule, 3, pathOptions);
      writeFileSync(oldPath, `${JSON.stringify(oldCapsule)}\n`, { mode: 0o600 });
      writeHandoffCapsuleFile(providerHandoffCapsulePath(newCapsule, 4, pathOptions), newCapsule, {
        storage: runtime.storage,
        uid: process.getuid?.() ?? 0,
      });
      expect(controllerBuild(runDir)).toEqual({ kind: 'required', buildSetId: newController });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
