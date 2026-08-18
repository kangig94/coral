// The hook lane computes a project's data directory independently of the daemon, and the two must agree.
//
// `coralProjectDir` turns this string into `~/.coral/projects/<slug>` with the same rule `sourceToSlug`
// (`src/infra/path/index.ts`) uses, and that directory holds memos and is exported to every skill as
// `CORAL_PROJECT` (`clients/hooks/coral-skill-vars.mjs`). So a probe that could not run must not be allowed to
// name it: every failure used to be cached as `local/<basename>` permanently and silently, which pinned a whole
// session to a directory later reads do not look in.
//
// Hooks may not import from `src/`, so the decisive/indecisive split is spelled again here rather than shared.
// That is the reason this file exists: nothing else ties the two spellings together.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execSyncMock } = vi.hoisted(() => ({ execSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execSync: execSyncMock }));

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { resolveProjectSource } from '../../../clients/hooks/lib/hook-utils.mjs';

const PROJECT = '/workspace/some-project';

function answered(remote: string): void {
  execSyncMock.mockImplementation(() => remote);
}
/** git ran and exited non-zero — "not a repository", "no such remote". An answer. */
function saidNo(): void {
  execSyncMock.mockImplementation(() => {
    throw Object.assign(new Error('exit 128'), { status: 128 });
  });
}
/** The launch never produced an answer: a bound elapsed, or the system could not fork. */
function unanswered(code: string): void {
  execSyncMock.mockImplementation(() => {
    throw Object.assign(new Error(code), { code, status: null });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-18T00:00:00.000Z'));
  execSyncMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hook lane project source', () => {
  it('caches an answered remote', () => {
    answered('git@github.com:owner/repo.git\n');

    expect(resolveProjectSource(`${PROJECT}-a`)).toBe('owner/repo');
    expect(resolveProjectSource(`${PROJECT}-a`)).toBe('owner/repo');
    expect(execSyncMock, 'git answered; asking again repeats it').toHaveBeenCalledTimes(1);
  });

  it('caches a decisive "no remote"', () => {
    saidNo();

    expect(resolveProjectSource(`${PROJECT}-b`)).toBe('local/some-project-b');
    expect(resolveProjectSource(`${PROJECT}-b`)).toBe('local/some-project-b');
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it.each([['ENOENT'], ['EACCES']])('caches %s, a standing fact about this machine', (code) => {
    unanswered(code);

    expect(resolveProjectSource(`${PROJECT}-${code}`)).toBe(`local/some-project-${code}`);
    expect(resolveProjectSource(`${PROJECT}-${code}`)).toBe(`local/some-project-${code}`);
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it.each([['ETIMEDOUT'], ['EAGAIN'], ['EMFILE'], ['EWOULDBLOCKX']])(
    "never remembers %s as this project's identity",
    (code) => {
      const dir = `${PROJECT}-${code}`;
      unanswered(code);

      expect(resolveProjectSource(dir), 'the fallback is still answered').toBe(`local/some-project-${code}`);

      vi.setSystemTime(Date.now() + 61_000);
      answered('git@github.com:owner/recovered.git\n');

      expect(resolveProjectSource(dir), 'a recovered machine heals without restarting the session').toBe(
        'owner/recovered',
      );
    },
  );

  it('holds an unanswered probe for the interval rather than re-forking per hook call', () => {
    unanswered('EAGAIN');
    const dir = `${PROJECT}-wedged`;

    for (let call = 0; call < 6; call += 1) {
      expect(resolveProjectSource(dir)).toBe('local/some-project-wedged');
    }

    expect(execSyncMock, 'hooks run on every turn; a wedge must not cost a fork each time').toHaveBeenCalledTimes(1);
  });
});
