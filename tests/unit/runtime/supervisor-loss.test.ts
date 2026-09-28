import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type * as fsModule from 'node:fs';

import { afterEach, expect, it, vi } from 'vitest';

import { CoordinatorLaunchRecord } from '#src/infra/coordinator-launch.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import type * as nodeProcessModule from '#src/infra/node-process.js';
import { startReplacementSupervisor } from '#src/runtime/supervisor-loss.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('#src/infra/retained-build-root.js', () => ({ validatedRunningBuildRoot: () => '/fixture' }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fsModule>()),
  existsSync: () => true,
}));
vi.mock('#src/infra/node-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof nodeProcessModule>()),
  probeProcessIncarnation: vi.fn(),
}));
vi.mock('#src/runtime/succession-attempt.js', () => ({ installReplacementSupervisorChannel: vi.fn() }));

afterEach(() => vi.useRealTimers());

it('keeps an accepted replacement alive while its repair bridge waits for an unhealthy child', async () => {
  vi.useFakeTimers();
  const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-acceptance-'));
  const replacement = Object.assign(new EventEmitter(), {
    pid: 999_999,
    send: vi.fn(),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(replacement as unknown as ChildProcess);
  vi.mocked(probeProcessIncarnation).mockImplementation(
    (pid) =>
      (pid === process.pid ? 'source' : pid === replacement.pid ? 'replacement' : null) as ProcessIncarnation | null,
  );
  const record = new CoordinatorLaunchRecord(runDir);
  const owner = record.acquire(
    { id: 'old-supervisor', process: { pid: 100, incarnation: 'old' as ProcessIncarnation }, buildSetId: 'build' },
    Date.now(),
  );
  if (owner === null) throw new Error('owner not admitted');
  const launch = record.reserve(owner, 'build', 'startup', Date.now());
  if (launch === null) throw new Error('launch not reserved');
  const source = { pid: process.pid, incarnation: 'source' as ProcessIncarnation };
  record.admit(launch, owner.process, source, Date.now());
  record.serving(launch, source);
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
    await vi.advanceTimersByTimeAsync(200);
    const recovery = record.read().recovery;
    if (recovery === undefined) throw new Error('recovery not nominated');
    record.acceptRecoveryTransfer(
      {
        id: 'replacement',
        process: { pid: replacement.pid, incarnation: 'replacement' as ProcessIncarnation },
        buildSetId: 'build',
      },
      recovery.id,
      challenge!,
      Date.now(),
    );
    await vi.advanceTimersByTimeAsync(46_000);
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    replacement.emit('message', { kind: 'coral-repair-bridge-ready', challenge });
    await vi.advanceTimersByTimeAsync(200);
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    record.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});

it('records refused replacement retirement signals until the replacement exits', async () => {
  vi.useFakeTimers();
  const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-refusal-'));
  const replacement = Object.assign(new EventEmitter(), {
    pid: 999_998,
    send: vi.fn(),
    kill: vi.fn(() => false),
    unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(replacement as unknown as ChildProcess);
  vi.mocked(probeProcessIncarnation).mockImplementation(
    (pid) =>
      (pid === process.pid ? 'source' : pid === replacement.pid ? 'replacement' : null) as ProcessIncarnation | null,
  );
  const record = new CoordinatorLaunchRecord(runDir);
  const owner = record.acquire(
    { id: 'old-supervisor', process: { pid: 100, incarnation: 'old' as ProcessIncarnation }, buildSetId: 'build' },
    Date.now(),
  );
  if (owner === null) throw new Error('owner not admitted');
  const launch = record.reserve(owner, 'build', 'startup', Date.now());
  if (launch === null) throw new Error('launch not reserved');
  const source = { pid: process.pid, incarnation: 'source' as ProcessIncarnation };
  record.admit(launch, owner.process, source, Date.now());
  record.serving(launch, source);
  try {
    startReplacementSupervisor('/fixture', runDir, { buildSetId: 'build' } as StrictBundleManifest, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(11_000);
    expect(replacement.kill).toHaveBeenCalledWith('SIGTERM');
    expect(record.read().signalHolds).toEqual([
      { launchId: `replacement:${replacement.pid}:replacement`, pid: replacement.pid, incarnation: 'replacement' },
    ]);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(replacement.kill).toHaveBeenCalledWith('SIGKILL');
    expect(record.read().signalHolds).toHaveLength(1);
    replacement.emit('exit', null, 'SIGKILL');
    expect(record.read().signalHolds).toEqual([]);
  } finally {
    record.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});
