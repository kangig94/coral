import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { compareAndSwapUpgradeIntent, type UpgradeIntent } from '#src/infra/upgrade-intent.js';
import { runUpgradeWaiter } from '#src/upgrade-waiter/index.js';
import { createRealUpgradeWaiterPorts } from '#src/runtime/upgrade-waiter.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { observePendingSpawn } from '#src/upgrade-waiter/pending-spawn.js';

const directories: string[] = [];

const incumbent = {
  instanceId: 'legacy',
  pid: 1234,
  incarnation: null,
  version: '0.10.13',
  bundleHash: 'fedcba9876543210',
  flavor: 'prod' as const,
};

const build = {
  version: '0.11.0',
  buildSetId: '00000000-0000-4000-8000-000000000001',
  flavor: 'prod' as const,
  storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('upgrade waiter spawn recovery', () => {
  it('keeps a prepared record with no child identity unknown after its sentinel disappears', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-pending-spawn-prepared-'));
    directories.push(runDir);
    const recordDir = join(runDir, 'coordinator-sentinel.v1');
    mkdirSync(recordDir);
    writeFileSync(
      join(recordDir, 'prepared.json'),
      JSON.stringify({
        attemptId: 'attempt',
        spawnNonce: 'nonce',
        state: 'prepared',
        sentinelPid: 999_999_991,
      }),
    );
    expect(
      observePendingSpawn(runDir, { attemptId: 'attempt', attemptSpawnNonce: 'nonce' }, createRealUpgradeWaiterPorts()),
    ).toBe('unknown');
  });

  it('accepts a durable spawn-fenced record as proof that no child was launched', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-pending-spawn-fenced-'));
    directories.push(runDir);
    const recordDir = join(runDir, 'coordinator-sentinel.v1');
    mkdirSync(recordDir);
    writeFileSync(
      join(recordDir, 'fenced.json'),
      JSON.stringify({
        attemptId: 'attempt',
        spawnNonce: 'nonce',
        state: 'spawn-fenced',
        sentinelPid: 999_999_991,
      }),
    );
    expect(
      observePendingSpawn(runDir, { attemptId: 'attempt', attemptSpawnNonce: 'nonce' }, createRealUpgradeWaiterPorts()),
    ).toBe('absent');
  });

  it('finds a live replacement after an earlier sentinel record says exited', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-pending-spawn-records-'));
    directories.push(runDir);
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('test process has no incarnation');
    const recordDir = join(runDir, 'coordinator-sentinel.v1');
    mkdirSync(recordDir);
    writeFileSync(
      join(recordDir, 'a.json'),
      JSON.stringify({
        attemptId: 'attempt',
        spawnNonce: 'nonce',
        state: 'exited',
        sentinelPid: 999_999_991,
        coordinatorPid: 999_999_992,
      }),
    );
    writeFileSync(
      join(recordDir, 'b.json'),
      JSON.stringify({
        attemptId: 'attempt',
        spawnNonce: 'nonce',
        state: 'armed',
        sentinelPid: process.pid,
        sentinelIncarnation: incarnation,
        coordinatorPid: process.pid,
        coordinatorIncarnation: incarnation,
      }),
    );
    expect(
      observePendingSpawn(runDir, { attemptId: 'attempt', attemptSpawnNonce: 'nonce' }, createRealUpgradeWaiterPorts()),
    ).toEqual({ kind: 'child', pid: process.pid, incarnation });
  });

  it('does not launch a second target when an expired pending spawn has no decisive child record', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-red-pending-spawn-'));
    directories.push(runDir);
    const now = Date.parse('2026-09-27T00:00:00.000Z');
    const written = await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'waiting-request',
      incumbent,
      target: { build, pluginRootLabel: '/installed/target' },
      attemptId: 'unknown-spawn-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'dead-waiter', pid: 4321, incarnation: null },
      attemptChild: null,
      attemptSpawnPending: true,
      attemptSpawnNonce: 'unknown-spawn-nonce',
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: new Date(now - 1).toISOString(),
      completionReceipt: null,
    });
    expect(written.kind).toBe('written');

    const launchTarget = vi.fn(async (intent: UpgradeIntent, attemptId: string) => {
      const completed = await compareAndSwapUpgradeIntent(runDir, intent.revision, {
        ...intent,
        disposition: 'completed',
        completionReceipt: {
          kind: 'serving',
          attemptId,
          successor: { instanceId: 'replacement', pid: 5678, incarnation: null, build },
          epochKey: 'lineage:epoch-1',
          controlGeneration: 1,
          acceptedObligations: [],
          recordedAt: new Date(now).toISOString(),
        },
      });
      expect(completed.kind).toBe('written');
    });

    await expect(
      runUpgradeWaiter({
        runDir,
        socketPath: '/unused.sock',
        targetRoot: '/installed/target',
        validateTarget: () => true,
        observeRetirement: async () => 'retired',
        launchTarget,
        ports: {
          ...createRealUpgradeWaiterPorts(),
          pid: 9876,
          uuid: () => 'replacement-waiter',
          processIncarnation: () => null,
          processLiveness: () => 'absent',
          time: { now: () => now, sleep: async () => undefined },
        },
      }),
    ).resolves.toEqual({ kind: 'lease-held' });
    expect(launchTarget).not.toHaveBeenCalled();
  });
});
