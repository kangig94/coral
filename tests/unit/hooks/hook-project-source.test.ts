// The hook lane computes a project's data directory independently of the daemon, and the two must agree.
//
// `coralProjectDir` turns this string into `~/.coral/projects[-dev]/<slug>` with the same rule `sourceToSlug`
// (`src/infra/path/index.ts`) uses, and that directory holds memos and is exported to every skill as
// `CORAL_PROJECT`. A probe that could not run must not be allowed to name it.
//
// Hooks may not import from `src/`, so this rule is spelled twice rather than shared. That is the reason this
// file exists — and the reason the agreement is *driven* here rather than asserted. A claim that two
// implementations agree is worth exactly the table that runs both of them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isOwnerId as isOwnerIdInDaemon } from '#src/infra/identifiers.js';
import { isLivePhase as isLivePhaseInDaemon, jobPhaseSchema } from '#src/jobs/phase.js';
import { parseRemoteSource as parseRemoteSourceInDaemon } from '#src/infra/project-source.js';
import {
  INDECISIVE_PROBE_REPROBE_INTERVAL_MS as INDECISIVE_PROBE_REPROBE_INTERVAL_MS_IN_DAEMON,
  STANDING_PROBE_ERRNOS as STANDING_PROBE_ERRNOS_IN_DAEMON,
} from '#src/infra/process-constants.js';

// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { isLivePhase as isLivePhaseInHook } from '../../../clients/hooks/lib/jobs-state.mjs';

const { execSyncMock } = vi.hoisted(() => ({ execSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execSync: execSyncMock }));

import {
  isValidSessionId as isValidSessionIdInHook,
  parseRemoteSource as parseRemoteSourceInHook,
  resolveProjectSource,
  STANDING_PROBE_ERRNOS as STANDING_PROBE_ERRNOS_IN_HOOK,
  UNANSWERED_REPROBE_INTERVAL_MS as UNANSWERED_REPROBE_INTERVAL_MS_IN_HOOK,
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

  // `ENOENT`/`EACCES` are a standing fact about the machine — git will not appear under a running daemon — but
  // that is not the same as answering whether *this project* has a remote, which is the only question this
  // function asks. They join the non-answers below rather than getting a cache of their own: a missing git
  // binary caching "no remote" is the same durably-wrong-answer shape as a timeout doing so would be.
  it.each([['ETIMEDOUT'], ['EAGAIN'], ['EMFILE'], ['EWOULDBLOCKX'], ['ENOENT'], ['EACCES']])(
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
 * Adding a case to this list is how a future divergence gets found; adding it to only one lane is how this
 * started.
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
  // them remembers a wrong project identity that the other never would.
  it('matches, so a new errno cannot be added to one lane alone', () => {
    expect([...(STANDING_PROBE_ERRNOS_IN_HOOK as Set<string>)].sort()).toEqual(
      [...STANDING_PROBE_ERRNOS_IN_DAEMON].sort(),
    );
  });
});

describe('both lanes hold a non-answer for the same interval', () => {
  // Same reasoning as the errno set above, applied to the other number a non-answer is cached against.
  it('matches, so a new interval cannot be set on one lane alone', () => {
    expect(UNANSWERED_REPROBE_INTERVAL_MS_IN_HOOK).toBe(INDECISIVE_PROBE_REPROBE_INTERVAL_MS_IN_DAEMON);
  });
});

// The two pins above cover the errno set and the reprobe interval. These are the rest of the class: every
// value the hook lane must agree with the daemon on, spelled twice because hooks may not import from `src/`
// (design-philosophy §6). Driven rather than compared, for the reason this file's header gives — a set
// comparison answers only for the members both sides already list.

describe('both lanes agree on which job phases are live', () => {
  // `src/jobs/phase.ts` owns the enum; `clients/hooks/lib/jobs-state.mjs` re-spells the live subset to decide
  // what a pre-compact snapshot carries. A phase added to the domain and not to the hook drops live jobs from
  // that snapshot silently, which reads afterwards as "there was nothing running".
  it('answers identically for every phase the domain declares', () => {
    const disagreed = jobPhaseSchema.options.filter((phase) => isLivePhaseInHook(phase) !== isLivePhaseInDaemon(phase));

    expect(disagreed).toEqual([]);
  });
});

describe('both lanes accept the same identifiers', () => {
  // `identPattern` (`src/infra/identifiers.ts`) and the hook's own copy decide whether a session id is usable
  // at all. The hook rejecting one the daemon minted means a session whose work is recorded under an id no
  // hook will look for; the reverse means a hook writing under an id nothing else reads.
  it('agrees on every candidate, so neither lane trusts an id the other refuses', () => {
    const candidates = [
      'abc',
      'a.b-c_1',
      '9',
      'A-1.b_2',
      '-lead',
      '.lead',
      '_lead',
      '',
      ' ',
      'has space',
      'has/slash',
      'tail-',
      'ident\u00fc',
    ];

    const disagreed = candidates.filter((value) => isValidSessionIdInHook(value) !== isOwnerIdInDaemon(value));

    expect(disagreed).toEqual([]);
  });
});
