import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type * as fsModule from 'node:fs';

import { afterEach, expect, it, vi } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { readDiscoveryRecordDisposition } from '#src/infra/backend-discovery.js';
import { currentLaunchStatus, readLaunchStatus } from '#src/infra/launch-status.js';
import { attemptExclusiveFileLockSync, createSharedFileLockSync } from '#src/infra/fs-lock.js';
import { supervisorLockPath } from '#src/infra/path/coordinator.js';
import { validatedRunningBuildRoot } from '#src/infra/installed-build-root.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import type * as nodeProcessModule from '#src/infra/node-process.js';
import { startReplacementSupervisor } from '#src/runtime/supervisor-loss.js';

vi.mock('#src/infra/backend-discovery.js', () => ({
  readDiscoveryRecordDisposition: vi.fn(() => ({ kind: 'missing' })),
}));

vi.mock('#src/infra/upgrade-intent.js', () => ({ readUpgradeIntent: vi.fn(() => ({ kind: 'absent' })) }));

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('#src/infra/installed-build-root.js', () => ({ validatedRunningBuildRoot: vi.fn(() => '/fixture') }));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof fsModule>();
  return { ...original, existsSync: (path: string) => path.startsWith('/fixture') || original.existsSync(path) };
});
vi.mock('#src/infra/node-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof nodeProcessModule>()),
  probeProcessIncarnation: vi.fn(),
}));
vi.mock('#src/runtime/succession-attempt.js', () => ({ installReplacementSupervisorChannel: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.mocked(validatedRunningBuildRoot).mockReturnValue('/fixture');
});

it('reports namespace contention during replacement retries and nominates only after the holder releases', async () => {
  vi.useFakeTimers();
  const runDir = mkdtempSync(join(tmpdir(), 'coral-contended-replacement-retry-'));
  const replacement = Object.assign(new EventEmitter(), {
    pid: 999_991,
    connected: true,
    exitCode: null,
    signalCode: null,
    send: vi.fn(),
    kill: vi.fn(),
    unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(replacement as unknown as ChildProcess);
  vi.mocked(probeProcessIncarnation).mockReturnValue('source' as ProcessIncarnation);
  createSharedFileLockSync(supervisorLockPath(runDir))();
  const lock = attemptExclusiveFileLockSync(supervisorLockPath(runDir));
  if (lock.kind !== 'acquired') throw new Error('Missing namespace holder');
  try {
    startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), vi.fn());
    replacement.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn).toHaveBeenCalledOnce();
    const hold = {
      path: supervisorLockPath(runDir),
      disposition: 'supervisor-lock-unobservable',
      observation: 'contended',
    };
    expect(currentLaunchStatus(runDir)?.lockHold).toEqual(hold);
    expect(readLaunchStatus(runDir)).toMatchObject({ kind: 'readable', status: { lockHold: hold } });
    lock.lease();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(currentLaunchStatus(runDir)?.lockHold).toBeUndefined();
    const recovered = readLaunchStatus(runDir);
    expect(recovered.kind).toBe('readable');
    if (recovered.kind === 'readable') expect(recovered.status.lockHold).toBeUndefined();
  } finally {
    lock.lease();
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('refuses nominee retirement while fresh identity is unknown', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-authority-'));
  const replacement = Object.assign(new EventEmitter(), {
    pid: 999_993,
    connected: true,
    exitCode: null,
    signalCode: null,
    send: vi.fn(),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  vi.mocked(spawn)
    .mockClear()
    .mockReturnValue(replacement as unknown as ChildProcess);
  vi.mocked(probeProcessIncarnation).mockImplementation(
    (pid) => (pid === process.pid ? 'source' : 'launch') as ProcessIncarnation | null,
  );
  try {
    startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), vi.fn());
    vi.mocked(probeProcessIncarnation).mockImplementation(
      (pid) => (pid === process.pid ? 'source' : null) as ProcessIncarnation | null,
    );
    await vi.advanceTimersByTimeAsync(45_000);
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(readLaunchStatus(runDir)).toMatchObject({
      kind: 'readable',
      status: { signalHolds: [expect.objectContaining({ pid: replacement.pid })] },
    });
    replacement.emit('exit', 0, null);
    expect(readLaunchStatus(runDir)).toMatchObject({ kind: 'readable', status: { signalHolds: [] } });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('retries repair after source identity recovers while the accepted replacement remains responsive', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const runDir = mkdtempSync(join(tmpdir(), 'coral-source-identity-retry-'));
  let sourceKnown = true;
  let normalized = false;
  const replacement = Object.assign(new EventEmitter(), {
    pid: 999_994,
    connected: true,
    exitCode: null,
    signalCode: null,
    send: vi.fn((message: { kind: string }) => {
      if (message.kind === 'coral-recovery-challenge')
        replacement.emit('message', { ...message, kind: 'coral-recovery-answer', normalized });
    }),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(replacement as unknown as ChildProcess);
  vi.mocked(probeProcessIncarnation).mockImplementation(
    (pid) => (pid === process.pid ? (sourceKnown ? 'source' : null) : 'replacement') as ProcessIncarnation | null,
  );
  vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({
    kind: 'record',
    record: { pid: process.pid, incarnation: 'source' },
  } as ReturnType<typeof readDiscoveryRecordDisposition>);
  const repair = vi.fn(async () => {
    sourceKnown = false;
  });
  try {
    startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), repair);
    const challenge = vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env?.CORAL_RECOVERY_CHALLENGE;
    replacement.emit('message', { kind: 'coral-recovery-owned', challenge });
    replacement.emit('message', { kind: 'coral-repair-bridge-ready', challenge });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(repair).toHaveBeenCalledOnce();
    expect(currentLaunchStatus(runDir)?.admissionHolds).toContainEqual({
      path: join(runDir, 'coordinator.json'),
      disposition: 'unknown',
    });
    sourceKnown = true;
    repair.mockImplementation(async () => {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(repair.mock.calls.length).toBeGreaterThan(1);
    expect(currentLaunchStatus(runDir)?.admissionHolds).toEqual([]);
    expect(replacement.kill).not.toHaveBeenCalled();
    sourceKnown = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(currentLaunchStatus(runDir)?.admissionHolds).toHaveLength(1);
    normalized = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(currentLaunchStatus(runDir)?.admissionHolds).toEqual([]);
  } finally {
    vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({ kind: 'missing' });
    rmSync(runDir, { recursive: true, force: true });
  }
});
