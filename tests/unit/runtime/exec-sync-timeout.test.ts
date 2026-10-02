import type * as ChildProcessModule from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof ChildProcessModule>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import { DEFAULT_SYNC_EXEC_TIMEOUT_MS, EXEC_MAXBUFFER_CODE, EXEC_TIMEOUT_CODE } from '#src/infra/process-constants.js';
import { createRealRuntime } from '#src/runtime/real.js';

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
});
