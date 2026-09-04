import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { providerHandoffCapsulePath } from '#src/infra/path/index.js';
import {
  CURRENT_HANDOFF_CAPSULE_VERSION,
  writeHandoffCapsuleFile,
  type HandoffCapsuleV1,
  type HandoffCapsuleV2,
  type HandoffCapsuleV3,
} from '#src/provider-proxy/handoff-capsule.js';
import { encodeProviderProxySetAddress } from '#src/provider-proxy/set-address.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import {
  readProviderProxySetHolderStatusDirect,
  formatProviderProxySetHolderStatusDirect,
} from '#src/cli/commands/backend.js';

function testCapsule(runDir: string, pid: number): HandoffCapsuleV3 {
  return {
    version: CURRENT_HANDOFF_CAPSULE_VERSION,
    grantId: randomUUID(),
    secret: 'a'.repeat(64),
    generation: 'gen2',
    flavor: 'prod',
    buildSetId: randomUUID(),
    hostFingerprint: pid.toString(16).padStart(64, '0'),
    guardianInstanceId: randomUUID(),
    reaperInstanceId: randomUUID(),
    proxyInstanceId: randomUUID(),
    guardianControlEndpoint: join(runDir, `guardian-${pid}.sock`),
    reaperControlEndpoint: join(runDir, `reaper-${pid}.sock`),
    proxyEndpoint: join(runDir, `proxy-${pid}.sock`),
    orphanTimeoutMs: 37_000,
    teardownReserveMs: 14_000,
    guardianPid: pid,
    guardianIncarnation: testIncarnation(pid),
    proxyPid: pid + 1,
    reaperPid: pid + 2,
    reaperIncarnation: testIncarnation(pid + 2),
    containmentKind: 'detached-process-group',
    proxyIncarnation: testIncarnation(pid + 1),
    proxyProcessGroupId: pid + 1,
  };
}

