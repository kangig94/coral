import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { providerHandoffCapsulePath } from '#src/infra/path/index.js';
import {
  CURRENT_HANDOFF_CAPSULE_VERSION,
  writeHandoffCapsuleFile,
  type HandoffCapsuleV4,
} from '#src/provider-proxy/handoff-capsule.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import {
  readProviderProxySetHolderStatusDirect,
  formatProviderProxySetHolderStatusDirect,
} from '#src/cli/commands/backend.js';

function testCapsule(runDir: string, pid: number): HandoffCapsuleV4 {
  const buildSetId = randomUUID();
  return {
    version: CURRENT_HANDOFF_CAPSULE_VERSION,
    grantId: randomUUID(),
    secret: 'a'.repeat(64),
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
    controllerBuildSetId: buildSetId,
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
    const futurePath = join(runDir, `provider-1${'a'.repeat(23)}.handoff.v5.json`);
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
});
