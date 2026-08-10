import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { providerHandoffCapsulePath } from '#src/infra/path/index.js';
import { writeHandoffCapsuleFile, type HandoffCapsule } from '#src/provider-proxy/handoff-capsule.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set-claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set-lifecycle.js';
import { discoverProviderHandoffCapsules } from '#src/coordinator/services/provider-proxy-capsule-discovery.js';

describe('provider proxy capsule discovery', () => {
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
    const path = providerHandoffCapsulePath(capsule, { baseDir });
    const stat = runtime.storage.statSync(baseDir, { bigint: true });
    if (stat.uid === undefined) throw new Error('real storage did not report the temporary directory owner');
    writeHandoffCapsuleFile(path, capsule, { storage: runtime.storage, uid: Number(stat.uid) });

    const discovered = discoverProviderHandoffCapsules({
      runDir,
      generationRoot: runtime.paths.coral.generation.root,
      storage: runtime.storage,
      uid: Number(stat.uid),
    });
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const lifecycle = new ProviderProxySetLifecycle({
      claims,
      controlEstablished: () => undefined,
      disappearanceConsumer: { containmentDisappeared: async () => ({}) as never },
      time: runtime.time,
      proveContainmentAbsent: async () => null,
      redeemCapsule: () => new Promise<never>(() => undefined),
      retireCapsule: () => ({ kind: 'retired' }),
      rewriteCapsule: () => undefined,
      onFatal: (error) => {
        throw error;
      },
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
