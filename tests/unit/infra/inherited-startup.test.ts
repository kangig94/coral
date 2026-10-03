import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { publishLaunchAdmission } from '#src/infra/launch-admission-record.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { SENTINEL_TIMING } from '#src/infra/sentinel-timing.js';
import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import { reconcileInheritedChildren } from '#src/coordinator-launch/inherited-children.js';
import { replacementServing } from '#src/coordinator-launch/health.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STARTUP_BUDGET_MS } from '#src/coordinator-launch/timing.js';

vi.mock('#src/coordinator-launch/health.js', () => ({
  replacementServing: vi.fn(async () => false),
  requestInheritedSuccession: vi.fn(),
}));

it.each([
  { discovered: false, health: false, discoveryRecord: false },
  { discovered: true, health: false, discoveryRecord: false },
  { discovered: true, health: false, discoveryRecord: true },
  { discovered: true, health: true, discoveryRecord: true },
])('preserves startup supervision until readiness is observed: %j', async ({ discovered, health, discoveryRecord }) => {
  vi.mocked(replacementServing).mockResolvedValue(health);
  const runDir = mkdtempSync('/tmp/coral-startup-');
  const admittedAt = Date.now();
  const admittedMonotonicMs = Number(process.hrtime.bigint() / 1000000n);
  const parent = { pid: process.ppid, incarnation: probeProcessIncarnation(process.ppid)! };
  const child = { pid: process.pid, incarnation: probeProcessIncarnation(process.pid)! };
  const build = { buildSetId: 'test-build', bundleHash: 'test-hash', flavor: 'prod' as const, version: '0.10.16' };
  const launchId = randomUUID();
  publishLaunchAdmission(runDir, {
    version: 1,
    launchId,
    child,
    parent,
    admittedAt,
    admittedMonotonicMs,
    build,
    purpose: 'startup',
    ...(discovered ? { discoveredAt: admittedAt + 1000 } : {}),
  });
  if (discoveryRecord)
    writeFileSync(
      join(runDir, 'coordinator.json'),
      JSON.stringify({
        pid: child.pid,
        incarnation: child.incarnation,
        bootToken: 'test',
        port: 1,
        socketPath: '/tmp/fixture.sock',
        startedAt: admittedAt,
        token: 'test',
        version: build.version,
        bundleHash: build.bundleHash,
        flavor: 'prod',
        namespace: 'test',
        instanceId: 'test',
        supervision: { version: 1, launchId, buildSetId: build.buildSetId, parent, admittedAt, purpose: 'startup' },
      }),
    );
  const ownerIdentity = { pid: process.pid + 100000, incarnation: child.incarnation };
  const record = new SupervisorLaunchMemory(runDir, ownerIdentity, build.buildSetId);
  const owner = { current: record.read().owner, lost: false, release: () => {} };
  const realKill = process.kill.bind(process);
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => (signal === 0 ? realKill(pid, 0) : true));
  const now = vi.spyOn(Date, 'now').mockReturnValue(admittedAt + STARTUP_BUDGET_MS + 1);
  const monotonic = vi
    .spyOn(process.hrtime, 'bigint')
    .mockReturnValue(BigInt(admittedMonotonicMs + STARTUP_BUDGET_MS + 1) * 1000000n);
  try {
    await reconcileInheritedChildren({
      record,
      owner,
      runDir,
      originalManifest: build as never,
      incarnation: child.incarnation,
      timing: SENTINEL_TIMING,
      startupBudgetMs: STARTUP_BUDGET_MS,
      lastInheritedRequest: new Map(),
      replacement: false,
      recoveryChallenge: undefined,
      repairBridge: null,
    });
    if (health) {
      expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(record.read().launch?.phase).toBe('serving');
    } else expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  } finally {
    monotonic.mockRestore();
    now.mockRestore();
    kill.mockRestore();
    rmSync(runDir, { recursive: true, force: true });
  }
});
