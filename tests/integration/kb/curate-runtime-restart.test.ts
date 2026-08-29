import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CorpusScanMod from '#src/kb/corpus/rescan/scan.js';
import type { KbRuntime } from '#src/kb/contract.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import { createCurateScheduler, type CurateHandle } from '#src/kb/curate/scheduler.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Database } from '#src/store/db.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { bindOramaFtsForTest } from '#tests/unit/kb/expansion-test-helpers.js';

vi.mock('#src/kb/curate/usage-budget.js', () => ({
  isUsageBudgetExhausted: () => false,
}));

// The real corpus scan runs in a worker thread whose completion no `advanceTimersByTime` drain can observe,
// so a fake-timer settle loop never sees the runtime stop.
vi.mock('#src/kb/corpus/rescan/scan-worker.js', async () => {
  const actual = await vi.importActual<typeof CorpusScanMod>('#src/kb/corpus/rescan/scan.js');
  return {
    CORPUS_SCAN_WORKER_TIMEOUT_MS: 120_000,
    buildCorpusScanViewInWorker: vi.fn(async (...args: Parameters<typeof actual.buildCorpusScanView>) =>
      actual.buildCorpusScanView(...args),
    ),
  };
});

const noopCurateAssistant: CurateAssistantPort = { complete: async () => '[]' };
const openDatabases: Database[] = [];
let tempDir: string;
let originalClaudeConfigDir: string | undefined;
let gitSyncRuntime: ReturnType<typeof createRealRuntime>;
let runtime: KbRuntime;
let scheduler: CurateHandle;

function openRuntime(): KbRuntime {
  const db = openKbTestStoreDb(join(tempDir, 'store.db'));
  openDatabases.push(db);
  const { kb } = createKbTestRuntime({
    markdownRoot: tempDir,
    runtimeDir: tempDir,
    db,
    runtime: gitSyncRuntime,
    curateAssistant: noopCurateAssistant,
  });
  return kb;
}

function schedulerFor(kb: KbRuntime): CurateHandle {
  return createCurateScheduler({
    kb,
    curateAssistant: noopCurateAssistant,
    processPort: gitSyncRuntime.process,
    storagePort: gitSyncRuntime.storage,
    envPort: gitSyncRuntime.env,
    usageBudget: { isExhausted: async () => false },
    scheduleDebounceMs: 0,
  });
}

async function settleCurateRuntime(handle: CurateHandle): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await vi.advanceTimersByTimeAsync(1);
    if (!handle.isRunning()) return;
  }
  throw new Error('Curate runtime did not settle.');
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-curate-restart-'));
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude-config');
  gitSyncRuntime = createRealRuntime('prod');
  runtime = openRuntime();
  bindOramaFtsForTest(runtime);
  scheduler = schedulerFor(runtime);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const db of openDatabases.splice(0).reverse()) db.close();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('curate runtime restart', () => {
  it('writes the KB gitignore block once and leaves it unchanged on a second runtime start', async () => {
    const gitignorePath = join(tempDir, '.gitignore');
    writeFileSync(gitignorePath, 'notes/\n', 'utf-8');

    await scheduler.start();
    await settleCurateRuntime(scheduler);

    const afterFirstStart = readFileSync(gitignorePath, 'utf-8');
    expect(afterFirstStart).toContain('notes/\n');
    expect(afterFirstStart).toContain('# Coral KB runtime (device-local, auto-managed)\ndata/\n');

    const secondScheduler = schedulerFor(openRuntime());
    await secondScheduler.start();
    await settleCurateRuntime(secondScheduler);

    expect(readFileSync(gitignorePath, 'utf-8')).toBe(afterFirstStart);
  });
});
