import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { providerHandoffCapsulePath } from '#src/infra/path/index.js';
import {
  CURRENT_HANDOFF_CAPSULE_VERSION,
  writeHandoffCapsuleFile,
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

    const readings = await readProviderProxySetHolderStatusDirect(runtime);
    const rendered = formatProviderProxySetHolderStatusDirect(readings);

    expect(readings).toHaveLength(3);
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
});
