// Every git-sync operation gates on `isGitRepo()`, so a wrong `false` is not a degraded mode — it is the KB
// silently ceasing to be version-controlled, with no commit, no push, and nothing said.
//
// It used to cache every failure. `git rev-parse --is-inside-work-tree` failing because git exited non-zero
// and failing because the fork hit `EAGAIN` were the same value, kept for the lifetime of the daemon, so one
// moment of load turned git sync off until restart. These tests hold the split: only an answer is cached, and
// a non-answer expires.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { createGitSyncController } from '#src/kb/curate/git-sync.js';
import { INDECISIVE_PROBE_REPROBE_INTERVAL_MS } from '#src/infra/process-constants.js';
import type { KbRuntime } from '#src/kb/contract.js';
import type { GitSyncRuntimePicks } from '#src/kb/curate/pipeline-types.js';

const ROOT = '/kb/markdown-root';
const IS_WORK_TREE = ['rev-parse', '--is-inside-work-tree'];

type ExecSync = GitSyncRuntimePicks['processPort']['execSync'];
type ExecResult = ReturnType<ExecSync>;

function answered(stdout: string): ExecResult {
  return { stdout, stderr: '', status: 0, signal: null, error: undefined, pid: 1, output: [] } as ExecResult;
}

/** How git reports "no" to `--is-inside-work-tree`: it ran, and it exited non-zero. */
function saidNo(): ExecResult {
  return {
    stdout: '',
    stderr: 'not a git repository',
    status: 128,
    signal: null,
    error: undefined,
    pid: 1,
    output: [],
  } as ExecResult;
}

/**
 * How the port reports that git never ran, or ran and was killed. `code` is what separates a standing fact
 * from this moment.
 *
 * This is still hand-assembled, and that is worth saying because assembling it is how this file was briefly
 * wrong: it asserted `{ code: 'ETIMEDOUT' }` on a timeout while the port was rewriting `spawnSync`'s coded
 * error into a bare one, so every case here passed against a shape production never produced and `gitAnswered`
 * read real timeouts as answers. Nothing in this file could have caught that — both sides of the boundary were
 * written here. What holds it now is elsewhere: `tests/unit/runtime/exec-sync-timeout.test.ts` drives the real
 * `spawnSync` against a real slow child and pins `error.code` to `EXEC_TIMEOUT_CODE`. If that test is ever
 * relaxed, these rows go back to describing a boundary that does not exist.
 */
function couldNotRun(code: string): ExecResult {
  return {
    stdout: '',
    stderr: '',
    status: null,
    signal: null,
    error: Object.assign(new Error(code), { code }),
    pid: 0,
    output: [],
  } as unknown as ExecResult;
}

/**
 * Counts the work-tree probes and drives every other git call to a harmless success, so the only thing these
 * tests observe is how often the probe was repeated and what it concluded.
 *
 * Construction probes once on its own — `createGitSyncController` clears a stale index lock — so a count of 1
 * after N `gitAutoCommit` calls means those N calls added none.
 */
function createController(respond: (probeCount: number) => ExecResult) {
  let probes = 0;
  const execSync = vi.fn(((_file: string, args: readonly string[]) => {
    if (args[0] === IS_WORK_TREE[0] && args[1] === IS_WORK_TREE[1]) {
      probes += 1;
      return respond(probes);
    }
    return answered('');
  }) as unknown as ExecSync);

  const controller = createGitSyncController({
    kb: { markdownRoot: ROOT, version: 'test', time: { now: () => Date.now() } } as unknown as KbRuntime,
    curateAssistant: { complete: async () => '' },
    processPort: { execSync, exec: vi.fn() } as unknown as GitSyncRuntimePicks['processPort'],
    // No KB paths exist, so a probe that concludes "yes" stops at the next step instead of reaching git.
    storagePort: {
      existsSync: () => false,
      readFileSync: vi.fn(),
      writeAtomicSync: vi.fn(),
      statSync: vi.fn(),
      rmSync: vi.fn(),
    } as unknown as GitSyncRuntimePicks['storagePort'],
    envPort: { get: () => undefined },
  });

  return { controller, probeCount: () => probes };
}

