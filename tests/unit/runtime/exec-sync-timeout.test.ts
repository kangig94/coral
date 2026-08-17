// `ProcessPort.execSync` must never run an unbounded synchronous subprocess.
//
// `RuntimeExecOptions.timeout` is optional so a caller can choose its own schedule, and for a while omission
// therefore meant unbounded — `spawnSync` received `timeout: undefined`. That gap was invisible to
// `tests/invariants/sync-subprocess-timeout.test.ts`, which scans for a stated bound and sees
// `timeout: execOptions.timeout` as one: a scan without a type-checker cannot tell whether that field is
// populated. So the bound at this site is held here, by a default, and asserted here rather than there.

import { describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import { DEFAULT_SYNC_EXEC_TIMEOUT_MS } from '#src/infra/process-constants.js';
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
});
