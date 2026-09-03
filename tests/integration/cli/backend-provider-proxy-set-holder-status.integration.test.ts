import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  readProviderProxySetHolderStatusDirect,
  formatProviderProxySetHolderStatusDirect,
  type DirectProviderProxySetHolderStatus,
  type DirectProviderProxySetHolderStatusRow,
} from '#src/cli/commands/backend.js';
import { providerHandoffCapsulePath } from '#src/infra/path/index.js';
import { createControlEndpoint, type ControlChallengeAuthority } from '#src/provider-proxy/control-endpoint.js';
import { CURRENT_HANDOFF_CAPSULE_VERSION, type HandoffCapsuleV3 } from '#src/provider-proxy/handoff-capsule.js';
import { createControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import { runtimeControlTimer } from '#src/provider-proxy/role-spawn.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

function requireReadableHolderStatusRow(
  row: DirectProviderProxySetHolderStatusRow | undefined,
): DirectProviderProxySetHolderStatus {
  if (row === undefined) throw new Error('provider proxy set holder-status row was absent');
  if ('kind' in row) throw new Error(`provider proxy capsule was unreadable: ${row.path} (${row.reason})`);
  return row;
}

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

async function startClosingRole(socketPath: string): Promise<() => Promise<void>> {
  const server = createServer((socket) => {
    socket.once('data', () => socket.end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
}

describe('readProviderProxySetHolderStatusDirect', () => {
  it('distinguishes method unavailability from a connection closed after write', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'c-hs-'));
    const runtime = createRealRuntime('prod', { baseDir });
    const runDir = runtime.paths.coral.coordinator.runDir;
    runtime.storage.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const timer = runtimeControlTimer(runtime);

    const guardianSocket = join(runDir, 'g.sock');
    const reaperSocket = join(runDir, 'r.sock');
    const holder = { instanceId: randomUUID(), pid: 999, incarnation: testIncarnation(999) };
    const closeGuardian = await startAnsweringGuardian(guardianSocket, timer, holder);
    let closeReaper: (() => Promise<void>) | null = await startBareReaper(reaperSocket, timer);

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
      const reading = requireReadableHolderStatusRow(readings[0]);
      expect(reading.guardian.kind).toBe('answered');
      if (reading.guardian.kind === 'answered') {
        expect(reading.guardian.status.disposition).toBe('alive');
        expect(reading.guardian.status.enforcementHold).toBeNull();
      }
      expect(reading.reaper.kind).toBe('holder-status-unavailable');

      const rendered = formatProviderProxySetHolderStatusDirect(readings);
      expect(rendered).toContain('guardian: alive');
      expect(rendered).toContain('reaper:   unavailable');

      await closeReaper();
      closeReaper = null;
      closeReaper = await startClosingRole(reaperSocket);

      const disconnectedReadings = await readProviderProxySetHolderStatusDirect(runtime);

      expect(disconnectedReadings).toHaveLength(1);
      expect(requireReadableHolderStatusRow(disconnectedReadings[0]).reaper).toEqual({
        kind: 'unreachable',
        reason: expect.stringContaining('connection-closed-after-write'),
      });
      const disconnectedRendered = formatProviderProxySetHolderStatusDirect(disconnectedReadings);
      expect(disconnectedRendered).toContain('reaper:   unreachable (connection-closed-after-write:');
      expect(disconnectedRendered).not.toContain('reaper:   unavailable');
    } finally {
      await closeGuardian();
      await closeReaper?.();
    }
  });
});
