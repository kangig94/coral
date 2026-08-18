// The hook lane computes a project's data directory independently of the daemon, and the two must agree.
//
// `coralProjectDir` turns this string into `~/.coral/projects[-dev]/<slug>` with the same rule `sourceToSlug`
// (`src/infra/path/index.ts`) uses, and that directory holds memos and is exported to every skill as
// `CORAL_PROJECT` (`clients/hooks/coral-skill-vars.mjs`). So a probe that could not run must not be allowed to
// name it: every failure used to be cached as `local/<basename>` permanently and silently, which pinned a whole
// session to a directory later reads do not look in.
//
// Hooks may not import from `src/`, so this rule is spelled twice rather than shared. That is the reason this
// file exists — and the reason the agreement is *driven* here rather than asserted. It was asserted, in a
// comment above each spelling, while the two disagreed on five of the nineteen remotes below and while one
// lane hard-coded `projects` for both build flavors. A claim that two implementations agree is worth exactly
// the table that runs both of them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseRemoteSource as parseRemoteSourceInDaemon } from '#src/infra/project-source.js';
import { STANDING_PROBE_ERRNOS as STANDING_PROBE_ERRNOS_IN_DAEMON } from '#src/infra/process-constants.js';

const { execSyncMock } = vi.hoisted(() => ({ execSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execSync: execSyncMock }));

import {
  parseRemoteSource as parseRemoteSourceInHook,
  resolveProjectSource,
  STANDING_PROBE_ERRNOS as STANDING_PROBE_ERRNOS_IN_HOOK,
  // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
} from '../../../clients/hooks/lib/hook-utils.mjs';

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

/**
 * One table, both implementations. `null` is "this names no owner/repo", which each lane turns into its own
 * `local/<basename>` fallback.
 *
 * Every row that is not a plain `https` or `scp`-style remote is here because it separated the two before:
 * the trailing slash after `.git`, the query string, the fragment, and the two scheme-less paths. Adding a
 * case to this list is how a future divergence gets found; adding it to only one lane is how this started.
 */
const REMOTE_TABLE: ReadonlyArray<readonly [remote: string, expected: string | null]> = [
  ['git@github.com:owner/repo.git', 'owner/repo'],
  ['git@github.com:owner/repo', 'owner/repo'],
  ['https://github.com/owner/repo.git', 'owner/repo'],
  ['https://github.com/owner/repo', 'owner/repo'],
  ['https://github.com/owner/repo/', 'owner/repo'],
  ['https://github.com/owner/repo.git/', 'owner/repo'],
  ['https://user@github.com:443/owner/repo', 'owner/repo'],
  ['ssh://git@github.com/owner/repo.git', 'owner/repo'],
  ['git://github.com/owner/repo.git', 'owner/repo'],
  ['file:///srv/git/owner/repo.git', 'owner/repo'],
  ['https://github.com/owner/repo?ref=main', 'owner/repo'],
  ['https://github.com/owner/repo#frag', 'owner/repo'],
  ['  https://github.com/owner/repo\n', 'owner/repo'],
  ['https://github.com/only-one', null],
  ['some/deep/owner/repo', null],
  ['/abs/path/owner/repo', null],
  ['not-a-url', null],
  ['', null],
  ['   ', null],
];

describe('both lanes parse a remote the same way', () => {
  it.each(REMOTE_TABLE)('%j', (remote, expected) => {
    expect(parseRemoteSourceInDaemon(remote), 'daemon lane').toBe(expected);
    expect(parseRemoteSourceInHook(remote), 'hook lane').toBe(expected);
  });

  it('covers every case the two lanes were measured to disagree on', () => {
    const diverged = [
      'https://github.com/owner/repo.git/',
      'https://github.com/owner/repo?ref=main',
      'https://github.com/owner/repo#frag',
      'some/deep/owner/repo',
      '/abs/path/owner/repo',
    ];
    const covered = REMOTE_TABLE.map(([remote]) => remote);

    expect(diverged.filter((remote) => !covered.includes(remote))).toEqual([]);
  });
});

describe('both lanes enumerate the same standing errnos', () => {
  // Which errnos mean "answered" decides what gets cached durably, so the two lanes disagreeing means one of
  // them remembers a wrong project identity that the other never would. The set is small and the claim that
  // they match was, until now, a comment above each copy.
  it('matches, so a new errno cannot be added to one lane alone', () => {
    expect([...(STANDING_PROBE_ERRNOS_IN_HOOK as Set<string>)].sort()).toEqual(
      [...STANDING_PROBE_ERRNOS_IN_DAEMON].sort(),
    );
  });
});
