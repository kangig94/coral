import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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

describe('gitSync does not report no-change for a work-tree probe it could not answer', () => {
  function controllerWithWorkTreeProbe(probeResult: ExecResult) {
    const execSync = vi.fn(((_file: string, args: readonly string[]) => {
      if (args[0] === IS_WORK_TREE[0] && args[1] === IS_WORK_TREE[1]) return probeResult;
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

  it('distinguishes an unanswered work-tree probe from a decisive non-repository result', async () => {
    await expect(controllerWithWorkTreeProbe(couldNotRun('EAGAIN')).gitSync()).resolves.toEqual({ kind: 'ambiguous' });
    await expect(controllerWithWorkTreeProbe(saidNo()).gitSync()).resolves.toEqual({ kind: 'no-change' });
  });
});
