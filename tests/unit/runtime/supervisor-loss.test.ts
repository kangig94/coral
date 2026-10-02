import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type * as fsModule from 'node:fs';

import { afterEach, expect, it, vi } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { readDiscoveryRecordDisposition } from '#src/infra/backend-discovery.js';
import { readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { currentLaunchStatus, readLaunchStatus, updateLaunchStatus } from '#src/infra/launch-status.js';
import { attemptExclusiveFileLockSync, createSharedFileLockSync } from '#src/infra/fs-lock.js';
import { supervisorLockPath } from '#src/infra/path/coordinator.js';
import { validatedRunningBuildRoot } from '#src/infra/retained-build-root.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import type * as nodeProcessModule from '#src/infra/node-process.js';
import { resumeLegacyUpgradeObservation, startReplacementSupervisor } from '#src/runtime/supervisor-loss.js';

vi.mock('#src/infra/backend-discovery.js', () => ({
  readDiscoveryRecordDisposition: vi.fn(() => ({ kind: 'missing' })),
}));

vi.mock('#src/infra/upgrade-intent.js', () => ({ readUpgradeIntent: vi.fn(() => ({ kind: 'absent' })) }));

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('#src/infra/retained-build-root.js', () => ({ validatedRunningBuildRoot: vi.fn(() => '/fixture') }));
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

it('keeps a missing supervisor executable visible until a validated build reappears', async () => {
  vi.useFakeTimers();
  const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-root-retry-'));
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
  vi.mocked(validatedRunningBuildRoot).mockReturnValue(null);
  const hold = {
    kind: 'no-eligible-build',
    controller: 'build',
    observation: 'supervisor-executable-unavailable',
    retry: 'eligible-build-appears',
  };
  try {
    startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), vi.fn());
    expect(spawn).not.toHaveBeenCalled();
    expect(currentLaunchStatus(runDir)?.hold).toEqual(hold);
    expect(readLaunchStatus(runDir)).toMatchObject({ kind: 'readable', status: { hold } });
    vi.mocked(validatedRunningBuildRoot).mockReturnValue('/fixture');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn).toHaveBeenCalledOnce();
    expect(currentLaunchStatus(runDir)?.hold).toBeUndefined();
    expect(readLaunchStatus(runDir)).toMatchObject({ kind: 'readable' });
    const durable = readLaunchStatus(runDir);
    if (durable.kind === 'readable') expect(durable.status.hold).toBeUndefined();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('nominates another repair owner after a failed nominee leaves malformed lock evidence', async () => {
  vi.useFakeTimers();
  const runDir = mkdtempSync(join(tmpdir(), 'coral-malformed-replacement-retry-'));
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
  try {
    startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), vi.fn());
    writeFileSync(supervisorLockPath(runDir), 'malformed namespace lock');
    replacement.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(attemptExclusiveFileLockSync(supervisorLockPath(runDir)).kind).toBe('malformed');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
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

it('publishes a source identity hold before nomination and clears it when observation recovers', async () => {
  vi.useFakeTimers();
  const runDir = mkdtempSync(join(tmpdir(), 'coral-source-identity-retry-'));
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
  vi.mocked(probeProcessIncarnation).mockReturnValue(null);
  const hold = { path: join(runDir, 'coordinator.json'), disposition: 'unknown' };
  try {
    startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), vi.fn());
    expect(spawn).not.toHaveBeenCalled();
    expect(currentLaunchStatus(runDir)?.admissionHolds).toContainEqual(hold);
    expect(readLaunchStatus(runDir)).toMatchObject({ kind: 'readable', status: { admissionHolds: [hold] } });
    vi.mocked(probeProcessIncarnation).mockReturnValue('source' as ProcessIncarnation);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn).toHaveBeenCalledOnce();
    expect(currentLaunchStatus(runDir)?.admissionHolds).toEqual([]);
    expect(readLaunchStatus(runDir)).toMatchObject({ kind: 'readable', status: { admissionHolds: [] } });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('refreshes source identity holds on every retry while the namespace lock remains contended', async () => {
  vi.useFakeTimers();
  const runDir = mkdtempSync(join(tmpdir(), 'coral-contended-source-identity-'));
  const path = join(runDir, 'coordinator.json');
  const unrelated = { path: '/unrelated-child', disposition: 'unknown' as const };
  vi.mocked(probeProcessIncarnation).mockReturnValue(null);
  createSharedFileLockSync(supervisorLockPath(runDir))();
  const lock = attemptExclusiveFileLockSync(supervisorLockPath(runDir));
  if (lock.kind !== 'acquired') throw new Error('Missing namespace holder');
  try {
    updateLaunchStatus(runDir, (status) => ({ ...status, admissionHolds: [unrelated] }));
    startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), vi.fn());
    expect(currentLaunchStatus(runDir)?.admissionHolds).toContainEqual({ path, disposition: 'unknown' });
    for (const incarnation of ['source', null, 'source'] as const) {
      vi.mocked(probeProcessIncarnation).mockReturnValue(incarnation as ProcessIncarnation | null);
      await vi.advanceTimersByTimeAsync(1_000);
      const holds = incarnation === null ? [unrelated, { path, disposition: 'unknown' }] : [unrelated];
      expect(currentLaunchStatus(runDir)?.admissionHolds).toEqual(holds);
      expect(readLaunchStatus(runDir)).toMatchObject({ kind: 'readable', status: { admissionHolds: holds } });
      expect(currentLaunchStatus(runDir)?.lockHold?.observation).toBe('contended');
      expect(spawn).not.toHaveBeenCalled();
      expect(attemptExclusiveFileLockSync(supervisorLockPath(runDir)).kind).toBe('contended');
    }
  } finally {
    lock.lease();
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('keeps an unacknowledged observation visible when the next trigger finds an occupied namespace lock', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-observation-retry-'));
  createSharedFileLockSync(supervisorLockPath(runDir))();
  const lock = attemptExclusiveFileLockSync(supervisorLockPath(runDir));
  if (lock.kind !== 'acquired') throw new Error('Fixture lock was not acquired');
  const hold = {
    kind: 'observation-unavailable' as const,
    requestId: 'observation-retry',
    observation: 'observer-acknowledgement-timed-out',
    retry: 'next-trigger' as const,
  };
  vi.mocked(readUpgradeIntent).mockReturnValue({
    kind: 'readable',
    intent: { requestId: hold.requestId, legacyRetirement: true, disposition: 'pending' },
  } as ReturnType<typeof readUpgradeIntent>);
  try {
    updateLaunchStatus(runDir, (status) => ({ ...status, hold }));
    await resumeLegacyUpgradeObservation(runDir, '/fixture', { buildSetId: 'build' } as StrictBundleManifest, 3_000);
    expect(spawn).not.toHaveBeenCalled();
    expect(readLaunchStatus(runDir)).toMatchObject({ kind: 'readable', status: { hold } });
  } finally {
    lock.lease();
    vi.mocked(readUpgradeIntent).mockReturnValue({ kind: 'absent' });
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('exposes authenticated acquisition and publication holds from its unaccepted nominee in serving memory', () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const runDir = mkdtempSync(join(tmpdir(), 'coral-nominee-acquisition-status-'));
  const replacement = Object.assign(new EventEmitter(), {
    pid: 999_992,
    connected: true,
    exitCode: null,
    signalCode: null,
    send: vi.fn(),
    kill: vi.fn(),
    unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(replacement as unknown as ChildProcess);
  vi.mocked(probeProcessIncarnation).mockReturnValue('launch' as ProcessIncarnation);
  try {
    startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), vi.fn());
    const challenge = vi.mocked(spawn).mock.calls[0]?.[2]?.env?.CORAL_RECOVERY_CHALLENGE;
    const status = {
      version: 1,
      lockHold: {
        path: supervisorLockPath(runDir),
        disposition: 'supervisor-lock-unobservable',
        observation: 'EACCES',
      },
      publicationFailure: { code: 'status-publication-unavailable', detail: 'serialization directory inaccessible' },
    };
    replacement.emit('message', { kind: 'coral-launch-status', challenge: 'foreign', status });
    expect(currentLaunchStatus(runDir)).toBeUndefined();
    replacement.emit('message', { kind: 'coral-launch-status', challenge, status });
    expect(currentLaunchStatus(runDir)).toMatchObject(status);
    expect(replacement.kill).not.toHaveBeenCalled();
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

it.each(['unknown launch', 'unknown observation', 'different incarnation', 'collected child'] as const)(
  'refuses nominee retirement with %s and retains a visible hold for a live child',
  async (fault) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-authority-'));
    const replacement = Object.assign(new EventEmitter(), {
      pid: 999_993,
      connected: true,
      exitCode: fault === 'collected child' ? 0 : null,
      signalCode: null,
      send: vi.fn(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.mocked(spawn)
      .mockClear()
      .mockReturnValue(replacement as unknown as ChildProcess);
    vi.mocked(probeProcessIncarnation).mockImplementation(
      (pid) =>
        (pid === process.pid ? 'source' : fault === 'unknown launch' ? null : 'launch') as ProcessIncarnation | null,
    );
    try {
      startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), vi.fn());
      vi.mocked(probeProcessIncarnation).mockImplementation(
        (pid) =>
          (pid === process.pid
            ? 'source'
            : fault === 'unknown observation'
              ? null
              : fault === 'different incarnation'
                ? 'reused'
                : 'launch') as ProcessIncarnation | null,
      );
      await vi.advanceTimersByTimeAsync(45_000);
      expect(replacement.kill).not.toHaveBeenCalled();
      if (fault !== 'collected child')
        expect(readLaunchStatus(runDir)).toMatchObject({
          kind: 'readable',
          status: { signalHolds: [expect.objectContaining({ pid: replacement.pid })] },
        });
      replacement.emit('exit', 0, null);
      expect(readLaunchStatus(runDir)).toMatchObject({ kind: 'readable', status: { signalHolds: [] } });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  },
);

it('keeps an accepted replacement alive while its repair bridge waits for an unhealthy child', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-acceptance-'));
  let normalized = false;
  const replacement = Object.assign(new EventEmitter(), {
    pid: 999_999,
    connected: true,
    exitCode: null,
    signalCode: null,
    send: vi.fn((message: { kind: string; id?: number; challenge?: string }) => {
      if (message.kind === 'coral-recovery-challenge')
        replacement.emit('message', { ...message, kind: 'coral-recovery-answer', normalized });
    }),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(replacement as unknown as ChildProcess);
  vi.mocked(probeProcessIncarnation).mockImplementation(
    (pid) =>
      (pid === process.pid ? 'source' : pid === replacement.pid ? 'replacement' : null) as ProcessIncarnation | null,
  );
  const onAccepted = vi.fn(async () => {});
  const onError = vi.fn();
  try {
    startReplacementSupervisor(
      '/fixture',
      runDir,
      { buildSetId: 'build' } as StrictBundleManifest,
      onError,
      onAccepted,
    );
    const challenge = vi.mocked(spawn).mock.calls[0]?.[2]?.env?.CORAL_RECOVERY_CHALLENGE;
    replacement.emit('message', { kind: 'coral-recovery-ready', challenge });
    expect(replacement.send).toHaveBeenCalledWith({ kind: 'coral-recovery-offer', challenge });
    replacement.emit('message', { kind: 'coral-recovery-owned', challenge });
    await vi.advanceTimersByTimeAsync(46_000);
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    replacement.emit('message', { kind: 'coral-repair-bridge-ready', challenge });
    await vi.advanceTimersByTimeAsync(200);
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(46_000);
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(replacement.send.mock.calls.some(([message]) => message.kind === 'coral-recovery-challenge')).toBe(true);
    normalized = true;
    await vi.advanceTimersByTimeAsync(1_000);
    const sends = replacement.send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(650_000);
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(replacement.send).toHaveBeenCalledTimes(sends);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'retires a silent accepted replacement through normalization (bridge ready: %s)',
  async (bridgeReady) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-silence-'));
    const replacement = Object.assign(new EventEmitter(), {
      pid: 999_996,
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
      (pid) => (pid === process.pid ? 'source' : 'replacement') as ProcessIncarnation,
    );
    let release: (() => void) | undefined;
    try {
      startReplacementSupervisor(
        '/fixture',
        runDir,
        { buildSetId: 'build' } as StrictBundleManifest,
        vi.fn(),
        vi.fn(async () => {}),
      );
      const challenge = vi.mocked(spawn).mock.calls[0]?.[2]?.env?.CORAL_RECOVERY_CHALLENGE;
      replacement.emit('message', { kind: 'coral-recovery-owned', challenge });
      if (bridgeReady) replacement.emit('message', { kind: 'coral-repair-bridge-ready', challenge });
      for (let index = 0; index < 610; index++) {
        replacement.emit('message', { kind: 'coral-recovery-answer', challenge, id: 0, normalized: false });
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(replacement.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(31_000);
      expect(replacement.kill).toHaveBeenCalledWith('SIGKILL');
      expect(spawn).toHaveBeenCalledOnce();
      createSharedFileLockSync(supervisorLockPath(runDir))();
      const lock = attemptExclusiveFileLockSync(supervisorLockPath(runDir));
      if (lock.kind !== 'acquired') throw new Error('Fixture lock was not acquired');
      release = lock.lease;
      replacement.emit('exit', null, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(spawn).toHaveBeenCalledOnce();
      release();
      release = undefined;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      release?.();
      rmSync(runDir, { recursive: true, force: true });
    }
  },
);

it('holds retirement when fresh replacement identity is unknown and clears refused-only commitment on fresh cooperation', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-unknown-'));
  const replacement = Object.assign(new EventEmitter(), {
    pid: 999_996,
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
  vi.mocked(probeProcessIncarnation).mockReturnValue('replacement' as ProcessIncarnation);
  vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({
    kind: 'record',
    record: { pid: process.pid, incarnation: 'replacement' },
  } as ReturnType<typeof readDiscoveryRecordDisposition>);
  const onAccepted = vi.fn(async () => {});
  try {
    startReplacementSupervisor(
      '/fixture',
      runDir,
      { buildSetId: 'build' } as StrictBundleManifest,
      vi.fn(),
      onAccepted,
    );
    const challenge = vi.mocked(spawn).mock.calls[0]?.[2]?.env?.CORAL_RECOVERY_CHALLENGE;
    replacement.emit('message', { kind: 'coral-recovery-owned', challenge });
    replacement.emit('message', { kind: 'coral-repair-bridge-ready', challenge });
    await vi.advanceTimersByTimeAsync(1_000);
    const sent = replacement.send.mock.calls.at(-1)![0] as { id: number };
    vi.mocked(probeProcessIncarnation).mockImplementation((pid) =>
      pid === process.pid ? ('replacement' as ProcessIncarnation) : null,
    );
    await vi.advanceTimersByTimeAsync(650_000);
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(readLaunchStatus(runDir)).toMatchObject({
      kind: 'readable',
      status: { signalHolds: [expect.objectContaining({ pid: replacement.pid })] },
    });
    replacement.emit('message', { kind: 'coral-recovery-answer', challenge, id: sent.id - 1, normalized: true });
    const staleHold = readLaunchStatus(runDir);
    expect(staleHold.kind === 'readable' && staleHold.status.signalHolds.length).toBe(1);
    const repairs = onAccepted.mock.calls.length;
    replacement.emit('message', { kind: 'coral-recovery-answer', challenge, id: sent.id, normalized: false });
    vi.mocked(probeProcessIncarnation).mockReturnValue('replacement' as ProcessIncarnation);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(onAccepted.mock.calls.length).toBeGreaterThan(repairs);
    const fresh = replacement.send.mock.calls.at(-1)![0] as { id: number };
    replacement.emit('message', { kind: 'coral-recovery-answer', challenge, id: fresh.id, normalized: true });
    await vi.advanceTimersByTimeAsync(650_000);
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(replacement.send).toHaveBeenCalledTimes(2);
  } finally {
    vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({ kind: 'missing' });
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('records refused replacement retirement signals until the replacement exits', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-refusal-'));
  const replacement = Object.assign(new EventEmitter(), {
    pid: 999_998,
    exitCode: null,
    signalCode: null,
    send: vi.fn(),
    kill: vi.fn((_signal: NodeJS.Signals) => false),
    unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(replacement as unknown as ChildProcess);
  vi.mocked(probeProcessIncarnation).mockImplementation(
    (pid) =>
      (pid === process.pid ? 'source' : pid === replacement.pid ? 'replacement' : null) as ProcessIncarnation | null,
  );
  try {
    startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(11_000);
    expect(replacement.kill).toHaveBeenCalledWith('SIGTERM');
    expect(readLaunchStatus(runDir)).toMatchObject({
      kind: 'readable',
      status: {
        signalHolds: [
          { launchId: `replacement:${replacement.pid}:replacement`, pid: replacement.pid, incarnation: 'replacement' },
        ],
      },
    });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(replacement.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(replacement.kill.mock.calls.every(([signal]) => signal === 'SIGTERM')).toBe(true);
    const held = readLaunchStatus(runDir);
    expect(held.kind === 'readable' ? held.status.signalHolds : []).toHaveLength(1);
    replacement.emit('exit', null, 'SIGKILL');
    const cleared = readLaunchStatus(runDir);
    expect(cleared.kind === 'readable' ? cleared.status.signalHolds : []).toEqual([]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

it.each([
  ['discovery replacement', false],
  ['completion receipt', false],
  ['source replacement', false],
  ['discovery replacement', true],
  ['completion receipt', true],
  ['source replacement', true],
] as const)('retries repair until %s settles the original coordinator (rejected: %s)', async (settledBy, rejected) => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-repair-'));
  const replacement = Object.assign(new EventEmitter(), {
    pid: 999_997,
    exitCode: null,
    signalCode: null,
    send: vi.fn(),
    kill: vi.fn(),
    unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(replacement as unknown as ChildProcess);
  vi.mocked(probeProcessIncarnation).mockReturnValue('source' as ProcessIncarnation);
  vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({
    kind: 'record',
    record: { pid: process.pid, incarnation: 'source' },
  } as ReturnType<typeof readDiscoveryRecordDisposition>);
  const onAccepted = vi.fn(async () => {
    if (rejected) throw new Error('repair is deferred');
  });
  try {
    startReplacementSupervisor(
      '/fixture',
      runDir,
      { buildSetId: 'build' } as StrictBundleManifest,
      vi.fn(),
      onAccepted,
    );
    const challenge = vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env?.CORAL_RECOVERY_CHALLENGE;
    replacement.emit('message', { kind: 'coral-recovery-owned', challenge });
    replacement.emit('message', { kind: 'coral-repair-bridge-ready', challenge });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onAccepted).toHaveBeenCalledTimes(2);
    if (settledBy === 'discovery replacement')
      vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({
        kind: 'record',
        record: { pid: replacement.pid, incarnation: 'successor' },
      } as ReturnType<typeof readDiscoveryRecordDisposition>);
    else if (settledBy === 'source replacement') {
      vi.mocked(probeProcessIncarnation).mockReturnValue('different-source' as ProcessIncarnation);
      vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({ kind: 'missing' });
    } else
      vi.mocked(readUpgradeIntent).mockReturnValue({
        kind: 'readable',
        intent: { disposition: 'completed', incumbent: { pid: process.pid, incarnation: 'source' } },
      } as ReturnType<typeof readUpgradeIntent>);
    const settledCalls = onAccepted.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onAccepted).toHaveBeenCalledTimes(settledCalls);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onAccepted).toHaveBeenCalledTimes(settledCalls);
    expect(currentLaunchStatus(runDir)?.admissionHolds).toEqual([]);
  } finally {
    vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({ kind: 'missing' });
    vi.mocked(readUpgradeIntent).mockReturnValue({ kind: 'absent' });
    rmSync(runDir, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'retries repair after missing discovery is restored (registration deferred: %s)',
  async (deferred) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const runDir = mkdtempSync(join(tmpdir(), 'coral-missing-discovery-retry-'));
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
      (pid) => (pid === process.pid ? 'source' : 'replacement') as ProcessIncarnation,
    );
    vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({ kind: 'missing' });
    const repair = vi.fn(async () => {
      if (deferred) throw new Error('repair registration is deferred');
    });
    try {
      startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), repair);
      const challenge = vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env?.CORAL_RECOVERY_CHALLENGE;
      replacement.emit('message', { kind: 'coral-recovery-owned', challenge });
      replacement.emit('message', { kind: 'coral-repair-bridge-ready', challenge });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(repair.mock.calls.length).toBeGreaterThan(1);
      expect(currentLaunchStatus(runDir)?.admissionHolds).toContainEqual({
        path: join(runDir, 'coordinator.json'),
        disposition: 'unknown',
      });
      vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({
        kind: 'record',
        record: { pid: process.pid, incarnation: 'source' },
      } as ReturnType<typeof readDiscoveryRecordDisposition>);
      repair.mockImplementation(async () => {});
      const before = repair.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(repair.mock.calls.length).toBeGreaterThan(before);
      expect(currentLaunchStatus(runDir)?.admissionHolds).toEqual([]);
      expect(replacement.kill).not.toHaveBeenCalled();
      normalized = true;
      await vi.advanceTimersByTimeAsync(1_000);
      const completed = repair.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(repair).toHaveBeenCalledTimes(completed);
    } finally {
      vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({ kind: 'missing' });
      rmSync(runDir, { recursive: true, force: true });
    }
  },
);

it('delivers TERM before starting nominee grace when identity recovers after refused retirement', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const runDir = mkdtempSync(join(tmpdir(), 'coral-nominee-restored-identity-'));
  const replacement = Object.assign(new EventEmitter(), {
    pid: 999_996,
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
  vi.mocked(probeProcessIncarnation).mockReturnValue('replacement' as ProcessIncarnation);
  try {
    startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), vi.fn());
    const challenge = vi.mocked(spawn).mock.calls[0]?.[2]?.env?.CORAL_RECOVERY_CHALLENGE;
    replacement.emit('message', { kind: 'coral-recovery-owned', challenge });
    vi.mocked(probeProcessIncarnation).mockReturnValue(null);
    await vi.advanceTimersByTimeAsync(650_000);
    expect(replacement.kill).not.toHaveBeenCalled();
    vi.mocked(probeProcessIncarnation).mockReturnValue('replacement' as ProcessIncarnation);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(replacement.kill.mock.calls).toEqual([['SIGTERM']]);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(replacement.kill.mock.calls).toEqual([['SIGTERM']]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(replacement.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    replacement.emit('exit', 0, null);
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

it.each(['linux', 'darwin'] as const)(
  'keeps delivered nominee retirement after a late ownership acknowledgement on %s',
  async (platform) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const runDir = mkdtempSync(join(tmpdir(), 'coral-late-nominee-ownership-'));
    const replacement = Object.assign(new EventEmitter(), {
      pid: 999_994,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: vi.fn(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(replacement as unknown as ChildProcess);
    vi.mocked(probeProcessIncarnation).mockReturnValue('source' as ProcessIncarnation);
    const repair = vi.fn(async () => {});
    try {
      startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), repair);
      const challenge = vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env?.CORAL_RECOVERY_CHALLENGE;
      await vi.advanceTimersByTimeAsync(11_000);
      expect(replacement.kill).toHaveBeenCalledWith('SIGTERM');
      replacement.emit('message', { kind: 'coral-recovery-owned', challenge });
      replacement.emit('message', { kind: 'coral-repair-bridge-ready', challenge });
      expect(repair).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(28_000);
      expect(replacement.kill).not.toHaveBeenCalledWith('SIGKILL');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(replacement.kill).toHaveBeenCalledWith('SIGKILL');
      expect(repair).not.toHaveBeenCalled();
      expect(replacement.send).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      rmSync(runDir, { recursive: true, force: true });
    }
  },
);

it('keeps nominee TERM grace across a forward wall-clock jump', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const runDir = mkdtempSync(join(tmpdir(), 'coral-nominee-clock-jump-'));
  const replacement = Object.assign(new EventEmitter(), {
    pid: 999_994,
    connected: true,
    exitCode: null,
    signalCode: null,
    send: vi.fn(),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(replacement as unknown as ChildProcess);
  vi.mocked(probeProcessIncarnation).mockReturnValue('source' as ProcessIncarnation);
  try {
    startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(11_000);
    expect(replacement.kill).toHaveBeenCalledWith('SIGTERM');
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(replacement.kill).not.toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(replacement.kill).toHaveBeenCalledWith('SIGKILL');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'keeps repair retries when discovery lacks an incarnation (different pid: %s)',
  async (differentPid) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const runDir = mkdtempSync(join(tmpdir(), 'coral-source-discovery-retry-'));
    const replacement = Object.assign(new EventEmitter(), {
      pid: 999_994,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: vi.fn(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(replacement as unknown as ChildProcess);
    vi.mocked(probeProcessIncarnation).mockReturnValue('source' as ProcessIncarnation);
    vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({
      kind: 'record',
      record: { pid: differentPid ? replacement.pid : process.pid },
    } as ReturnType<typeof readDiscoveryRecordDisposition>);
    const repair = vi.fn(async () => {});
    try {
      startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), repair);
      const challenge = vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env?.CORAL_RECOVERY_CHALLENGE;
      replacement.emit('message', { kind: 'coral-recovery-owned', challenge });
      replacement.emit('message', { kind: 'coral-repair-bridge-ready', challenge });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(repair.mock.calls.length).toBeGreaterThan(1);
      vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({
        kind: 'record',
        record: { pid: process.pid, incarnation: 'source' },
      } as ReturnType<typeof readDiscoveryRecordDisposition>);
      const before = repair.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(repair.mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({ kind: 'missing' });
      rmSync(runDir, { recursive: true, force: true });
    }
  },
);
