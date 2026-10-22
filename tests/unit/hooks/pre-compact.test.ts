import type * as ChildProcessMod from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupFixtures, createFixture } from '#tests/unit/hooks/_helpers.js';

const state = vi.hoisted(() => ({
  dbPath: '',
  fingerprint: `sha256:${'7'.repeat(64)}`,
  input: {},
  rows: [] as Array<{ jobId: string; execution: number; phase: string }>,
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
  readStdin: async () => JSON.stringify(state.input),
}));

afterEach(() => {
  cleanupFixtures();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  state.exec.mockReset();
  state.close.mockReset();
});

async function compact(result: { execution: number; resultPath?: string } | null) {
  const f = createFixture();
  state.dbPath = join(f.root, 'store.db');
  writeFileSync(`${state.dbPath}.format`, state.fingerprint);
  state.input = { cwd: f.projectRoot };
  state.rows = [{ jobId: 'job-1', execution: 2, phase: 'completed' }];
  const resultDir = join(f.root, '.coral', 'exports', 'jobs', 'job-1', 'published');
  mkdirSync(resultDir, { recursive: true });
  const resultPath = join(resultDir, 'result.md');
  writeFileSync(resultPath, 'supplied result');
  state.exec.mockReturnValue(
    JSON.stringify(
      result === null
        ? []
        : [{ jobId: 'job-1', ...result, ...(result.resultPath === 'supplied' ? { resultPath } : {}) }],
    ),
  );
  vi.stubEnv('HOME', f.root);
  vi.stubEnv('USERPROFILE', f.root);
  vi.stubEnv('CORAL_WORK_ROOT_OVERRIDE', f.tmpRoot);
  vi.stubEnv('CLAUDE_PROJECT_DIR', f.projectRoot);
  vi.stubEnv('CORAL_FLAVOR', 'prod');
  vi.stubEnv('CORAL_CHILD', '');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.resetModules();
  // @ts-expect-error — hooks are self-contained ESM without declarations.
  await import('../../../clients/hooks/pre-compact.mjs');
  return { f, resultPath };
}

describe('pre-compact result paths', () => {
  it('takes the matching execution result path from a CLI row', async () => {
    const { f, resultPath } = await compact({ execution: 2, resultPath: 'supplied' });
    const hooks = join(f.snapshotDir, 'hooks');
    const snapshot = JSON.parse(readFileSync(join(hooks, readdirSync(hooks)[0]), 'utf8'));
    expect(snapshot.jobs).toEqual([{ jobId: 'job-1', execution: 2, phase: 'completed', resultPath, hasResult: true }]);
    expect(state.exec).toHaveBeenCalledWith(
      expect.stringMatching(/bridge\/coral-cli$/),
      ['jobs', 'list', '--all', '--json'],
      expect.objectContaining({ cwd: f.projectRoot }),
    );
    const { timeout } = state.exec.mock.calls[0][2] as { timeout: number };
    expect(timeout).toBeGreaterThanOrEqual(250);
    expect(timeout).toBeLessThanOrEqual(2_500);
    expect(state.close).toHaveBeenCalledOnce();
  });

  it.each([null, { execution: 2 }, { execution: 1, resultPath: 'supplied' }])(
    'does not guess a path or borrow a predecessor when the matching row is %j',
    async (result) => {
      const { f } = await compact(result);
      expect(existsSync(join(f.snapshotDir, 'hooks'))).toBe(false);
      expect(state.close).toHaveBeenCalledOnce();
    },
  );
});
