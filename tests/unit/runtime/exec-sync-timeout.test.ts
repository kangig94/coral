// `ProcessPort.execSync` must never run an unbounded synchronous subprocess.
//
// `RuntimeExecOptions.timeout` is optional so a caller can choose its own schedule, and for a while omission
// therefore meant unbounded — `spawnSync` received `timeout: undefined`. That gap was invisible to
// `tests/invariants/sync-subprocess-timeout.test.ts`, which scans for a stated bound and sees
// `timeout: execOptions.timeout` as one: a scan without a type-checker cannot tell whether that field is
// populated. So the bound at this site is held here, by a default, and asserted here rather than there.

import type * as ChildProcessModule from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const realSpawnSync = vi.hoisted(() => ({ current: null as null | typeof ChildProcessModule.spawnSync }));

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof ChildProcessModule>();
  realSpawnSync.current = actual.spawnSync;
  return { ...actual, spawnSync: spawnSyncMock };
});

import { DEFAULT_SYNC_EXEC_TIMEOUT_MS, EXEC_TIMEOUT_CODE } from '#src/infra/process-constants.js';
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

  // `spawnSync` reads `0` as no bound, so the one value that looks most like a schedule is the one that is
  // not. A `??=` default accepts it — the field is present — and the gap re-opens through a caller that
  // computed its timeout rather than writing it.
  it.each([[0], [-1]])('replaces a non-positive %s, which spawnSync would read as unbounded', (timeout) => {
    spawnSyncMock.mockReset().mockReturnValue(spawnResult());
    const runtime = createRealRuntime('prod');

    runtime.process.execSync('git', ['status'], { timeout });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'git',
      ['status'],
      expect.objectContaining({ timeout: DEFAULT_SYNC_EXEC_TIMEOUT_MS }),
    );
  });

  // Driven by the real `spawnSync` against a real slow child, because the interesting part of this boundary is
  // a translation and both sides of it were briefly invented. `spawnSync` reports a timeout as an error *plus*
  // a signal; the port replaces that error with one of its own, and for a while replaced it with a bare
  // `Error` carrying no `code`. A caller sorting "the command answered" from "the command could not be run"
  // then put the timeout on the wrong side — which is how a KB whose disk was busy stopped committing.
  it('marks a real timeout with a code a caller can sort on', () => {
    const actualSpawnSync = realSpawnSync.current;
    if (actualSpawnSync === null) throw new Error('the module mock did not capture the real spawnSync');
    spawnSyncMock.mockReset().mockImplementation(actualSpawnSync);
    const runtime = createRealRuntime('prod');

    const result = runtime.process.execSync('sleep', ['5'], { timeout: 250 });

    expect(result.status, 'a killed child has no exit status').toBeNull();
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(EXEC_TIMEOUT_CODE);
  });

  // The async twin. `exec` kills on its own timer and never sees `spawnSync`, so it synthesises its own error
  // — and for the same reason the sync path does, that error has to name the cause. `providers/cli-detection`
  // reaches this path, not the sync one, and sorts on exactly this code.
  it('marks a real async timeout with the same code', async () => {
    spawnSyncMock.mockReset();
    const runtime = createRealRuntime('prod');

    const result = await runtime.process.exec('sleep', ['5'], { timeout: 250 });

    expect(result.status, 'a killed child has no exit status').toBeNull();
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(EXEC_TIMEOUT_CODE);
  });
});
