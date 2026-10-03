import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { publishLaunchAdmission } from '#src/infra/launch-admission-record.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { SENTINEL_TIMING } from '#src/infra/sentinel-timing.js';
import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import { reconcileInheritedChildren } from '#src/coordinator-launch/inherited-children.js';
import { STARTUP_BUDGET_MS } from '#src/coordinator-launch/timing.js';

vi.mock('#src/coordinator-launch/health.js', () => ({
  replacementServing: vi.fn(async () => false),
  requestInheritedSuccession: vi.fn(),
}));

it.each([
  { offset: null, admitted: true, elapsed: 3600000, wallElapsed: 3600000 },
  { offset: 120000, admitted: true, elapsed: 3600000, wallElapsed: 3600000 },
  { offset: null, admitted: true, elapsed: 3600000, wallElapsed: -3600000 },
  { offset: null, admitted: true, elapsed: 1000, wallElapsed: 3600000 },
  { offset: null, admitted: false, elapsed: 3600000, wallElapsed: 3600000 },
])('supervises a precommit attempt using admission timing: %j', async ({ offset, admitted, elapsed, wallElapsed }) => {
  const runDir = mkdtempSync('/tmp/coral-precommit-');
  const admittedAt = Date.now();
  const admittedMonotonicMs = Number(process.hrtime.bigint() / 1000000n);
  const child = { pid: process.pid, incarnation: probeProcessIncarnation(process.pid)! };
  const parent = { pid: 999999, incarnation: child.incarnation };
  const build = {
    buildSetId: 'test-build',
    bundleHash: 'test-hash',
    flavor: 'prod' as const,
    version: '0.10.16',
    storeFormatFingerprint: 'test-format',
    cliBundleHash: 'test-cli',
    claudeAppserverBundleHash: 'test-app',
    durableWrapperBundleHash: 'test-wrapper',
  };
  const admission = {
    version: 1 as const,
    launchId: randomUUID(),
    child,
    parent,
    admittedAt,
    admittedMonotonicMs,
    build,
    purpose: 'succession' as const,
  };
  if (admitted) publishLaunchAdmission(runDir, admission);
  const attemptId = 'precommit-attempt';
  const written = await compareAndSwapUpgradeIntent(runDir, null, {
    requestId: 'upgrade',
    incumbent: {
      instanceId: 'dead-incumbent',
      pid: 999998,
      incarnation: child.incarnation,
      version: '0.10.15',
      bundleHash: 'old-hash',
      flavor: 'prod',
    },
    target: { build, pluginRootLabel: '/temporary-test-build' },
    attemptId,
    attemptChild: { attemptId, ...child },
    attemptOwner: { kind: 'incumbent', instanceId: 'dead-incumbent', pid: 999998, incarnation: child.incarnation },
    attemptDeadline: offset === null ? null : new Date(admittedAt + offset).toISOString(),
    disposition: 'pending',
    blockers: [],
    retryCondition: null,
    completionReceipt: null,
  });
  expect(written.kind).toBe('written');
  expect(readUpgradeIntent(runDir).kind).toBe('readable');
  const record = new SupervisorLaunchMemory(
    runDir,
    { pid: process.pid + 100000, incarnation: child.incarnation },
    build.buildSetId,
  );
  const owner = { current: record.read().owner, lost: false, release: () => {} };
  const now = vi.spyOn(Date, 'now').mockReturnValue(admittedAt + wallElapsed);
  const monotonic = vi
    .spyOn(process.hrtime, 'bigint')
    .mockReturnValue(BigInt(admittedMonotonicMs + elapsed) * 1000000n);
  const realKill = process.kill.bind(process);
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => (signal === 0 ? realKill(pid, 0) : true));
  try {
    record.reconcileAdmissions();
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
    const slot = record.children().find((slot) => slot.child?.pid === child.pid)!;
    expect(record.supervisionEligible(slot)).toBe(admitted);
    if (admitted && elapsed >= STARTUP_BUDGET_MS) expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    else expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');
  } finally {
    monotonic.mockRestore();
    now.mockRestore();
    kill.mockRestore();
    rmSync(runDir, { recursive: true, force: true });
  }
});
