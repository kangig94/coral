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
  // as `status: 0`, `signal: null` and `error.code: 'ENOBUFS'` — measured, and the shape is why the port reads
  // "an error with output and no signal" rather than the code: `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` is what
  // the *async* path synthesises, and never what this one receives.
  //
  // Without that branch the result still reaches a caller as a non-answer, so nothing crashes — the loss is
  // that it arrives as `ENOBUFS`, and callers sorting on the maxBuffer code stop recognising it. `import.ts`
  // is one: it tells an operator to bring a smaller source for an overflow and to retry for anything else,
  // and a retry is the one thing that cannot help here. The whole suite stayed green without this.
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

  // The shape the real subprocess above cannot be made to produce on demand, and the one that was
  // misclassified: when Node kills the child before it finishes writing, the overflow keeps its `ENOBUFS`
  // code but arrives with `status: null, signal: 'SIGTERM'` — the same shape a timeout arrives in. Measured on
  // Node 26.3.1 at roughly 1 run in 40 under CPU saturation and never on an idle machine, so it is driven by a
  // fixture here rather than by a race; the fixture is the measurement, not a guess at it.
  it('reads a signalled overflow as an overflow, not as the timeout it looks like', () => {
    spawnSyncMock.mockReset().mockReturnValue({
      stdout: 'x'.repeat(65_536),
      stderr: '',
      status: null,
      signal: 'SIGTERM',
      error: Object.assign(new Error('spawnSync sh ENOBUFS'), { code: 'ENOBUFS' }),
      pid: 1,
      output: [],
    });
    const runtime = createRealRuntime('prod');

    const result = runtime.process.execSync('sh', ['-c', 'printf %0100000d 1'], { maxBuffer: 16 });

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
