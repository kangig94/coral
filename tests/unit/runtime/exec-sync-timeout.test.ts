import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as ChildProcessModule from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof ChildProcessModule>();
  return { ...actual, spawnSync: spawnSyncMock, spawn: spawnMock };
});

import { DEFAULT_SYNC_EXEC_TIMEOUT_MS, EXEC_MAXBUFFER_CODE, EXEC_TIMEOUT_CODE } from '#src/infra/process-constants.js';
import { createRealRuntime } from '#src/runtime/real.js';

afterEach(() => vi.useRealTimers());

function spawnResult() {
  return { stdout: '', stderr: '', status: 0, signal: null, error: undefined, pid: 1, output: [] };
}

describe('ProcessPort.execSync bound', () => {
  it('applies a default timeout when the caller names none', () => {
    spawnSyncMock.mockReset().mockReturnValue(spawnResult());
    const runtime = createRealRuntime('prod');

    runtime.process.execSync('git', ['status']);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'git',
      ['status'],
      expect.objectContaining({ timeout: DEFAULT_SYNC_EXEC_TIMEOUT_MS }),
    );
  });

  it("keeps the caller's own schedule when one is given", () => {
    spawnSyncMock.mockReset().mockReturnValue(spawnResult());
    const runtime = createRealRuntime('prod');

    runtime.process.execSync('git', ['status'], { timeout: 1_500 });

    expect(spawnSyncMock).toHaveBeenCalledWith('git', ['status'], expect.objectContaining({ timeout: 1_500 }));
  });

  it('replaces a disabled timeout with the default bound', () => {
    spawnSyncMock.mockReset().mockReturnValue(spawnResult());
    const runtime = createRealRuntime('prod');

    runtime.process.execSync('git', ['status'], { timeout: 0 });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'git',
      ['status'],
      expect.objectContaining({ timeout: DEFAULT_SYNC_EXEC_TIMEOUT_MS }),
    );
  });

  it('translates a signalled timeout to the timeout code', () => {
    spawnSyncMock.mockReset().mockReturnValue({
      ...spawnResult(),
      stdout: 'hi',
      status: null,
      signal: 'SIGTERM',
      error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    });
    const runtime = createRealRuntime('prod');

    const result = runtime.process.execSync('fixture', [], { timeout: 250 });

    expect(result.status).toBeNull();
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(EXEC_TIMEOUT_CODE);
  });

  it('translates a signalled overflow without confusing it with a timeout', () => {
    spawnSyncMock.mockReset().mockReturnValue({
      ...spawnResult(),
      stdout: 'partial output',
      status: null,
      signal: 'SIGTERM',
      error: Object.assign(new Error('spawnSync ENOBUFS'), { code: 'ENOBUFS' }),
    });
    const runtime = createRealRuntime('prod');

    const result = runtime.process.execSync('fixture', [], { maxBuffer: 16 });

    expect(result.status).toBeNull();
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(EXEC_MAXBUFFER_CODE);
    expect(result.stdout).toBe('partial output');
  });

  it('marks an async timeout with the same code', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 1234,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    spawnMock.mockReset().mockReturnValue(child);
    const runtime = createRealRuntime('prod');
    runtime.process.kill = vi.fn(() => true);

    const pending = runtime.process.exec('fixture', [], { timeout: 250 });
    await vi.advanceTimersByTimeAsync(250);
    child.emit('close', null, 'SIGTERM');
    const result = await pending;

    expect(result.status).toBeNull();
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(EXEC_TIMEOUT_CODE);
  });
});
