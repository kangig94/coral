import { basename } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  execFileSyncMock.mockReset();
  vi.resetModules();
});

describe('resolveProjectSource', () => {
  // What may be remembered, by failure mode. The three shapes are what `execFileSync` actually produces —
  // verified against Node, not assumed: a non-zero exit carries `status`, a missing binary carries
  // `code: 'ENOENT'` with `status: null`, and a timeout carries `code: 'ETIMEDOUT'` with `status: null`.
  const failure = (props: Record<string, unknown>): Error => Object.assign(new Error('probe failed'), props);

  it.each([
    ['a non-zero exit — there is no remote, and re-asking cannot change that', { status: 128 }],
    // The regression this pins: an earlier predicate keyed on `status` being a number, so a machine without
    // git re-spawned it on every call for the daemon's lifetime.
    ['a missing git binary — git will not appear under a running daemon', { status: null, code: 'ENOENT' }],
  ])('caches the local fallback after %s', async (_label, props) => {
    const { resolveProjectSource } = await loadProjectSourceModule();
    execFileSyncMock.mockImplementation(() => {
      throw failure(props);
    });

    expect(resolveProjectSource('/tmp/some-project')).toBe('local/some-project');
    expect(resolveProjectSource('/tmp/some-project')).toBe('local/some-project');
    expect(execFileSyncMock, 'a standing fact is asked once').toHaveBeenCalledOnce();
  });

  it('does not cache the local fallback after a timeout, so a recovered mount self-heals', async () => {
    const { resolveProjectSource } = await loadProjectSourceModule();
    execFileSyncMock.mockImplementationOnce(() => {
      throw failure({ status: null, code: 'ETIMEDOUT', signal: 'SIGTERM' });
    });

    expect(resolveProjectSource('/tmp/wedged'), 'the fallback is still answered').toBe('local/wedged');

    execFileSyncMock.mockImplementation(() => remoteForProjectRoot('/tmp/wedged'));
    expect(resolveProjectSource('/tmp/wedged'), 'and re-probed once the mount answers').toBe('owner/wedged');
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
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
