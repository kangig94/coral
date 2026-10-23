import type * as ChildProcessMod from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupFixtures, createFixture } from '#tests/unit/hooks/_helpers.js';

const state = vi.hoisted(() => ({
  dbPath: '',
  fingerprint: `sha256:${'7'.repeat(64)}`,
  input: {},
  flavor: 'prod' as 'prod' | 'dev',
  rows: [] as Array<{ jobId: unknown; execution: unknown; phase: string }>,
  exec: vi.fn(),
  close: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessMod>()),
  execFileSync: state.exec,
}));
vi.mock('../../../clients/hooks/lib/store-epoch.mjs', () => ({
  resolveCurrentStoreDbPath: () => state.dbPath,
  openLockedReadOnlyStoreDatabase: () => ({
    get: () => ({ value: state.fingerprint }),
    all: () => state.rows,
    close: state.close,
  }),
  isSqliteWaitBudgetExhausted: () => false,
}));
vi.mock('../../../clients/hooks/lib/hook-utils.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentStoreFormatFingerprint: () => state.fingerprint,
  buildFlavor: () => state.flavor,
  exitIfWrongFlavor: () => {},
  readStdin: async () => JSON.stringify(state.input),
}));

afterEach(() => {
  cleanupFixtures();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  state.exec.mockReset();
  state.close.mockReset();
});

async function compact({
  rows = [{ jobId: 'job-1', execution: 2, phase: 'completed' }],
  artifacts = [2],
  flavor = 'prod',
}: {
  rows?: typeof state.rows;
  artifacts?: number[];
  flavor?: 'prod' | 'dev';
} = {}) {
  const f = createFixture();
  state.dbPath = join(f.root, 'store.db');
  writeFileSync(`${state.dbPath}.format`, state.fingerprint);
  state.input = { cwd: f.projectRoot };
  state.rows = rows;
  state.flavor = flavor;
  const exportsRoot = join(f.root, '.coral', flavor === 'dev' ? 'exports-dev' : 'exports', 'jobs');
  for (const execution of artifacts) {
    const resultDir = join(exportsRoot, 'job-1', 'executions', String(execution));
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(resultDir, 'result.md'), 'execution result');
  }
  vi.stubEnv('HOME', f.root);
  vi.stubEnv('USERPROFILE', f.root);
  vi.stubEnv('CORAL_WORK_ROOT_OVERRIDE', f.tmpRoot);
  vi.stubEnv('CLAUDE_PROJECT_DIR', f.projectRoot);
  vi.stubEnv('CORAL_FLAVOR', flavor);
  vi.stubEnv('CORAL_CHILD', '');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.resetModules();
  // @ts-expect-error — hooks are self-contained ESM without declarations.
  await import('../../../clients/hooks/pre-compact.mjs');
  return { f, resultPath: join(exportsRoot, 'job-1', 'executions', '2', 'result.md') };
}

describe('pre-compact result paths', () => {
  it.each(['prod', 'dev'] as const)(
    'snapshots the current execution locally in %s without spawning a CLI',
    async (flavor) => {
      const { f, resultPath } = await compact({ flavor });
      const hooks = join(f.snapshotDir, 'hooks');
      const snapshot = JSON.parse(readFileSync(join(hooks, readdirSync(hooks)[0]), 'utf8'));
      expect(snapshot.jobs).toEqual([
        { jobId: 'job-1', execution: 2, phase: 'completed', resultPath, hasResult: true },
      ]);
      expect(state.exec).not.toHaveBeenCalled();
      expect(state.close).toHaveBeenCalledOnce();
    },
  );

  it.each([{ artifacts: [] }, { artifacts: [1] }])(
    'omits an ended execution whose result is absent, with artifacts %j',
    async ({ artifacts }) => {
      const { f } = await compact({ artifacts });
      expect(existsSync(join(f.snapshotDir, 'hooks'))).toBe(false);
      expect(state.exec).not.toHaveBeenCalled();
      expect(state.close).toHaveBeenCalledOnce();
    },
  );

  it('keeps queued and running jobs without borrowing a predecessor result', async () => {
    const rows = [
      { jobId: 'job-1', execution: 2, phase: 'queued' },
      { jobId: 'job-2', execution: null, phase: 'running' },
    ];
    const { f, resultPath } = await compact({ rows, artifacts: [1] });
    const hooks = join(f.snapshotDir, 'hooks');
    const snapshot = JSON.parse(readFileSync(join(hooks, readdirSync(hooks)[0]), 'utf8'));
    expect(snapshot.jobs).toEqual([
      { ...rows[0], resultPath, hasResult: false },
      { ...rows[1], resultPath: null, hasResult: false },
    ]);
    expect(state.exec).not.toHaveBeenCalled();
  });

  it.each([
    { jobId: '../job-1', execution: 2 },
    { jobId: '.', execution: 2 },
    { jobId: 'job-1', execution: '../2' },
    { jobId: 'job-1', execution: 0 },
    { jobId: 'job-1', execution: 1.5 },
    { jobId: 'job-1', execution: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects an unsafe execution address %j before deriving a path', async (row) => {
    const { f } = await compact({ rows: [{ ...row, phase: 'queued' }] });
    expect(existsSync(join(f.snapshotDir, 'hooks'))).toBe(false);
    expect(state.exec).not.toHaveBeenCalled();
    expect(state.close).toHaveBeenCalledOnce();
  });
});
