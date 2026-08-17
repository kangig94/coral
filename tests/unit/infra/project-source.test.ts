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

  it.each([
    ['a non-zero exit — there is no remote, and re-asking cannot change that', { status: 128 }],
    // The regression this pins: a predicate keyed on `status` being a number made a machine without git
    // re-spawn it on every call for the daemon's lifetime.
    ['a missing git binary — git will not appear under a running daemon', { status: null, code: 'ENOENT' }],
    ['a git binary that may not be executed', { status: null, code: 'EACCES' }],
  ])('caches the local fallback after %s', async (_label, props) => {
    const { resolveProjectSource } = await loadProjectSourceModule();
    execFileSyncMock.mockImplementation(() => {
      throw failure(props);
    });

    expect(resolveProjectSource('/tmp/some-project')).toBe('local/some-project');
    expect(resolveProjectSource('/tmp/some-project')).toBe('local/some-project');
    expect(execFileSyncMock, 'a standing fact is asked once').toHaveBeenCalledOnce();
  });

  // The enumeration is on the standing side so that an errno nobody thought of is NOT cached as a fact. The
  // first three were each missed by one of the earlier transient-side revisions. The list is not trying to be
  // exhaustive and should not grow toward it — `EWOULDBLOCKX` is the case that matters, because an errno this
  // codebase has never heard of is the one a future revision will also not have heard of.
  it.each([
    ['ETIMEDOUT — the mount did not answer in time', 'ETIMEDOUT'],
    ['EAGAIN — no process slot right now', 'EAGAIN'],
    ['ESTALE — a stalled mount reporting immediately', 'ESTALE'],
    ['EWOULDBLOCKX — an errno this list has never heard of', 'EWOULDBLOCKX'],
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
    const { PROJECT_SOURCE_CACHE_MAX_ENTRIES, resolveProjectSource } = await loadProjectSourceModule();
    const baseRoot = '/tmp/coral-project-source-cache';
    const firstRoot = `${baseRoot}/repo-0`;

    expect(resolveProjectSource(firstRoot)).toBe('owner/repo-0');
    for (let index = 1; index <= PROJECT_SOURCE_CACHE_MAX_ENTRIES; index += 1) {
      expect(resolveProjectSource(`${baseRoot}/repo-${index}`)).toBe(`owner/repo-${index}`);
    }

    const callsAfterFill = execFileSyncMock.mock.calls.length;
    expect(callsAfterFill).toBe(PROJECT_SOURCE_CACHE_MAX_ENTRIES + 1);
    expect(resolveProjectSource(firstRoot)).toBe('owner/repo-0');
    expect(execFileSyncMock).toHaveBeenCalledTimes(callsAfterFill + 1);
  });
});
