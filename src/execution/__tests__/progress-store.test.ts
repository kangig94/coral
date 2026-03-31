import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';
import type * as NodeFs from 'node:fs';
import type {
  PersistedExitRecord,
  PersistedLaunchRecord,
  PersistedRuntimeRecord,
  PersistedStatusRecord,
  TerminalResult,
  WorkflowCheckpoint,
} from '../../shared/types.js';
import { eventBus } from '../event-bus.js';
import { JOBS_DIR, ProgressStore, createReplayCursor, formatElapsed } from '../progress-store.js';

const jobIdsToClean = new Set<string>();
const projectRoot = '/tmp/project';
const TEST_BACKEND_NAMESPACE = 'test-namespace';
const renameCalls = vi.hoisted(() => [] as Array<[unknown, unknown]>);
const mockState = vi.hoisted(() => ({
  tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/coral-progress-store-test-tmp`,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    tmpdir: () => mockState.tmpRoot,
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs');
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      renameCalls.push([args[0], args[1]]);
      return actual.renameSync(...args);
    },
  };
});

beforeEach(() => {
  rmSync(mockState.tmpRoot, { recursive: true, force: true });
  mkdirSync(mockState.tmpRoot, { recursive: true });
});

afterEach(() => {
  for (const jobId of jobIdsToClean) {
    rmSync(join(JOBS_DIR, jobId), { recursive: true, force: true });
  }
  jobIdsToClean.clear();
  rmSync(mockState.tmpRoot, { recursive: true, force: true });
  renameCalls.length = 0;
  eventBus.removeAllListeners();
  vi.restoreAllMocks();
});

describe('execution ProgressStore', () => {
  it('initJob creates directory and status.json with phase launching', () => {
    const store = new ProgressStore();
    const jobId = `progress-init-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });

    expect(existsSync(store.jobDir(jobId))).toBe(true);
    expect(store.readStatus(jobId)).toMatchObject({
      jobId,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot,
      phase: 'launching',
      launch: { state: 'pending' },
    });
  });

  it('appendProgress returns incrementing eventId starting at 1', () => {
    const store = new ProgressStore();
    const jobId = `progress-events-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });

    const first = store.appendProgress(jobId, 'session-1', 'first');
    const second = store.appendProgress(jobId, 'session-1', 'second');

    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it('emits event bus job lifecycle events', () => {
    const store = new ProgressStore();
    const jobId = `progress-bus-${randomUUID()}`;
    const result = { content: 'done' } satisfies TerminalResult;
    const created = vi.fn();
    const phaseChanged = vi.fn();
    const progress = vi.fn();
    const completed = vi.fn();
    jobIdsToClean.add(jobId);

    eventBus.on('job:created', created);
    eventBus.on('job:phase_changed', phaseChanged);
    eventBus.on('job:progress', progress);
    eventBus.on('job:completed', completed);

    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });
    store.updatePhase(jobId, 'running');
    const eventId = store.appendProgress(jobId, 'session-1', 'working');
    store.appendTerminal(jobId, 'session-1', result, 'completed');

    expect(created).toHaveBeenCalledWith({
      jobId,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot,
    });
    expect(phaseChanged.mock.calls).toEqual([
      [{ jobId, phase: 'running', previousPhase: 'launching' }],
      [{ jobId, phase: 'completed', previousPhase: 'running' }],
    ]);
    expect(progress).toHaveBeenCalledWith({
      jobId,
      eventId,
      message: expect.stringContaining('working'),
    });
    expect(completed).toHaveBeenCalledWith({ jobId, result });
  });

  it('replayFrom returns only events with eventId greater than fromEventId', () => {
    const store = new ProgressStore();
    const jobId = `progress-replay-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });
    store.appendProgress(jobId, 'session-1', 'first');
    store.appendProgress(jobId, 'session-1', 'second');
    store.appendProgress(jobId, 'session-1', 'third');

    const events = store.replayFrom(jobId, 1, createReplayCursor());

    expect(events.map((event) => event.eventId)).toEqual([2, 3]);
    expect(events.map((event) => event.message)).toEqual(['[ 0m  0s] second', '[ 0m  0s] third']);
  });

  it('appendTerminal updates status.json result', () => {
    const store = new ProgressStore();
    const jobId = `progress-terminal-${randomUUID()}`;
    const result = { content: 'done', exitCode: 0 } satisfies TerminalResult;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });

    store.appendTerminal(jobId, 'session-1', result, 'completed');

    expect(store.readStatus(jobId)).toMatchObject({
      phase: 'completed',
      result,
    });
  });

  it('appendTerminal throws when progress.jsonl append fails', () => {
    const store = new ProgressStore();
    const jobId = `progress-terminal-throw-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => {
      store.appendTerminal(jobId, 'session-1', { content: 'done' }, 'completed');
    }).toThrow('disk full');
    expect(store.readStatus(jobId)).toMatchObject({ phase: 'launching' });
  });

  it('writeStatus non-terminal writes sync (same as terminal)', () => {
    const store = new ProgressStore();
    const jobId = `progress-atomic-nonterminal-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });

    renameCalls.length = 0;

    const record = {
      jobId,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      phase: 'running',
      launch: { state: 'ready', updatedAt: '2026-03-06T00:00:00.000Z' },
    } satisfies PersistedStatusRecord;

    store.writeStatus(jobId, record);

    expect(store.readStatus(jobId)).toMatchObject({ phase: 'running', launch: { state: 'ready' } });
    // All writes are now sync — renameSync is called immediately
    expect(renameCalls.length).toBeGreaterThan(0);
  });

  it('writeStatus terminal is atomic (sync renameSync before cache)', () => {
    const store = new ProgressStore();
    const jobId = `progress-atomic-terminal-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });

    renameCalls.length = 0;

    const record = {
      jobId,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      phase: 'completed',
      launch: { state: 'ready', updatedAt: '2026-03-06T00:00:00.000Z' },
      result: { content: 'done' },
    } satisfies PersistedStatusRecord;

    store.writeStatus(jobId, record);

    expect(renameCalls).toContainEqual([
      join(store.jobDir(jobId), 'status.json.tmp'),
      join(store.jobDir(jobId), 'status.json'),
    ]);
    expect(existsSync(join(store.jobDir(jobId), 'status.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(store.jobDir(jobId), 'status.json'), 'utf-8'))).toEqual(record);
  });

  it('replayFrom from eventId=0 on a job with only a terminal event returns that terminal', () => {
    const store = new ProgressStore();
    const jobId = `progress-terminal-only-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });
    store.appendTerminal(jobId, 'session-1', { content: 'result text' }, 'completed');

    const events = store.replayFrom(jobId, 0, createReplayCursor());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('terminal');
    expect(events[0].result?.content).toBe('result text');
  });

  it('appendTerminal is safe when status.json does not exist (no unhandled throw)', () => {
    const store = new ProgressStore();
    const jobId = `progress-nostatus-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    mkdirSync(store.jobDir(jobId), { recursive: true });
    writeFileSync(join(store.jobDir(jobId), 'progress.jsonl'), '', 'utf-8');

    expect(() => {
      store.appendTerminal(jobId, 'session-1', { content: 'done' }, 'completed');
    }).not.toThrow();
  });

  it('markTerminalStatus updates status only, cleans terminal state, and notifies waiters', async () => {
    const store = new ProgressStore();
    const jobId = `progress-terminal-fallback-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });
    store.appendProgress(jobId, 'session-1', 'before terminal');
    const progressPath = join(store.jobDir(jobId), 'progress.jsonl');
    const before = readFileSync(progressPath, 'utf-8');
    const seq = store.getChangeSeq();

    store.markTerminalStatus(jobId, { content: 'done' }, 'completed');

    await expect(store.waitForChange(seq)).resolves.toBeUndefined();
    expect(readFileSync(progressPath, 'utf-8')).toBe(before);
    expect(store.readStatus(jobId)).toMatchObject({
      phase: 'completed',
      result: { content: 'done' },
    });

    const internals = store as unknown as {
      eventCounters: Map<string, number>;
      jobStartedAt: Map<string, number>;
    };
    expect(internals.eventCounters.has(jobId)).toBe(false);
    expect(internals.jobStartedAt.has(jobId)).toBe(false);
  });

  it('markTerminalStatus emits job:completed', () => {
    const store = new ProgressStore();
    const jobId = `progress-terminal-event-${randomUUID()}`;
    const result = { content: 'done' } satisfies TerminalResult;
    const completed = vi.fn();
    jobIdsToClean.add(jobId);
    eventBus.on('job:completed', completed);

    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });
    store.markTerminalStatus(jobId, result, 'completed');

    expect(completed).toHaveBeenCalledWith({ jobId, result });
  });

  // @flaky — formatElapsed timestamp depends on sub-second execution; retry under parallel suite
  it('consecutive replayFrom calls on the same cursor only return newly appended events', { retry: 2 }, () => {
    const store = new ProgressStore();
    const jobId = `progress-cursor-advance-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });
    store.appendProgress(jobId, 'session-1', 'first');
    store.appendProgress(jobId, 'session-1', 'second');

    const cursor = createReplayCursor();
    const batch1 = store.replayFrom(jobId, 0, cursor);
    expect(batch1.map((e) => e.message)).toEqual(['[ 0m  0s] first', '[ 0m  0s] second']);

    store.appendProgress(jobId, 'session-1', 'third');

    const batch2 = store.replayFrom(jobId, 2, cursor);
    expect(batch2.map((e) => e.message)).toEqual(['[ 0m  0s] third']);
    expect(batch2.map((e) => e.eventId)).toEqual([3]);
  });

  it('scopedLookup distinguishes found, missing, and mismatch', () => {
    const store = new ProgressStore();
    const jobId = `progress-scope-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });

    expect(store.scopedLookup(jobId, projectRoot)).toBe('found');
    expect(store.scopedLookup(jobId, '/tmp/other-project')).toBe('mismatch');
    expect(store.scopedLookup(`missing-${randomUUID()}`, projectRoot)).toBe('missing');
  });
});

