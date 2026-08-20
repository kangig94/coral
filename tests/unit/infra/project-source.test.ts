import { basename } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type ProjectSourceModule = typeof import('#src/infra/project-source.js');
type ExecOptions = {
  cwd?: string;
};

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

async function loadProjectSourceModule(): Promise<ProjectSourceModule> {
  vi.resetModules();
  return import('#src/infra/project-source.js');
}

function remoteForProjectRoot(projectRoot: string): string {
  return `git@github.com:owner/${basename(projectRoot)}.git\n`;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  execFileSyncMock.mockReset();
  vi.resetModules();
});

describe('resolveProjectSource', () => {
  // What may be remembered, by failure mode. The shapes are what `execFileSync` actually produces — verified
  // against Node, not assumed: a non-zero exit carries `status`, a missing binary carries `code: 'ENOENT'` with
  // `status: null`, and a timeout carries `code: 'ETIMEDOUT'` with `status: null`.
  const failure = (props: Record<string, unknown>): Error => Object.assign(new Error('probe failed'), props);

  // Only a launch that actually ran and exited is decisive here. `ENOENT`/`EACCES` moved out of this group:
  // a missing or unexecutable git binary is a standing fact about the *machine*, not a report about whether
  // *this project* has a remote (`process-constants.ts`'s `STANDING_PROBE_ERRNOS` docstring), so caching it as
  // "no remote" is the same durably-wrong-answer shape as caching a timeout would be. They now live in the
  // "re-probes rather than caching" group below, alongside every other non-answer.
  it('caches the local fallback after a non-zero exit — there is no remote, and re-asking cannot change that', async () => {
    const { resolveProjectSource } = await loadProjectSourceModule();
    execFileSyncMock.mockImplementation(() => {
      throw failure({ status: 128 });
    });

    expect(resolveProjectSource('/tmp/some-project')).toBe('local/some-project');
    expect(resolveProjectSource('/tmp/some-project')).toBe('local/some-project');
    expect(execFileSyncMock, 'a decisive answer is asked once').toHaveBeenCalledOnce();
  });

  // `classifyThrownExecOutcome` guards `typeof error !== 'object' || error === null` before reading `.code`.
  // `null` is the case that needs it: without the guard, reading `.status` off it throws a TypeError from
  // inside the `catch`, so it escapes `resolveProjectSource` entirely — a probe whose whole contract is to
  // fall back quietly instead crashes its caller. A thrown string reaches the same answer either way, which is
  // why asserting only that one asserted nothing about the guard.
  it.each([
    ['null', null],
    ['a bare string', 'git exploded'],
  ])('treats %s thrown from the probe as a non-answer rather than crashing on it', async (label, thrown) => {
    const { resolveProjectSource } = await loadProjectSourceModule();
    const root = `/tmp/thrown-${label.replace(/\s+/g, '-')}`;
    execFileSyncMock.mockImplementation(() => {
      // Deliberately not an Error: that is the input under test. `classifyThrownExecOutcome` guards against it
      // because a throw is not required to carry one, and the guard is what keeps a probe that must fall back
      // quietly from crashing its caller instead.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw thrown;
    });

    expect(resolveProjectSource(root)).toBe(`local/${root.slice('/tmp/'.length)}`);

    vi.setSystemTime(Date.now() + 61_000);
    execFileSyncMock.mockImplementation(() => remoteForProjectRoot(root));

    expect(resolveProjectSource(root), 'and it is a non-answer, so it expires').toBe(
      `owner/${root.slice('/tmp/'.length)}`,
    );
  });

  // `ETIMEDOUT`/`EAGAIN`/`ESTALE`/`EWOULDBLOCKX` are `no-answer` outright — the launch never produced a verdict.
  // `ENOENT`/`EACCES` are `launch-refused`: a *standing* fact about the machine (git will not appear under a
  // running daemon), but not a *decisive* one about this project's remote, which is the only question this
  // function asks (`process-constants.ts`'s `STANDING_PROBE_ERRNOS` docstring draws the distinction). Both
  // kinds reach the same indecisive-with-expiry path here, which is what this shared test proves — a caller
  // asking a domain question may not tell them apart, even though `classifyThrownExecOutcome` does. The
  // enumeration itself is on the standing side so that an errno nobody thought of is NOT cached as a fact; it
  // is not trying to be exhaustive and should not grow toward it — `EWOULDBLOCKX` is the case that matters,
  // because an errno this codebase has never heard of is the one a future revision will also not have heard of.
  it.each([
    ['ETIMEDOUT — the mount did not answer in time', 'ETIMEDOUT'],
    ['EAGAIN — no process slot right now', 'EAGAIN'],
    ['ESTALE — a stalled mount reporting immediately', 'ESTALE'],
    ['EWOULDBLOCKX — an errno this list has never heard of', 'EWOULDBLOCKX'],
    ['ENOENT — a missing git binary answers nothing about this project', 'ENOENT'],
    ['EACCES — a git binary this process may not execute answers nothing about this project', 'EACCES'],
  ])('re-probes rather than caching after %s', async (_label, code) => {
    const { resolveProjectSource } = await loadProjectSourceModule();
    execFileSyncMock.mockImplementationOnce(() => {
      throw failure({ status: null, code });
    });

    expect(resolveProjectSource('/tmp/busy'), 'the fallback is still answered').toBe('local/busy');

    vi.setSystemTime(Date.now() + 61_000);
    execFileSyncMock.mockImplementation(() => remoteForProjectRoot('/tmp/busy'));
    expect(resolveProjectSource('/tmp/busy'), 'and re-probed once the system can run it').toBe('owner/busy');
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  // The other half of that decision, and the reason it is an expiry rather than "never cache": this function is
  // called once per row inside `snapshotsForSource`, so re-probing on every call turns one stalled mount into
  // one blocking probe per row.
  it('does not re-probe a wedged root on every call within the interval', async () => {
    const { resolveProjectSource } = await loadProjectSourceModule();
    execFileSyncMock.mockImplementation(() => {
      throw failure({ status: null, code: 'ETIMEDOUT' });
    });

    for (let i = 0; i < 8; i += 1) {
      expect(resolveProjectSource('/tmp/wedged')).toBe('local/wedged');
    }

    expect(execFileSyncMock, 'eight rows on one wedged root cost one probe, not eight').toHaveBeenCalledOnce();
  });

  it('evicts cached entries past the project source cache cap', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, _args: string[], options: ExecOptions): string =>
      remoteForProjectRoot(options.cwd ?? '/tmp/missing'),
    );
    const { PROJECT_SOURCE_MAP_MAX_ENTRIES, resolveProjectSource } = await loadProjectSourceModule();
    const baseRoot = '/tmp/coral-project-source-cache';
    const firstRoot = `${baseRoot}/repo-0`;

    expect(resolveProjectSource(firstRoot)).toBe('owner/repo-0');
    for (let index = 1; index <= PROJECT_SOURCE_MAP_MAX_ENTRIES; index += 1) {
      expect(resolveProjectSource(`${baseRoot}/repo-${index}`)).toBe(`owner/repo-${index}`);
    }

    const callsAfterFill = execFileSyncMock.mock.calls.length;
    expect(callsAfterFill).toBe(PROJECT_SOURCE_MAP_MAX_ENTRIES + 1);
    expect(resolveProjectSource(firstRoot)).toBe('owner/repo-0');
    expect(execFileSyncMock).toHaveBeenCalledTimes(callsAfterFill + 1);
  });

  // The test above fills one past the cap either way, so a cap guard mutated from `>` to `>=` still evicts
  // `firstRoot` — both land well past the boundary, and the assertion cannot tell which line was responsible.
  // This pins the boundary itself: exactly at the cap, nothing has been evicted yet. It also isolates *which*
  // map is under test by construction rather than by inspecting internal state — `execFileSyncMock` never
  // throws here, so the code never reaches the `catch` branch at all, and only `rememberProjectSource`'s own
  // eviction loop (never `rememberIndecisiveProbe`'s, on the untouched `indecisiveProbeAt` map) can be
  // responsible for whatever this test observes.
  it('does not evict anything while still exactly at the project source cache cap', async () => {
    execFileSyncMock.mockImplementation((_cmd: string, _args: string[], options: ExecOptions): string =>
      remoteForProjectRoot(options.cwd ?? '/tmp/missing'),
    );
    const { PROJECT_SOURCE_MAP_MAX_ENTRIES, resolveProjectSource } = await loadProjectSourceModule();
    const baseRoot = '/tmp/coral-project-source-cache-boundary';
    const firstRoot = `${baseRoot}/repo-0`;

    expect(resolveProjectSource(firstRoot)).toBe('owner/repo-0');
    // firstRoot plus (MAX - 1) more is exactly MAX entries — the cap, not one past it.
    for (let index = 1; index < PROJECT_SOURCE_MAP_MAX_ENTRIES; index += 1) {
      expect(resolveProjectSource(`${baseRoot}/repo-${index}`)).toBe(`owner/repo-${index}`);
    }

    const callsAtCap = execFileSyncMock.mock.calls.length;
    expect(callsAtCap).toBe(PROJECT_SOURCE_MAP_MAX_ENTRIES);
    expect(resolveProjectSource(firstRoot), 'still within the cap, so this must be a cache hit').toBe('owner/repo-0');
    expect(
      execFileSyncMock,
      'a cache hit must not fork — a `>=` cap guard would already have evicted this',
    ).toHaveBeenCalledTimes(callsAtCap);
  });

  // Mirrors the cache-eviction test above, but for the other map the same cap bounds: `indecisiveProbeAt`.
  // The clock never advances in this test, so the hold (`INDECISIVE_PROBE_REPROBE_INTERVAL_MS`) would still
  // cover `firstRoot` if its entry survived — the only way a second probe happens is that eviction pushed it
  // out first.
  it('evicts indecisive-probe entries past the project source map cap', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw failure({ status: null, code: 'EAGAIN' });
    });
    const { PROJECT_SOURCE_MAP_MAX_ENTRIES, resolveProjectSource } = await loadProjectSourceModule();
    const baseRoot = '/tmp/coral-indecisive-map-cache';
    const firstRoot = `${baseRoot}/repo-0`;

    expect(resolveProjectSource(firstRoot)).toBe('local/repo-0');
    for (let index = 1; index <= PROJECT_SOURCE_MAP_MAX_ENTRIES; index += 1) {
      expect(resolveProjectSource(`${baseRoot}/repo-${index}`)).toBe(`local/repo-${index}`);
    }

    const callsAfterFill = execFileSyncMock.mock.calls.length;
    expect(callsAfterFill).toBe(PROJECT_SOURCE_MAP_MAX_ENTRIES + 1);
    expect(
      resolveProjectSource(firstRoot),
      'still within the hold interval, so a surviving entry would have skipped this probe',
    ).toBe('local/repo-0');
    expect(execFileSyncMock, "firstRoot's entry was evicted, so the hold could not find it").toHaveBeenCalledTimes(
      callsAfterFill + 1,
    );
  });

  // The indecisive-map mirror of the cache-cap boundary test above, isolated the same way: `execFileSyncMock`
  // always throws here, so only `rememberIndecisiveProbe`'s eviction loop (on `indecisiveProbeAt`) is ever
  // reached — `rememberProjectSource`'s cap logic on the untouched decisive-answer map cannot be responsible
  // for anything this test observes.
  it('does not evict anything while still exactly at the indecisive-probe map cap', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw failure({ status: null, code: 'EAGAIN' });
    });
    const { PROJECT_SOURCE_MAP_MAX_ENTRIES, resolveProjectSource } = await loadProjectSourceModule();
    const baseRoot = '/tmp/coral-indecisive-map-cache-boundary';
    const firstRoot = `${baseRoot}/repo-0`;

    expect(resolveProjectSource(firstRoot)).toBe('local/repo-0');
    for (let index = 1; index < PROJECT_SOURCE_MAP_MAX_ENTRIES; index += 1) {
      expect(resolveProjectSource(`${baseRoot}/repo-${index}`)).toBe(`local/repo-${index}`);
    }

    const callsAtCap = execFileSyncMock.mock.calls.length;
    expect(callsAtCap).toBe(PROJECT_SOURCE_MAP_MAX_ENTRIES);
    // Re-reading firstRoot cannot distinguish a surviving hold from a fresh probe the way the decisive map's
    // cache hit does (both return the same `local/repo-0` fallback), so the discriminator is the fork count,
    // not the return value: a surviving hold must not fork again.
    expect(resolveProjectSource(firstRoot)).toBe('local/repo-0');
    expect(
      execFileSyncMock,
      'a `>=` cap guard would already have evicted this and re-forked to fill the hold again',
    ).toHaveBeenCalledTimes(callsAtCap);
  });

  // §11: "Tolerance is not silence." This is the one whose value lands on disk — `projectData` derives a
  // directory from the fallback, so a memo written now is filed under a name a later read will not look for.
  it('says so when it could not derive the source, rather than falling back in silence', async () => {
    // Loaded first: `loadProjectSourceModule` calls `vi.resetModules()`, so a `backendLog` imported before it
    // is a different module instance from the one the subject captured, and the spy would never fire.
    const { resolveProjectSource } = await loadProjectSourceModule();
    const { backendLog } = await import('#src/infra/backend-log.js');
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    execFileSyncMock.mockImplementation(() => {
      throw failure({ status: null, code: 'EAGAIN' });
    });

    expect(resolveProjectSource('/tmp/quiet')).toBe('local/quiet');

    expect(warn).toHaveBeenCalledTimes(1);
    const [line] = warn.mock.calls[0] as [string];
    expect(line).toContain('/tmp/quiet');
    expect(line, 'the errno is what tells an operator this is not "no remote"').toContain('EAGAIN');
    expect(line, 'and it must not read as a fact about the project').toMatch(/not a statement/u);
    warn.mockRestore();
  });

  it('stays quiet when the probe answered, whatever the answer', async () => {
    const { resolveProjectSource } = await loadProjectSourceModule();
    const { backendLog } = await import('#src/infra/backend-log.js');
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    execFileSyncMock.mockImplementation(() => {
      throw failure({ status: 128 });
    });

    expect(resolveProjectSource('/tmp/no-remote')).toBe('local/no-remote');

    expect(warn, 'a project with no git remote is ordinary, not a condition to report').not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // `GIT_REMOTE_PROBE_TIMEOUT_MS`'s JSDoc is asserted as source text elsewhere, but that only proves a
  // `timeout:` literal exists somewhere in the file — not that it reaches `execFileSync`. This inspects the
  // actual call options.
  it('passes the documented probe timeout through to execFileSync', async () => {
    const { resolveProjectSource } = await loadProjectSourceModule();
    execFileSyncMock.mockImplementation(() => remoteForProjectRoot('/tmp/timeout-wiring'));

    resolveProjectSource('/tmp/timeout-wiring');

    const options = execFileSyncMock.mock.calls[0]?.[2] as { timeout?: number } | undefined;
    expect(options?.timeout, 'the 2s documented on GIT_REMOTE_PROBE_TIMEOUT_MS must reach the child').toBe(2_000);
  });
});