describe('readProviderProxySetHolderStatusDirect', () => {
  it('renders no discovered sets as an explicit empty report, never a silent absence claim', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'c-hs0-'));
    const runtime = createRealRuntime('prod', { baseDir });
    runtime.storage.mkdirSync(runtime.paths.coral.coordinator.runDir, { recursive: true, mode: 0o700 });

    const readings = await readProviderProxySetHolderStatusDirect(runtime);

    expect(readings).toEqual([]);
    expect(formatProviderProxySetHolderStatusDirect(readings)).toBe('No provider proxy sets discovered on disk.');
  });

  it('renders no discovered sets when the run directory was never created, rather than throwing', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'c-hs4-'));
    const runtime = createRealRuntime('prod', { baseDir });

    const readings = await readProviderProxySetHolderStatusDirect(runtime);

    expect(readings).toEqual([]);
    expect(formatProviderProxySetHolderStatusDirect(readings)).toBe('No provider proxy sets discovered on disk.');
  });

  it('reports an unreadable run directory as a structured row instead of throwing', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'c-hs5-'));
    const runtime = createRealRuntime('prod', { baseDir });
    const runDir = runtime.paths.coral.coordinator.runDir;
    mkdirSync(dirname(runDir), { recursive: true });
    writeFileSync(runDir, 'not a directory');

    const readings = await readProviderProxySetHolderStatusDirect(runtime);

    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ kind: 'unreadable-run-directory', path: runDir });
    expect(formatProviderProxySetHolderStatusDirect(readings)).toContain(`unreadable run directory path=${runDir}`);
  });

  it('reports an unreadable capsule without hiding readable sets', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'c-hs1-'));
    const runtime = createRealRuntime('prod', { baseDir });
    const runDir = runtime.paths.coral.coordinator.runDir;
    runtime.storage.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const uid = process.getuid?.() ?? 0;
    const validCapsules = [testCapsule(runDir, 100), testCapsule(runDir, 200)];
    for (const capsule of validCapsules) {
      writeHandoffCapsuleFile(providerHandoffCapsulePath(capsule, capsule.version, { baseDir }), capsule, {
        storage: runtime.storage,
        uid,
      });
    }
    const malformedIdentity = testCapsule(runDir, 300);
    const malformedPath = providerHandoffCapsulePath(malformedIdentity, malformedIdentity.version, { baseDir });
    runtime.storage.writeAtomicDurableSync(malformedPath, '{', { encoding: 'utf-8', mode: 0o600 });
    const futurePath = join(runDir, `provider-1${'a'.repeat(23)}.handoff.v4.json`);
    runtime.storage.writeAtomicDurableSync(futurePath, '{', { encoding: 'utf-8', mode: 0o600 });

    const readings = await readProviderProxySetHolderStatusDirect(runtime);
    const rendered = formatProviderProxySetHolderStatusDirect(readings);

    expect(readings).toHaveLength(3);
    expect(readings).not.toContainEqual(expect.objectContaining({ path: futurePath }));
    expect(readings).toContainEqual({
      kind: 'unreadable-capsule',
      path: malformedPath,
      reason: 'handoff_capsule_invalid: Handoff capsule is not valid strict UTF-8 JSON.',
    });
    expect(rendered).toContain(`set proxy=${validCapsules[0]?.proxyInstanceId}`);
    expect(rendered).toContain(`set proxy=${validCapsules[1]?.proxyInstanceId}`);
    expect(rendered).toContain(`unreadable capsule path=${malformedPath}`);
    expect(rendered).toContain('reason: handoff_capsule_invalid: Handoff capsule is not valid strict UTF-8 JSON.');
  });

  it('reports readable legacy capsules without dialing or treating discovery as empty', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'c-hs6-'));
    const runtime = createRealRuntime('prod', { baseDir });
    const runDir = runtime.paths.coral.coordinator.runDir;
    runtime.storage.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const common = {
      grantId: randomUUID(),
      secret: 'b'.repeat(64),
      generation: 'gen2' as const,
      flavor: 'prod' as const,
      buildSetId: randomUUID(),
      hostFingerprint: 'd'.repeat(64),
      guardianInstanceId: randomUUID(),
      reaperInstanceId: randomUUID(),
      proxyInstanceId: randomUUID(),
      guardianControlEndpoint: join(runDir, 'legacy-guardian.sock'),
      reaperControlEndpoint: join(runDir, 'legacy-reaper.sock'),
      proxyEndpoint: join(runDir, 'legacy-proxy.sock'),
      orphanTimeoutMs: 37_000,
      teardownReserveMs: 14_000,
    };
    const v1: HandoffCapsuleV1 = { version: 1, ...common };
    const v2: HandoffCapsuleV2 = {
      version: 2,
      ...common,
      proxyInstanceId: randomUUID(),
      guardianPid: 101,
      guardianProcessStartedAtSeconds: 1_001,
      proxyPid: 102,
      reaperPid: 103,
      reaperProcessStartedAtSeconds: 1_003,
      containmentKind: 'detached-process-group',
      proxyProcessStartedAtSeconds: 1_002,
      proxyProcessGroupId: 102,
    };
    const paths = [v1, v2].map((capsule) => {
      const path = providerHandoffCapsulePath(capsule, capsule.version, { baseDir });
      runtime.storage.writeAtomicDurableSync(path, JSON.stringify(capsule), { encoding: 'utf-8', mode: 0o600 });
      return path;
    });

    const readings = await readProviderProxySetHolderStatusDirect(runtime);
    const rendered = formatProviderProxySetHolderStatusDirect(readings);

    expect(readings).toHaveLength(2);
    expect(readings).toContainEqual({ kind: 'legacy-capsule', path: paths[0], capsule: v1 });
    expect(readings).toContainEqual({ kind: 'legacy-capsule', path: paths[1], capsule: v2 });
    expect(rendered).toContain(`legacy capsule version=1 path=${paths[0]}`);
    expect(rendered).toContain(`legacy capsule version=2 path=${paths[1]}`);
    expect(rendered).toContain(`identity: build=${common.buildSetId} host=${common.hostFingerprint}`);
    expect(rendered).toContain(
      'recorded pids (non-authorizing): guardian=101 reaper=103 proxy=102; process incarnation unavailable',
    );
    expect(rendered).toContain('direct holder status: unsupported for this capsule version; no role was dialed');
    expect(rendered).not.toContain('No provider proxy sets discovered on disk.');
  });

  it('names both operator exits after unattributable retry exhaustion', () => {
    const setIdentity = {
      buildSetId: randomUUID(),
      hostFingerprint: 'c'.repeat(64),
      proxyInstanceId: randomUUID(),
    };
    const rendered = formatProviderProxySetHolderStatusDirect([
      {
        ...setIdentity,
        guardian: {
          kind: 'answered',
          status: {
            disposition: 'unobservable',
            phase: 'published',
            holder: { instanceId: randomUUID(), pid: 900, incarnation: testIncarnation(900) },
            controlEpoch: 1,
            transitionSequence: 2,
            changedAtMs: 1_000,
            enforcementHold: {
              kind: 'recorded-group-unattributable',
              attempts: 5,
              roleIdentity: { role: 'guardian', pid: 901, incarnation: testIncarnation(901) },
              retry: { state: 'operator-action-required' },
            },
          },
        },
        reaper: { kind: 'unreachable', reason: 'connection refused' },
      },
    ]);

    expect(rendered).toContain(
      `coral-cli backend provider-proxy-set contain ${encodeProviderProxySetAddress(setIdentity)} --abandon-without-absence`,
    );
    expect(rendered).toContain(
      `coral-cli backend provider-proxy-set terminate-role --role guardian --pid 901 --incarnation '${testIncarnation(901)}'`,
    );
    expect(rendered).not.toContain('kill -TERM');
  });

  it('reports reap failure without recommending the unattributable-group override', () => {
    const setIdentity = {
      buildSetId: randomUUID(),
      hostFingerprint: 'd'.repeat(64),
      proxyInstanceId: randomUUID(),
    };
    const roleIdentity = { role: 'reaper' as const, pid: 902, incarnation: testIncarnation(902) };
    const rendered = formatProviderProxySetHolderStatusDirect([
      {
        ...setIdentity,
        guardian: { kind: 'unreachable', reason: 'connection refused' },
        reaper: {
          kind: 'answered',
          status: {
            disposition: 'unobservable',
            phase: 'published',
            holder: { instanceId: randomUUID(), pid: 900, incarnation: testIncarnation(900) },
            controlEpoch: 1,
            transitionSequence: 2,
            changedAtMs: 1_000,
            enforcementHold: {
              kind: 'reap-failed',
              reason: 'process-containment-reap-failed',
              attempts: 5,
              roleIdentity,
              retry: { state: 'operator-action-required' },
            },
          },
        },
      },
    ]);

    expect(rendered).toContain('hold=reap-failed reason=process-containment-reap-failed');
    expect(rendered).toContain(
      `coral-cli backend provider-proxy-set retry-role-reap --role reaper --pid 902 --incarnation '${testIncarnation(902)}'`,
    );
    expect(rendered).not.toContain(
      `coral-cli backend provider-proxy-set terminate-role --role reaper --pid 902 --incarnation '${testIncarnation(902)}'`,
    );
    expect(rendered).not.toContain(
      `coral-cli backend provider-proxy-set contain ${encodeProviderProxySetAddress(setIdentity)} --abandon-without-absence`,
    );
  });
});
