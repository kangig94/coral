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
