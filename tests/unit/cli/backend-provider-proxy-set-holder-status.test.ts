import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { providerHandoffCapsulePath } from '#src/infra/path/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { CURRENT_HANDOFF_CAPSULE_VERSION, type HandoffCapsuleV3 } from '#src/provider-proxy/handoff-capsule.js';
import { createControlEndpoint, type ControlChallengeAuthority } from '#src/provider-proxy/control-endpoint.js';
import { createControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import { runtimeControlTimer } from '#src/provider-proxy/role-spawn.js';
import {
  readProviderProxySetHolderStatusDirect,
  formatProviderProxySetHolderStatusDirect,
} from '#src/cli/commands/backend.js';

/**
 * AC6: `coral-cli backend status`'s fallback surface reads the mode-0600 handoff capsule directly and queries
 * both role endpoints over their own control framing — never through the coordinator. Both v0.10.9 failure
 * shapes (`method_not_found`, and a bare connection close) must render as `holder-status-unavailable`, never
 * as absence or containment authority.
 */

function passthroughChallenges(): ControlChallengeAuthority {
  return {
    issueFirstChallenge: () => ({ accepted: true, challenge: 'c1' }),
    admitSuccessor: () => ({ accepted: false, reason: 'not-used' }),
    reattachControl: () => ({ accepted: true }),
    controlIsLive: () => true,
    echoChallenge: () => ({ accepted: true, nextChallenge: 'c2' }),
  };
}

async function startAnsweringGuardian(
  socketPath: string,
  timer: ReturnType<typeof runtimeControlTimer>,
  holder: Readonly<{ instanceId: string; pid: number; incarnation: ReturnType<typeof testIncarnation> }>,
): Promise<() => Promise<void>> {
  const holderAuthority = createControlHolderAuthority();
  holderAuthority.install({ controlEpoch: 1, holder });
  holderAuthority.publish();
  const endpoint = createControlEndpoint({
    socketPath,
    role: {
      heartbeatMethod: 'guardian.heartbeat.v1',
      methods: new Map([
        [
          'guardian.holder-status.v1',
          {
            authority: 'observation' as const,
            handle: () => ({
              disposition: 'alive',
              phase: 'published',
              holder,
              controlEpoch: 1,
              transitionSequence: 1,
              changedAtMs: 0,
            }),
          },
        ],
      ]),
    },
    challenges: passthroughChallenges(),
    observer: { onControlLost: () => undefined },
    timer,
    holderAuthority,
    requestTimeoutMs: 5_000,
  });
  await endpoint.listen();
  return () => endpoint.close();
}

async function startBareReaper(
  socketPath: string,
  timer: ReturnType<typeof runtimeControlTimer>,
): Promise<() => Promise<void>> {
  // No `reaper.holder-status.v1` handler at all — a v0.10.9 role's own control-method table, which answers
  // an unrecognized method with a structured `method_not_found` refusal.
  const endpoint = createControlEndpoint({
    socketPath,
    role: { heartbeatMethod: 'reaper.heartbeat.v1', methods: new Map() },
    challenges: passthroughChallenges(),
    observer: { onControlLost: () => undefined },
    timer,
    holderAuthority: createControlHolderAuthority(),
    requestTimeoutMs: 5_000,
  });
  await endpoint.listen();
  return () => endpoint.close();
}

describe('readProviderProxySetHolderStatusDirect', () => {
  it('renders a current guardian as answered and a v0.10.9-shaped reaper as holder-status-unavailable', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'c-hs-'));
    const runtime = createRealRuntime('prod', { baseDir });
    const runDir = runtime.paths.coral.coordinator.runDir;
    runtime.storage.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const timer = runtimeControlTimer(runtime);

    const guardianSocket = join(runDir, 'g.sock');
    const reaperSocket = join(runDir, 'r.sock');
    const holder = { instanceId: randomUUID(), pid: 999, incarnation: testIncarnation(999) };
    const closeGuardian = await startAnsweringGuardian(guardianSocket, timer, holder);
    const closeReaper = await startBareReaper(reaperSocket, timer);

    try {
      const capsule: HandoffCapsuleV3 = {
        version: CURRENT_HANDOFF_CAPSULE_VERSION,
        grantId: randomUUID(),
        secret: 'a'.repeat(64),
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: randomUUID(),
        hostFingerprint: 'b'.repeat(64),
        guardianInstanceId: randomUUID(),
        reaperInstanceId: randomUUID(),
        proxyInstanceId: randomUUID(),
        guardianControlEndpoint: guardianSocket,
        reaperControlEndpoint: reaperSocket,
        proxyEndpoint: '/tmp/c-hs-p.sock',
        orphanTimeoutMs: 37_000,
        teardownReserveMs: 14_000,
        guardianPid: 100,
        guardianIncarnation: testIncarnation(100),
        proxyPid: 200,
        reaperPid: 300,
        reaperIncarnation: testIncarnation(300),
        containmentKind: 'detached-process-group',
        proxyIncarnation: testIncarnation(200),
        proxyProcessGroupId: 200,
      };
      const path = providerHandoffCapsulePath(capsule, capsule.version, { baseDir });
      const stat = runtime.storage.statSync(baseDir, { bigint: true });
      if (stat.uid === undefined) throw new Error('real storage did not report the temporary directory owner');
      runtime.storage.writeAtomicDurableSync(path, JSON.stringify(capsule), { encoding: 'utf-8', mode: 0o600 });

      const readings = await readProviderProxySetHolderStatusDirect(runtime);

      expect(readings).toHaveLength(1);
      const [reading] = readings;
      expect(reading.guardian.kind).toBe('answered');
      if (reading.guardian.kind === 'answered') {
        expect(reading.guardian.status.disposition).toBe('alive');
      }
      expect(reading.reaper.kind).toBe('holder-status-unavailable');

      const rendered = formatProviderProxySetHolderStatusDirect(readings);
      expect(rendered).toContain('guardian: alive');
      expect(rendered).toContain('reaper:   unavailable');
    } finally {
      await closeGuardian();
      await closeReaper();
    }
  });

  it('renders no discovered sets as an explicit empty report, never a silent absence claim', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'c-hs0-'));
    const runtime = createRealRuntime('prod', { baseDir });
    runtime.storage.mkdirSync(runtime.paths.coral.coordinator.runDir, { recursive: true, mode: 0o700 });

    const readings = await readProviderProxySetHolderStatusDirect(runtime);

    expect(readings).toEqual([]);
    expect(formatProviderProxySetHolderStatusDirect(readings)).toBe('No provider proxy sets discovered on disk.');
  });
});
