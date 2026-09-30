import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type * as fsModule from 'node:fs';

import { afterEach, expect, it, vi } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { readDiscoveryRecordDisposition } from '#src/infra/backend-discovery.js';
import { readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { readLaunchStatus } from '#src/infra/launch-status.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import type * as nodeProcessModule from '#src/infra/node-process.js';
import { startReplacementSupervisor } from '#src/runtime/supervisor-loss.js';

vi.mock('#src/infra/backend-discovery.js', () => ({
  readDiscoveryRecordDisposition: vi.fn(() => ({ kind: 'missing' })),
}));

vi.mock('#src/infra/upgrade-intent.js', () => ({ readUpgradeIntent: vi.fn(() => ({ kind: 'absent' })) }));

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
  } finally {
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
    expect(replacement.kill).toHaveBeenCalledWith('SIGKILL');
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
  ['discovery replacement', true],
  ['completion receipt', true],
] as const)('retries repair until %s settles the original coordinator (rejected: %s)', async (settledBy, rejected) => {
  vi.useFakeTimers();
  const runDir = mkdtempSync(join(tmpdir(), 'coral-replacement-repair-'));
  const replacement = Object.assign(new EventEmitter(), {
    pid: 999_997,
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
      vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({ kind: 'missing' });
    else
      vi.mocked(readUpgradeIntent).mockReturnValue({
        kind: 'readable',
        intent: { disposition: 'completed', incumbent: { pid: process.pid, incarnation: 'source' } },
      } as ReturnType<typeof readUpgradeIntent>);
    const settledCalls = onAccepted.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onAccepted).toHaveBeenCalledTimes(settledCalls);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onAccepted).toHaveBeenCalledTimes(settledCalls);
  } finally {
    vi.mocked(readDiscoveryRecordDisposition).mockReturnValue({ kind: 'missing' });
    vi.mocked(readUpgradeIntent).mockReturnValue({ kind: 'absent' });
    rmSync(runDir, { recursive: true, force: true });
  }
});