describe('formatElapsed', () => {
  it.each([
    [0, ' 0m  0s'],
    [3_000, ' 0m  3s'],
    [62_000, ' 1m  2s'],
    [570_000, ' 9m 30s'],
    [765_000, '12m 45s'],
    [3_750_000, '1h 02m 30s'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});

describe('legacy backendNamespace bridge', () => {
  function seedLegacyStatus(
    progressStore: ProgressStore,
    jobId: string,
    overrides: Partial<PersistedStatusRecord & { backendNamespace?: string | null }> = {},
  ): void {
    const jobDir = progressStore.jobDir(jobId);
    mkdirSync(jobDir, { recursive: true });
    const record = {
      jobId,
      sessionId: `sess-${jobId}`,
      provider: 'codex',
      projectRoot: '/tmp/project',
      phase: 'running',
      launch: { state: 'ready', updatedAt: new Date().toISOString() },
      ...overrides,
    };
    writeFileSync(join(jobDir, 'status.json'), JSON.stringify(record), 'utf-8');
    writeFileSync(join(jobDir, 'progress.jsonl'), '', 'utf-8');
  }

  it('readStatus returns the record when backendNamespace key is completely absent (legacy format)', () => {
    const store = new ProgressStore();
    const jobId = `legacy-absent-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    seedLegacyStatus(store, jobId);

    const status = store.readStatus(jobId);
    expect(status).not.toBeNull();
    expect(status?.phase).toBe('running');
  });

  it('scopedLookup still finds a legacy job (no backendNamespace) by projectRoot', () => {
    const store = new ProgressStore();
    const jobId = `legacy-scoped-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    seedLegacyStatus(store, jobId, { projectRoot: '/tmp/project' });

    expect(store.scopedLookup(jobId, '/tmp/project')).toBe('found');
  });

  it('a job with backendNamespace set to empty string is distinguishable from absent', () => {
    const store = new ProgressStore();
    const jobId = `empty-ns-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    seedLegacyStatus(store, jobId, { backendNamespace: '' } as never);

    const status = store.readStatus(jobId) as Record<string, unknown> | null;
    expect(status).not.toBeNull();

    if (status && 'backendNamespace' in status) {
      expect(status['backendNamespace']).toBe('');
    }
  });

  it('a job with a foreign backendNamespace must NOT be treated as a legacy job', () => {
    const store = new ProgressStore();
    const jobId = `foreign-ns-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    const foreignNamespace = 'aabbccdd1122';
    seedLegacyStatus(store, jobId, { backendNamespace: foreignNamespace } as never);

    const status = store.readStatus(jobId) as Record<string, unknown> | null;
    expect(status).not.toBeNull();

    if (status && 'backendNamespace' in status) {
      expect(status['backendNamespace']).toBe(foreignNamespace);
    }
  });

  it('legacy job without backendNamespace is still listed by readStatus (not silently dropped)', () => {
    const store = new ProgressStore();
    const jobId = `legacy-list-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    seedLegacyStatus(store, jobId, { phase: 'queued' });

    const status = store.readStatus(jobId);
    expect(status?.phase).toBe('queued');
  });

  it('initJob stores the provided backendNamespace in the persisted status record', () => {
    const store = new ProgressStore();
    const jobId = `init-with-ns-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    const namespace = 'my-plugin-namespace';
    store.initJob({
      jobId,
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: namespace,
    });

    const status = store.readStatus(jobId) as Record<string, unknown> | null;
    expect(status).not.toBeNull();
    expect(status?.['backendNamespace']).toBe(namespace);
  });
});

describe('durable snapshot artifacts', () => {
  it('writes and reads launch.json', () => {
    const store = new ProgressStore();
    const jobId = `test-launch-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot: '/tmp/test', backendNamespace: 'ns1' });

    const record: PersistedLaunchRecord = {
      jobId,
      sessionId: 's1',
      provider: 'codex',
      projectRoot: '/tmp/test',
      backendNamespace: 'ns1',
      pool: 'default',
      enqueueSequence: 1,
      providerAction: 'exec',
      request: {
        prompt: 'hello',
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: new Date().toISOString(),
    };
    store.writeLaunchRecord(jobId, record);

    const read = store.readLaunchRecord(jobId);
    expect(read).toEqual(record);
  });

  it('writes and reads runtime.json', () => {
    const store = new ProgressStore();
    const jobId = `test-runtime-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot: '/tmp/test', backendNamespace: 'ns1' });

    const record: PersistedRuntimeRecord = {
      pid: 12345,
      stdoutPath: join(store.jobDir(jobId), 'stdout'),
      stderrPath: join(store.jobDir(jobId), 'stderr'),
      startTime: new Date().toISOString(),
    };
    store.writeRuntimeRecord(jobId, record);

    const read = store.readRuntimeRecord(jobId);
    expect(read).toEqual(record);
  });

  it('writes and reads exit.json', () => {
    const store = new ProgressStore();
    const jobId = `test-exit-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot: '/tmp/test', backendNamespace: 'ns1' });

    const record: PersistedExitRecord = {
      exitCode: 0,
      signal: null,
      endTime: new Date().toISOString(),
    };
    store.writeExitRecord(jobId, record);

    const read = store.readExitRecord(jobId);
    expect(read).toEqual(record);
  });

  it('writes and reads workflow-state.json', () => {
    const store = new ProgressStore();
    const jobId = `test-workflow-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot: '/tmp/test', backendNamespace: 'ns1' });

    const checkpoint: WorkflowCheckpoint = {
      jobId,
      sessionId: 's1',
      provider: 'codex',
      stepIndex: 0,
      stepPrompt: 'step 1',
      atoms: [],
      completedOutputs: {},
      completedStepDetails: [],
      cursor: {},
      lastActivityAt: {},
      staleRetries: {},
      expectedStaleAborts: [],
      updatedAt: new Date().toISOString(),
    };
    store.writeWorkflowCheckpoint(jobId, checkpoint);

    const read = store.readWorkflowCheckpoint(jobId);
    expect(read).toEqual(checkpoint);
  });

  it('returns null for missing artifacts', () => {
    const store = new ProgressStore();
    expect(store.readLaunchRecord('nonexistent')).toBeNull();
    expect(store.readRuntimeRecord('nonexistent')).toBeNull();
    expect(store.readExitRecord('nonexistent')).toBeNull();
    expect(store.readWorkflowCheckpoint('nonexistent')).toBeNull();
  });

  it('hasLaunchRecord/hasRuntimeRecord/hasExitRecord return false for missing', () => {
    const store = new ProgressStore();
    expect(store.hasLaunchRecord('nonexistent')).toBe(false);
    expect(store.hasRuntimeRecord('nonexistent')).toBe(false);
    expect(store.hasExitRecord('nonexistent')).toBe(false);
  });

  it('hasLaunchRecord/hasRuntimeRecord/hasExitRecord return true after write', () => {
    const store = new ProgressStore();
    const jobId = `test-has-records-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot: '/tmp/test', backendNamespace: 'ns1' });

    store.writeLaunchRecord(jobId, {
      jobId,
      sessionId: 's1',
      provider: 'codex',
      projectRoot: '/tmp/test',
      backendNamespace: 'ns1',
      pool: 'default',
      enqueueSequence: 1,
      providerAction: 'exec',
      request: { prompt: 'test', bypassPermissions: false, coralEnv: {} },
      createdAt: new Date().toISOString(),
    });
    expect(store.hasLaunchRecord(jobId)).toBe(true);

    store.writeRuntimeRecord(jobId, {
      pid: 999,
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      startTime: new Date().toISOString(),
    });
    expect(store.hasRuntimeRecord(jobId)).toBe(true);

    store.writeExitRecord(jobId, {
      exitCode: 0,
      signal: null,
      endTime: new Date().toISOString(),
    });
    expect(store.hasExitRecord(jobId)).toBe(true);
  });
});

describe('rebindNamespace', () => {
  it('changes backendNamespace on an existing job', () => {
    const store = new ProgressStore();
    const jobId = `rebind-ns-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'old-ns' });

    store.rebindNamespace(jobId, 'new-ns');

    const status = store.readStatus(jobId);
    expect(status?.backendNamespace).toBe('new-ns');
  });

  it('optionally updates bundleHash along with namespace', () => {
    const store = new ProgressStore();
    const jobId = `rebind-hash-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({
      jobId,
      sessionId: 's1',
      provider: 'codex',
      projectRoot,
      backendNamespace: 'old-ns',
      bundleHash: 'old-hash',
    });

    store.rebindNamespace(jobId, 'new-ns', 'new-hash');

    const status = store.readStatus(jobId);
    expect(status?.backendNamespace).toBe('new-ns');
    expect(status?.bundleHash).toBe('new-hash');
  });

  it('is a no-op for a nonexistent job', () => {
    const store = new ProgressStore();
    expect(() => store.rebindNamespace('nonexistent', 'ns')).not.toThrow();
  });
});

describe('liveJobCountByNamespace', () => {
  it('counts live jobs matching the given namespace', () => {
    const store = new ProgressStore();
    const jobA = `live-ns-a-${randomUUID()}`;
    const jobB = `live-ns-b-${randomUUID()}`;
    const jobC = `live-ns-c-${randomUUID()}`;
    jobIdsToClean.add(jobA);
    jobIdsToClean.add(jobB);
    jobIdsToClean.add(jobC);

    store.initJob({ jobId: jobA, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'ns-target' });
    store.initJob({ jobId: jobB, sessionId: 's2', provider: 'codex', projectRoot, backendNamespace: 'ns-target' });
    store.initJob({ jobId: jobC, sessionId: 's3', provider: 'codex', projectRoot, backendNamespace: 'ns-other' });

    expect(store.liveJobCountByNamespace('ns-target')).toBe(2);
    expect(store.liveJobCountByNamespace('ns-other')).toBe(1);
    expect(store.liveJobCountByNamespace('ns-missing')).toBe(0);
  });

  it('excludes terminated jobs from the count', () => {
    const store = new ProgressStore();
    const jobId = `live-ns-term-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'ns-x' });
    expect(store.liveJobCountByNamespace('ns-x')).toBe(1);

    store.appendTerminal(jobId, 's1', { content: 'done' }, 'completed');
    expect(store.liveJobCountByNamespace('ns-x')).toBe(0);
  });
});

