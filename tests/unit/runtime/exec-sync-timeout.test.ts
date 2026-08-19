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

  // The other substituted error, driven the same way and for the same reason. `spawnSync` reports an overflow
  // as `error.code: 'ENOBUFS'` regardless of shape, and this is the shape a single-burst writer produces:
  // `status: 0`, `signal: null`, because the child had already finished writing before Node's overflow kill
  // could land. `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` is what the *async* path synthesises, and never what this
  // one receives.
  it('marks a real maxBuffer overflow with a code a caller can sort on', () => {
    const actualSpawnSync = realSpawnSync.current;
    if (actualSpawnSync === null) throw new Error('the module mock did not capture the real spawnSync');
    spawnSyncMock.mockReset().mockImplementation(actualSpawnSync);
    const runtime = createRealRuntime('prod');

    // The bound is a stuck-child backstop, not part of the scenario: `printf` emits 100KB at once, so the
    // overflow is what ends this run whatever the bound is.
    const result = runtime.process.execSync('sh', ['-c', 'printf %0100000d 1'], { maxBuffer: 16, timeout: 5_000 });

    expect(result.status, 'a truncated read is not an exit status worth reporting').toBeNull();
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(EXEC_MAXBUFFER_CODE);
    expect(result.stdout.length, 'and what did arrive is kept, because it is evidence of the overflow').toBeGreaterThan(
      0,
    );
  });

  // The shape a child that is still running when the overflow kill lands produces: `ENOBUFS` arrives with
  // `status: null, signal: 'SIGTERM'` — the same shape a timeout arrives in. The `sleep 0.3` keeps the child
  // alive past its own first (overflowing) write so the kill reaches a live process instead of a reaped one;
  // measured at 20/20 on an idle machine, against the single-burst writer's 20/20 the other shape, so this is
  // the exit race, not load, and reproducible on demand.
  it('reads a signalled overflow as an overflow, not as the timeout it looks like', () => {
    const actualSpawnSync = realSpawnSync.current;
    if (actualSpawnSync === null) throw new Error('the module mock did not capture the real spawnSync');
    spawnSyncMock.mockReset().mockImplementation(actualSpawnSync);
    const runtime = createRealRuntime('prod');

    const result = runtime.process.execSync('sh', ['-c', 'printf %040d 1; sleep 0.3; printf x'], { maxBuffer: 16 });

    expect(result.status, 'a killed child has no exit status').toBeNull();
    expect((result.error as NodeJS.ErrnoException | undefined)?.code, 'the code is stable across both shapes').toBe(
      EXEC_MAXBUFFER_CODE,
    );
    expect(result.stdout.length, 'what did arrive is still evidence of the overflow').toBeGreaterThan(0);
  });

  // A timeout arrives in that same signalled shape, and must not be read as an overflow now that the code
  // decides. `spawnSync` names it `ETIMEDOUT`; nothing else here does.
  it('still reads a signalled timeout as a timeout', () => {
    spawnSyncMock.mockReset().mockReturnValue({
      stdout: 'hi',
      stderr: '',
      status: null,
      signal: 'SIGTERM',
      error: Object.assign(new Error('spawnSync sh ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      pid: 1,
      output: [],
    });
    const runtime = createRealRuntime('prod');

    const result = runtime.process.execSync('sh', ['-c', 'printf hi; sleep 5'], { timeout: 250 });

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
