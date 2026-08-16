import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { providerHandoffCapsulePath } from '#src/infra/path/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { StoragePort } from '#src/infra/port-types.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import {
  discoverProviderHandoffCapsules,
  retireProviderHandoffCapsule,
} from '#src/coordinator/services/provider-proxy-capsule-discovery.js';
import { CURRENT_HANDOFF_CAPSULE_VERSION, type HandoffCapsule } from '#src/provider-proxy/handoff-capsule.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';

/** The build this fixture lifecycle belongs to — the same one its capsule carries, so discovery treats it as inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '22222222-2222-4222-8222-222222222222';

function retirementStorage(unlinkSync: () => void, syncDirectoryDurableSync: () => boolean): StoragePort {
  return { unlinkSync, syncDirectoryDurableSync } as unknown as StoragePort;
}

describe('provider proxy capsule discovery', () => {
  it('derives retirement availability only from directory durability', () => {
    const unlinkSync = vi.fn();
    const syncDirectoryDurableSync = vi.fn(() => false);

    expect(
      retireProviderHandoffCapsule(
        retirementStorage(unlinkSync, syncDirectoryDurableSync),
        '/capsules/provider.handoff.json',
      ),
    ).toEqual({
      kind: 'temporarily-unavailable',
      incident: { kind: 'capsule-directory-durability-unavailable' },
    });
    expect(unlinkSync).toHaveBeenCalledOnce();
    expect(syncDirectoryDurableSync).toHaveBeenCalledWith('/capsules');
  });

  it('fsyncs the capsule directory after an idempotent ENOENT retry', () => {
    const unlinkSync = vi.fn(() => {
      throw Object.assign(new Error('already absent'), { code: 'ENOENT' });
    });
    const syncDirectoryDurableSync = vi.fn(() => true);

    expect(
      retireProviderHandoffCapsule(
        retirementStorage(unlinkSync, syncDirectoryDurableSync),
        '/capsules/provider.handoff.json',
      ),
    ).toEqual({ kind: 'retired' });
    expect(syncDirectoryDurableSync).toHaveBeenCalledWith('/capsules');
  });

  it('propagates an unknown unlink failure without inferring availability', () => {
    const sentinel = new Error('unlink sentinel');
    const syncDirectoryDurableSync = vi.fn(() => true);

    expect(() =>
      retireProviderHandoffCapsule(
        retirementStorage(() => {
          throw sentinel;
        }, syncDirectoryDurableSync),
        '/capsules/provider.handoff.json',
      ),
    ).toThrow(sentinel);
    expect(syncDirectoryDurableSync).not.toHaveBeenCalled();
  });

  // Copied from `git show v0.10.8:src/coordinator/services/provider-proxy-capsule-discovery.ts`, deliberately
  // as a literal. It is the gate a rolled-back build applies before it opens anything, and this project can
  // no longer unrelease — a bad version is answered by a forward one, so the build being rolled back to is a
  // build already in the field whose source cannot be changed. Correct this only against that source.
  const V0_10_8_DISCOVERY_PATTERN = /^provider-1[0-9a-f]{23}\.handoff\.json$/u;

  it('writes a capsule a v0.10.8 build will not open', () => {
    const identity = {
      generation: 'gen2' as const,
      flavor: 'prod' as const,
      buildSetId: '22222222-2222-4222-8222-222222222222',
      hostFingerprint: 'd'.repeat(64),
      proxyInstanceId: '55555555-5555-4555-8555-555555555555',
    };
    const baseDir = '/tmp/coral-capsule-generation';

    const current = basename(providerHandoffCapsulePath(identity, CURRENT_HANDOFF_CAPSULE_VERSION, { baseDir }));
    const legacy = basename(providerHandoffCapsulePath(identity, 2, { baseDir }));

    expect(
      V0_10_8_DISCOVERY_PATTERN.test(current),
      'a capsule this build writes must be invisible to v0.10.8, not fatal to it',
    ).toBe(false);
    // And the older generations stay exactly where they were, or this build stops finding what it must refuse.
    expect(V0_10_8_DISCOVERY_PATTERN.test(legacy)).toBe(true);
    expect(current).not.toBe(legacy);
  });

  // The other direction, and the one that matters from here on: a build must not open a capsule it cannot
  // decode, because refusing one is fatal at startup. A future generation's file has to be invisible to this
  // build exactly as this build's is to v0.10.8 — otherwise rolling back onto it kills the coordinator.
  it('does not discover a capsule generation it cannot decode', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-capsule-future-'));
    const runtime = createRealRuntime('prod', { baseDir });
    const runDir = runtime.paths.coral.coordinator.runDir;
    runtime.storage.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const stat = runtime.storage.statSync(baseDir, { bigint: true });
    if (stat.uid === undefined) throw new Error('real storage did not report the temporary directory owner');

    // A well-formed name of a generation this build has never heard of, holding bytes it cannot parse.
    const future = join(runDir, 'provider-1aaaaaaaaaaaaaaaaaaaaaaa.handoff.v4.json');
    runtime.storage.writeAtomicDurableSync(future, JSON.stringify({ version: 4 }), {
      encoding: 'utf-8',
      mode: 0o600,
    });

    expect(
      discoverProviderHandoffCapsules({
        runDir,
        generationRoot: runtime.paths.coral.generation.root,
        storage: runtime.storage,
        uid: Number(stat.uid),
      }),
      'a generation this build cannot decode must never reach the decoder',
    ).toEqual([]);
  });

  it('discovers a canonical real-storage capsule and blocks matching fresh admission', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-provider-capsule-discovery-'));
    const runtime = createRealRuntime('prod', { baseDir });
    const runDir = runtime.paths.coral.coordinator.runDir;
    runtime.storage.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const capsule: HandoffCapsule = {
      version: 1,
      grantId: '11111111-1111-4111-8111-111111111111',
      secret: 'c'.repeat(64),
      generation: 'gen2',
      flavor: 'prod',
      buildSetId: '22222222-2222-4222-8222-222222222222',
      hostFingerprint: 'd'.repeat(64),
      guardianInstanceId: '33333333-3333-4333-8333-333333333333',
      reaperInstanceId: '44444444-4444-4444-8444-444444444444',
      proxyInstanceId: '55555555-5555-4555-8555-555555555555',
      guardianControlEndpoint: '/tmp/coral-capsule-guardian.sock',
      reaperControlEndpoint: '/tmp/coral-capsule-reaper.sock',
      proxyEndpoint: '/tmp/coral-capsule-proxy.sock',
      orphanTimeoutMs: 30_000,
      teardownReserveMs: 14_000,
    };
    const path = providerHandoffCapsulePath(capsule, capsule.version, { baseDir });
    const stat = runtime.storage.statSync(baseDir, { bigint: true });
    if (stat.uid === undefined) throw new Error('real storage did not report the temporary directory owner');
    // Placed as bytes rather than through `writeHandoffCapsuleFile`, which now accepts V3 alone. This case is
    // discovery finding a capsule an *older* build left behind, so producing it with the current writer would
    // be testing a file production can no longer create.
    runtime.storage.writeAtomicDurableSync(path, JSON.stringify(capsule), { encoding: 'utf-8', mode: 0o600 });

    const discovered = discoverProviderHandoffCapsules({
      runDir,
      generationRoot: runtime.paths.coral.generation.root,
      storage: runtime.storage,
      uid: Number(stat.uid),
    });
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const lifecycle = new ProviderProxySetLifecycle({
      buildSetId: FIXTURE_BUILD_SET_ID,
      claims,
      controlEstablished: () => undefined,
      time: runtime.time,
      recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({
        'capsule-redemption': () => new Promise<never>(() => undefined),
      }),
      reportLifecycle: () => undefined,
    });
    lifecycle.initializeClaimSlots();
    lifecycle.installDiscoveredCapsules(discovered);
    const snapshotBeforeAdmission = lifecycle.snapshot();
    const admission = lifecycle.beginFreshAcquisition('matching-fresh-route', {
      buildSetId: capsule.buildSetId,
      hostFingerprint: capsule.hostFingerprint,
    });

    expect({
      canonicalBasename: /^provider-1[0-9a-f]{23}\.handoff\.json$/u.test(basename(path)),
      discovered,
      snapshotBeforeAdmission,
      admission,
    }).toEqual({
      canonicalBasename: true,
      discovered: [{ path, capsule }],
      snapshotBeforeAdmission: expect.objectContaining({ represented: 1, states: ['capsule-opaque'] }),
      admission: { kind: 'already-represented' },
    });
  });
});