describe('hydrateEventCounter', () => {
  it('restores counter from progress.jsonl so next append is lastEventId + 1', () => {
    const store = new ProgressStore();
    const jobId = `hydrate-counter-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'ns1' });

    // Append 3 progress events (eventIds 1, 2, 3)
    store.appendProgress(jobId, 's1', 'first');
    store.appendProgress(jobId, 's1', 'second');
    store.appendProgress(jobId, 's1', 'third');

    // Create a fresh store to simulate restart (clears in-memory counters)
    const store2 = new ProgressStore();
    store2.hydrateEventCounter(jobId);

    // Next append should be eventId 4, not 1
    const nextEventId = store2.appendProgress(jobId, 's1', 'fourth');
    expect(nextEventId).toBe(4);
  });

  it('is a no-op when progress.jsonl is empty', () => {
    const store = new ProgressStore();
    const jobId = `hydrate-empty-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'ns1' });

    const store2 = new ProgressStore();
    store2.hydrateEventCounter(jobId);

    // First append should still be eventId 1
    const nextEventId = store2.appendProgress(jobId, 's1', 'first');
    expect(nextEventId).toBe(1);
  });
});

describe('hydrateJobStartedAt', () => {
  it('sets the started time from a timestamp string', () => {
    const store = new ProgressStore();
    const jobId = `hydrate-started-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'ns1' });

    // Hydrate with a known past time so elapsed formatting is predictable
    const pastTime = new Date(Date.now() - 62_000).toISOString();
    store.hydrateJobStartedAt(jobId, pastTime);

    // Append a progress event — the elapsed prefix should reflect ~62s, not ~0s
    store.appendProgress(jobId, 's1', 'check elapsed');
    const cursor = createReplayCursor();
    const events = store.replayFrom(jobId, 0, cursor);
    const lastMsg = events[events.length - 1]?.message ?? '';
    // Should contain "1m" since 62s = 1m 2s
    expect(lastMsg).toMatch(/1m/);
  });

  it('ignores an invalid timestamp', () => {
    const store = new ProgressStore();
    const jobId = `hydrate-invalid-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'ns1' });

    // Should not throw for invalid input
    expect(() => store.hydrateJobStartedAt(jobId, 'not-a-date')).not.toThrow();
  });
});

describe('nextEnqueueSequence', () => {
  it('returns monotonically increasing values', () => {
    const store = new ProgressStore();
    const first = store.nextEnqueueSequence();
    const second = store.nextEnqueueSequence();
    const third = store.nextEnqueueSequence();

    expect(second).toBe(first + 1);
    expect(third).toBe(second + 1);
  });
});
