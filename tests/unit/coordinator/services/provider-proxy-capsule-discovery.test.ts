import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { providerHandoffCapsulePath } from '#src/infra/path/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { StoragePort } from '#src/infra/port-types.js';
import {
  discoverProviderHandoffCapsules,
  retireProviderHandoffCapsule,
} from '#src/coordinator/services/provider-proxy-capsule-discovery.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

/** The build this fixture lifecycle belongs to — the same one its capsule carries, so discovery treats it as inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '22222222-2222-4222-8222-222222222222';

function retirementStorage(
  unlinkSync: () => void,
  syncDirectoryDurableSync: () => boolean,
): Pick<StoragePort, 'syncDirectoryDurableSync' | 'unlinkSync'> {
  return { unlinkSync, syncDirectoryDurableSync };
}

describe('provider proxy capsule discovery', () => {
  it('keeps an executing operation recoverable after a crash between v4 write and v3 retirement', () => {
    const baseDir = '/coral-capsule-migration';
    const time = new VirtualTime();
    const runtime = { ...createRealRuntime('prod', { baseDir }), time, storage: new InMemoryStorage(time) };
    const runDir = runtime.paths.coral.coordinator.runDir;
    runtime.storage.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const record = providerOperationRecord('executing');
    const identity = providerProxySetIdentityFromRecord(record);
    const v3 = {
      version: 3 as const,
      grantId: '11111111-1111-4111-8111-111111111111',
      secret: 'c'.repeat(64),
      generation: 'gen2' as const,
      flavor: 'prod' as const,
      buildSetId: identity.buildSetId,
      hostFingerprint: identity.hostFingerprint,
      guardianInstanceId: identity.guardianInstanceId,
      reaperInstanceId: identity.reaperInstanceId,
      proxyInstanceId: identity.proxyInstanceId,
      guardianControlEndpoint: identity.guardianControlEndpoint,
      reaperControlEndpoint: identity.reaperControlEndpoint,
      proxyEndpoint: identity.canonicalEndpoint,
      orphanTimeoutMs: 30_000,
      teardownReserveMs: 14_000,
      guardianPid: identity.guardianPid,
      guardianIncarnation: identity.guardianIncarnation,
      proxyPid: identity.proxyPid,
      reaperPid: identity.reaperPid,
      reaperIncarnation: identity.reaperIncarnation,
      containmentKind: identity.containmentKind,
      proxyIncarnation: identity.proxyIncarnation,
      proxyProcessGroupId: identity.proxyProcessGroupId,
    };
    const v4 = { ...v3, version: 4 as const, controllerBuildSetId: FIXTURE_BUILD_SET_ID };
    const v3Path = providerHandoffCapsulePath(v3, 3, { baseDir });
    const v4Path = providerHandoffCapsulePath(v4, 4, { baseDir });
    runtime.storage.writeAtomicDurableSync(v3Path, JSON.stringify(v3), { encoding: 'utf-8', mode: 0o600 });
    runtime.storage.writeAtomicDurableSync(v4Path, JSON.stringify(v4), { encoding: 'utf-8', mode: 0o600 });

    const stat = runtime.storage.statSync(baseDir, { bigint: true });
    if (stat.uid === undefined) throw new Error('temporary directory has no owner');
    const discovered = discoverProviderHandoffCapsules({
      runDir,
      generationRoot: runtime.paths.coral.generation.root,
      storage: runtime.storage,
      uid: Number(stat.uid),
    });
    expect(discovered).toEqual([{ path: v4Path, capsule: v4 }]);
    expect(runtime.storage.existsSync(v3Path)).toBe(false);
    expect(runtime.storage.existsSync(v4Path)).toBe(true);
  });
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

  // The other direction, and the one that matters from here on: a build must not open a capsule it cannot
  // decode, because refusing one is fatal at startup. A future generation's file has to be invisible to this
  // build exactly as this build's is to v0.10.8 — otherwise rolling back onto it kills the coordinator.
  it('does not discover a capsule generation it cannot decode', () => {
    const baseDir = '/coral-capsule-future';
    const time = new VirtualTime();
    const runtime = { ...createRealRuntime('prod', { baseDir }), time, storage: new InMemoryStorage(time) };
    const runDir = runtime.paths.coral.coordinator.runDir;
    runtime.storage.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const stat = runtime.storage.statSync(baseDir, { bigint: true });
    if (stat.uid === undefined) throw new Error('real storage did not report the temporary directory owner');

    // A well-formed name of a generation this build has never heard of, holding bytes it cannot parse.
    const future = join(runDir, 'provider-1aaaaaaaaaaaaaaaaaaaaaaa.handoff.v5.json');
    runtime.storage.writeAtomicDurableSync(future, JSON.stringify({ version: 5 }), {
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
});