describe('git-sync work-tree probe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('caches a decisive no — git ran and said this is not a work tree', () => {
    const { controller, probeCount } = createController(() => saidNo());

    controller.gitAutoCommit('first');
    controller.gitAutoCommit('second');
    controller.gitAutoCommit('third');

    expect(probeCount(), 'git answered; asking again would only repeat it').toBe(1);
  });

  it('caches a decisive yes', () => {
    const { controller, probeCount } = createController(() => answered('true\n'));

    controller.gitAutoCommit('first');
    controller.gitAutoCommit('second');

    expect(probeCount()).toBe(1);
  });

  it.each([
    ['ENOENT', 'git is not installed'],
    ['EACCES', 'this process may not execute it'],
  ])('caches %s, because %s does not change under a running daemon', (code) => {
    const { controller, probeCount } = createController(() => couldNotRun(code));

    controller.gitAutoCommit('first');
    controller.gitAutoCommit('second');

    expect(probeCount()).toBe(1);
  });

  it.each([['ETIMEDOUT'], ['EAGAIN'], ['EMFILE'], ['ENOMEM']])(
    'does not cache %s, which says nothing about whether this is a work tree',
    (code) => {
      const { controller, probeCount } = createController(() => couldNotRun(code));

      controller.gitAutoCommit('first');
      vi.setSystemTime(new Date(Date.now() + INDECISIVE_PROBE_REPROBE_INTERVAL_MS + 1));
      controller.gitAutoCommit('second');

      expect(probeCount(), 'a transient failure must not disable git sync for the process lifetime').toBe(2);
    },
  );

  it('holds an unanswered probe for the interval rather than re-forking on every call', () => {
    const { controller, probeCount } = createController(() => couldNotRun('EAGAIN'));

    for (let call = 0; call < 8; call += 1) {
      controller.gitAutoCommit(`call-${call}`);
    }

    expect(probeCount(), 'seven gated call sites must not become seven blocking forks').toBe(1);
  });

  it('recovers without a restart once the environment answers again', () => {
    let wedged = true;
    const { controller, probeCount } = createController(() => (wedged ? couldNotRun('EAGAIN') : answered('true\n')));

    controller.gitAutoCommit('while wedged');
    expect(probeCount()).toBe(1);

    wedged = false;
    vi.setSystemTime(new Date(Date.now() + INDECISIVE_PROBE_REPROBE_INTERVAL_MS + 1));
    controller.gitAutoCommit('after recovery');
    controller.gitAutoCommit('and again');

    expect(probeCount(), 'the recovered answer is decisive and is cached like any other').toBe(2);
  });
});

// The operator turned git sync on. A cycle that skips it is a cycle that did not do the thing they enabled,
// and skipping because `git remote` could not be run looks exactly like skipping because the repository has no
// remote configured — the second is a settled fact, the first is nothing at all.
//
// The only thing separating them is the warning, and nothing asserted it: deleting the line left the whole
// suite green, so the visibility that makes this refusal not-silent could be removed without a signal. §11
// asks for the refusal to be visible; a log line nobody checks is one edit from not being.
describe('git sync says so when it cannot tell whether a remote exists', () => {
  function controllerWithRemoteProbe(remoteResult: ExecResult) {
    const execSync = vi.fn(((_file: string, args: readonly string[]) => {
      if (args[0] === IS_WORK_TREE[0] && args[1] === IS_WORK_TREE[1]) return answered('true');
      if (args[0] === 'remote' && args.length === 1) return remoteResult;
      return answered('');
    }) as unknown as ExecSync);

    return createGitSyncController({
      kb: { markdownRoot: ROOT, version: 'test', time: { now: () => Date.now() } } as unknown as KbRuntime,
      curateAssistant: { complete: async () => '' },
      processPort: { execSync, exec: vi.fn() } as unknown as GitSyncRuntimePicks['processPort'],
      storagePort: {
        existsSync: () => false,
        readFileSync: vi.fn(),
        writeAtomicSync: vi.fn(),
        statSync: vi.fn(),
        rmSync: vi.fn(),
      } as unknown as GitSyncRuntimePicks['storagePort'],
      envPort: { get: (key: string) => (key === 'CORAL_KB_GIT_SYNC' ? '1' : undefined) },
    });
  }

  it('warns when the remote probe could not be answered, rather than skipping silently', async () => {
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const controller = controllerWithRemoteProbe(couldNotRun('EAGAIN'));

    await controller.gitSync();

    expect(warn, 'the operator enabled this; a silent skip is the collapse the split removed').toHaveBeenCalledWith(
      expect.stringContaining('could not list remotes'),
    );
    expect(warn.mock.calls.at(-1)?.[0], 'and it names what was observed').toContain('EAGAIN');
    warn.mockRestore();
  });

  it('stays quiet when git answers that there is no remote, because that is a fact', async () => {
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const controller = controllerWithRemoteProbe(answered(''));

    await controller.gitSync();

    expect(
      warn.mock.calls.filter((call) => String(call[0]).includes('could not list remotes')),
      'a settled answer is not a non-answer, and must not be reported as one',
    ).toEqual([]);
    warn.mockRestore();
  });
});
