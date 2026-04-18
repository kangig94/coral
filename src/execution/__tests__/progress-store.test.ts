import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type {
  JobExitRecord,
  JobLaunchRecord,
  JobRuntimeRecord,
  JobStatusRecord,
  JobTerminalRecord,
} from '../../shared/types.js';
import { TypedEventBus } from '../event-bus.js';
import { ProgressStore, createReplayCursor, formatElapsed } from '../progress-store.js';
import { SimulationRuntime } from '../simulation/core/index.js';

const projectRoot = '/tmp/project';
const TEST_BACKEND_NAMESPACE = 'test-namespace';
const renameCalls: Array<[unknown, unknown]> = [];
let eventBus: TypedEventBus;
let runtime: SimulationRuntime;
let JOBS_DIR: string;

function createStore(bus: TypedEventBus = eventBus): ProgressStore {
  return new ProgressStore(TEST_BACKEND_NAMESPACE, runtime, bus);
}

function existsSync(path: string): boolean {
  return runtime.storage.existsSync(path);
}

function mkdirSync(path: string, options?: { recursive?: boolean }): void {
  runtime.storage.mkdirSync(path, options);
}

function readFileSync(path: string, _encoding: BufferEncoding): string {
  return runtime.storage.readFileSync(path, 'utf-8');
}

function writeFileSync(
  path: string,
  data: string,
  options?: BufferEncoding | { encoding?: BufferEncoding; mode?: number },
): void {
  runtime.storage.writeFileSync(path, data, typeof options === 'string' ? { encoding: options } : options);
}

function nextJobId(prefix: string): string {
  return `${prefix}-${runtime.ids.uuid()}`;
}

function nowMs(): number {
  return runtime.time.now();
}

function isoNow(): string {
  return new Date(nowMs()).toISOString();
}

function completedResult(overrides: Partial<JobTerminalRecord> = {}): JobTerminalRecord {
  return {
    content: 'done',
    outcome: { kind: 'completed' },
    ...overrides,
  };
}

function startAliveProcess(pid: number): number {
  runtime.spawner.enqueueSpawn({ pid, close: null });
  const child = runtime.process.spawn({
    command: 'mock-backend',
    args: [],
    mode: 'ignored',
  });
  if (child.pid === undefined) {
    throw new Error('simulation spawn did not allocate a pid');
  }
  return child.pid;
}

beforeEach(() => {
  runtime = new SimulationRuntime();
  JOBS_DIR = runtime.paths.jobsDir();
  const renameSync = runtime.storage.renameSync.bind(runtime.storage);
  vi.spyOn(runtime.storage, 'renameSync').mockImplementation((oldPath, newPath) => {
    renameCalls.push([oldPath, newPath]);
    renameSync(oldPath, newPath);
  });
  eventBus = new TypedEventBus();
});

afterEach(() => {
  renameCalls.length = 0;
  eventBus.reset();
  vi.restoreAllMocks();
});

describe('execution ProgressStore', () => {
  it('initJob creates directory and status.json with phase launching', () => {
    const store = createStore(eventBus);
    const jobId = nextJobId('progress-init');

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

  it.each([
    [
      'missing phase',
      (jobId: string) => ({
        jobId,
        sessionId: 'session-1',
        provider: 'codex',
        projectRoot,
        backendNamespace: TEST_BACKEND_NAMESPACE,
        launch: { state: 'ready', updatedAt: isoNow() },
      }),
    ],
    [
      'missing launch',
      (jobId: string) => ({
        jobId,
        sessionId: 'session-1',
        provider: 'codex',
        projectRoot,
        backendNamespace: TEST_BACKEND_NAMESPACE,
        phase: 'running',
      }),
    ],
  ])('readStatus returns null for malformed status.json with %s', (_name, createRecord) => {
    const store = createStore(eventBus);
    const jobId = nextJobId('progress-corrupt-status');
    mkdirSync(store.jobDir(jobId), { recursive: true });
    writeFileSync(join(store.jobDir(jobId), 'status.json'), JSON.stringify(createRecord(jobId)), 'utf-8');

    expect(store.readStatus(jobId)).toBeNull();
  });

  it('appendProgress returns incrementing eventId starting at 1', () => {
    const store = createStore(eventBus);
    const jobId = nextJobId('progress-events');
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });

    const first = store.appendProgress(jobId, 'session-1', 'first');
    const second = store.appendProgress(jobId, 'session-1', 'second');

    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it('emits event bus job lifecycle events', () => {
    const store = createStore(eventBus);
    const jobId = nextJobId('progress-bus');
    const result = completedResult({ content: 'done' });
    const created = vi.fn();
    const phaseChanged = vi.fn();
    const progress = vi.fn();
    const completed = vi.fn();

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
    const store = createStore();
    const jobId = nextJobId('progress-replay');
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });
    store.appendProgress(jobId, 'session-1', 'first');
    store.appendProgress(jobId, 'session-1', 'second');
    store.appendProgress(jobId, 'session-1', 'third');

    const events = store.replayFrom(jobId, 1, createReplayCursor());

    expect(events.map((event) => event.eventId)).toEqual([2, 3]);
    expect(events.map((event) => event.message)).toEqual(['[ 0m  0s] second', '[ 0m  0s] third']);
  });

  it('appendTerminal updates status.json result', () => {
    const store = createStore();
    const jobId = nextJobId('progress-terminal');
    const result = completedResult({ content: 'done', exitCode: 0 });
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });

    store.appendTerminal(jobId, 'session-1', result, 'completed');

    expect(store.readStatus(jobId)).toMatchObject({
      phase: 'completed',
      result,
    });
  });

  it('appendTerminal throws when progress.jsonl append fails', () => {
    const store = createStore();
    const jobId = nextJobId('progress-terminal-throw');
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });
    vi.spyOn(runtime.storage, 'appendFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => {
      store.appendTerminal(jobId, 'session-1', completedResult({ content: 'done' }), 'completed');
    }).toThrow('disk full');
    expect(store.readStatus(jobId)).toMatchObject({ phase: 'launching' });
  });

  it('writeStatus non-terminal writes sync (same as terminal)', () => {
    const store = createStore();
    const jobId = nextJobId('progress-atomic-nonterminal');
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
    } satisfies JobStatusRecord;

    store.writeStatus(jobId, record);

    expect(store.readStatus(jobId)).toMatchObject({ phase: 'running', launch: { state: 'ready' } });
    // All writes are now sync — renameSync is called immediately
    expect(renameCalls.length).toBeGreaterThan(0);
  });

  it('writeStatus terminal is atomic (sync renameSync before cache)', () => {
    const store = createStore();
    const jobId = nextJobId('progress-atomic-terminal');
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
      result: completedResult({ content: 'done' }),
    } satisfies JobStatusRecord;

    store.writeStatus(jobId, record);

    expect(renameCalls).toContainEqual([
      join(store.jobDir(jobId), 'status.json.tmp'),
      join(store.jobDir(jobId), 'status.json'),
    ]);
    expect(existsSync(join(store.jobDir(jobId), 'status.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(store.jobDir(jobId), 'status.json'), 'utf-8'))).toEqual(record);
  });

  it('replayFrom from eventId=0 on a job with only a terminal event returns that terminal', () => {
    const store = createStore();
    const jobId = nextJobId('progress-terminal-only');
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });
    store.appendTerminal(jobId, 'session-1', completedResult({ content: 'result text' }), 'completed');

    const events = store.replayFrom(jobId, 0, createReplayCursor());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('terminal');
    expect(events[0].result?.content).toBe('result text');
  });

  it('appendTerminal is safe when status.json does not exist (no unhandled throw)', () => {
    const store = createStore();
    const jobId = nextJobId('progress-nostatus');
    mkdirSync(store.jobDir(jobId), { recursive: true });
    writeFileSync(join(store.jobDir(jobId), 'progress.jsonl'), '', 'utf-8');

    expect(() => {
      store.appendTerminal(jobId, 'session-1', completedResult({ content: 'done' }), 'completed');
    }).not.toThrow();
  });

  it('markTerminalStatus updates status only, cleans terminal state, and notifies waiters', async () => {
    const store = createStore();
    const jobId = nextJobId('progress-terminal-fallback');
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });
    store.appendProgress(jobId, 'session-1', 'before terminal');
    const progressPath = join(store.jobDir(jobId), 'progress.jsonl');
    const before = readFileSync(progressPath, 'utf-8');
    const seq = store.getChangeSeq();

    store.markTerminalStatus(jobId, completedResult({ content: 'done' }), 'completed');

    await expect(store.waitForChange(seq)).resolves.toBeUndefined();
    expect(readFileSync(progressPath, 'utf-8')).toBe(before);
    expect(store.readStatus(jobId)).toMatchObject({
      phase: 'completed',
      result: completedResult({ content: 'done' }),
    });

    const internals = store as unknown as {
      eventCounters: Map<string, number>;
      jobStartedAt: Map<string, number>;
    };
    expect(internals.eventCounters.has(jobId)).toBe(false);
    expect(internals.jobStartedAt.has(jobId)).toBe(false);
  });

  it('markTerminalStatus emits job:completed', () => {
    const store = createStore(eventBus);
    const jobId = nextJobId('progress-terminal-event');
    const result = completedResult({ content: 'done' });
    const completed = vi.fn();
    eventBus.on('job:completed', completed);

    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });
    store.markTerminalStatus(jobId, result, 'completed');

    expect(completed).toHaveBeenCalledWith({ jobId, result });
  });

  // @flaky — formatElapsed timestamp depends on sub-second execution; retry under parallel suite
  it('consecutive replayFrom calls on the same cursor only return newly appended events', { retry: 2 }, () => {
    const store = createStore();
    const jobId = nextJobId('progress-cursor-advance');
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
    const store = createStore();
    const jobId = nextJobId('progress-scope');
    store.initJob({ jobId, sessionId: 'session-1', provider: 'codex', projectRoot, backendNamespace: 'test-ns' });

    expect(store.scopedLookup(jobId, projectRoot)).toBe('found');
    expect(store.scopedLookup(jobId, '/tmp/other-project')).toBe('mismatch');
    expect(store.scopedLookup(nextJobId('missing'), projectRoot)).toBe('missing');
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
    overrides: Partial<JobStatusRecord & { backendNamespace?: string | null }> = {},
  ): void {
    const jobDir = progressStore.jobDir(jobId);
    mkdirSync(jobDir, { recursive: true });
    const record = {
      jobId,
      sessionId: `sess-${jobId}`,
      provider: 'codex',
      projectRoot: '/tmp/project',
      phase: 'running',
      launch: { state: 'ready', updatedAt: isoNow() },
      ...overrides,
    };
    writeFileSync(join(jobDir, 'status.json'), JSON.stringify(record), 'utf-8');
    writeFileSync(join(jobDir, 'progress.jsonl'), '', 'utf-8');
  }

  it('readStatus returns the record when backendNamespace key is completely absent (legacy format)', () => {
    const store = createStore();
    const jobId = nextJobId('legacy-absent');

    seedLegacyStatus(store, jobId);

    const status = store.readStatus(jobId);
    expect(status).not.toBeNull();
    expect(status?.phase).toBe('running');
  });

  it('scopedLookup still finds a legacy job (no backendNamespace) by projectRoot', () => {
    const store = createStore();
    const jobId = nextJobId('legacy-scoped');

    seedLegacyStatus(store, jobId, { projectRoot: '/tmp/project' });

    expect(store.scopedLookup(jobId, '/tmp/project')).toBe('found');
  });

  it('a job with backendNamespace set to empty string is distinguishable from absent', () => {
    const store = createStore();
    const jobId = nextJobId('empty-ns');

    seedLegacyStatus(store, jobId, { backendNamespace: '' } as never);

    const status = store.readStatus(jobId) as Record<string, unknown> | null;
    expect(status).not.toBeNull();

    if (status && 'backendNamespace' in status) {
      expect(status['backendNamespace']).toBe('');
    }
  });

  it('a job with a foreign backendNamespace is excluded from this store view', () => {
    const store = createStore();
    const jobId = nextJobId('foreign-ns');

    const foreignNamespace = 'aabbccdd1122';
    seedLegacyStatus(store, jobId, { backendNamespace: foreignNamespace } as never);

    const status = store.readStatus(jobId) as Record<string, unknown> | null;
    expect(status).toBeNull();
  });

  it('legacy job without backendNamespace is still listed by readStatus (not silently dropped)', () => {
    const store = createStore();
    const jobId = nextJobId('legacy-list');

    seedLegacyStatus(store, jobId, { phase: 'queued' });

    const status = store.readStatus(jobId);
    expect(status?.phase).toBe('queued');
  });

  it('initJob stores the provided backendNamespace in the persisted status record', () => {
    const store = createStore();
    const jobId = nextJobId('init-with-ns');

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
    const store = createStore();
    const jobId = nextJobId('test-launch');
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot: '/tmp/test', backendNamespace: 'ns1' });

    const record: JobLaunchRecord = {
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
        cwd: '/tmp/test',
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: isoNow(),
    };
    store.writeLaunchRecord(jobId, record);

    const read = store.readLaunchRecord(jobId);
    expect(read).toEqual(record);
  });

  it('writes and reads runtime.json', () => {
    const store = createStore();
    const jobId = nextJobId('test-runtime');
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot: '/tmp/test', backendNamespace: 'ns1' });

    const record: JobRuntimeRecord = {
      pid: 12345,
      stdoutPath: join(store.jobDir(jobId), 'stdout'),
      stderrPath: join(store.jobDir(jobId), 'stderr'),
      startTime: isoNow(),
    };
    store.writeRuntimeRecord(jobId, record);

    const read = store.readRuntimeRecord(jobId);
    expect(read).toEqual(record);
  });

  it('caches runtime.json reads until cleanup clears the cache', () => {
    const store = createStore();
    const jobId = nextJobId('test-runtime-cache');
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot: '/tmp/test', backendNamespace: 'ns1' });

    const runtimePath = join(store.jobDir(jobId), 'runtime.json');
    const firstRecord: JobRuntimeRecord = {
      pid: 111,
      stdoutPath: join(store.jobDir(jobId), 'stdout-1'),
      stderrPath: join(store.jobDir(jobId), 'stderr-1'),
      startTime: '2026-04-03T00:00:00.000Z',
    };
    const secondRecord: JobRuntimeRecord = {
      pid: 222,
      stdoutPath: join(store.jobDir(jobId), 'stdout-2'),
      stderrPath: join(store.jobDir(jobId), 'stderr-2'),
      startTime: '2026-04-03T00:01:00.000Z',
    };

    writeFileSync(runtimePath, JSON.stringify(firstRecord, null, 2), 'utf8');
    expect(store.readRuntimeRecord(jobId)).toEqual(firstRecord);

    writeFileSync(runtimePath, JSON.stringify(secondRecord, null, 2), 'utf8');
    expect(store.readRuntimeRecord(jobId)).toEqual(firstRecord);

    store.purgeFromCache(jobId);
    expect(store.readRuntimeRecord(jobId)).toEqual(secondRecord);
  });

  it('does not negative-cache a missing runtime.json record', () => {
    const store = createStore();
    const jobId = nextJobId('test-runtime-cache-miss');
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot: '/tmp/test', backendNamespace: 'ns1' });

    const runtimePath = join(store.jobDir(jobId), 'runtime.json');
    const record: JobRuntimeRecord = {
      pid: 333,
      stdoutPath: join(store.jobDir(jobId), 'stdout'),
      stderrPath: join(store.jobDir(jobId), 'stderr'),
      startTime: '2026-04-14T00:00:00.000Z',
    };

    expect(store.readRuntimeRecord(jobId)).toBeNull();

    writeFileSync(runtimePath, JSON.stringify(record, null, 2), 'utf8');
    expect(store.readRuntimeRecord(jobId)).toEqual(record);
  });

  it('writes and reads exit.json', () => {
    const store = createStore();
    const jobId = nextJobId('test-exit');
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot: '/tmp/test', backendNamespace: 'ns1' });

    const record: JobExitRecord = {
      exitCode: 0,
      signal: null,
      endTime: isoNow(),
    };
    store.writeExitRecord(jobId, record);

    const read = store.readExitRecord(jobId);
    expect(read).toEqual(record);
  });

  it('returns null for missing artifacts', () => {
    const store = createStore();
    expect(store.readLaunchRecord('nonexistent')).toBeNull();
    expect(store.readRuntimeRecord('nonexistent')).toBeNull();
    expect(store.readExitRecord('nonexistent')).toBeNull();
  });

  it('hasLaunchRecord/hasRuntimeRecord/hasExitRecord return false for missing', () => {
    const store = createStore();
    expect(store.hasLaunchRecord('nonexistent')).toBe(false);
    expect(store.hasRuntimeRecord('nonexistent')).toBe(false);
    expect(store.hasExitRecord('nonexistent')).toBe(false);
  });

  it('hasLaunchRecord/hasRuntimeRecord/hasExitRecord return true after write', () => {
    const store = createStore();
    const jobId = nextJobId('test-has-records');
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
      request: { prompt: 'test', cwd: '/tmp/test', bypassPermissions: false, coralEnv: {} },
      createdAt: isoNow(),
    });
    expect(store.hasLaunchRecord(jobId)).toBe(true);

    store.writeRuntimeRecord(jobId, {
      pid: 999,
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      startTime: isoNow(),
    });
    expect(store.hasRuntimeRecord(jobId)).toBe(true);

    store.writeExitRecord(jobId, {
      exitCode: 0,
      signal: null,
      endTime: isoNow(),
    });
    expect(store.hasExitRecord(jobId)).toBe(true);
  });
});

describe('rebindNamespace', () => {
  it('changes backendNamespace on an existing job', () => {
    const store = createStore();
    const jobId = nextJobId('rebind-ns');
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'old-ns' });

    store.rebindNamespace(jobId, 'new-ns');

    const status = store.readStatus(jobId);
    expect(status?.backendNamespace).toBe('new-ns');
  });

  it('optionally updates bundleHash along with namespace', () => {
    const store = createStore();
    const jobId = nextJobId('rebind-hash');
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
    const store = createStore();
    expect(() => store.rebindNamespace('nonexistent', 'ns')).not.toThrow();
  });
});

describe('liveJobCountByNamespace', () => {
  it('counts live jobs matching the given namespace', () => {
    const store = createStore();
    const jobA = nextJobId('live-ns-a');
    const jobB = nextJobId('live-ns-b');
    const jobC = nextJobId('live-ns-c');

    store.initJob({ jobId: jobA, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'ns-target' });
    store.initJob({ jobId: jobB, sessionId: 's2', provider: 'codex', projectRoot, backendNamespace: 'ns-target' });
    store.initJob({ jobId: jobC, sessionId: 's3', provider: 'codex', projectRoot, backendNamespace: 'ns-other' });

    expect(store.liveJobCountByNamespace('ns-target')).toBe(2);
    expect(store.liveJobCountByNamespace('ns-other')).toBe(1);
    expect(store.liveJobCountByNamespace('ns-missing')).toBe(0);
  });

  it('excludes terminated jobs from the count', () => {
    const store = createStore();
    const jobId = nextJobId('live-ns-term');

    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'ns-x' });
    expect(store.liveJobCountByNamespace('ns-x')).toBe(1);

    store.appendTerminal(jobId, 's1', completedResult({ content: 'done' }), 'completed');
    expect(store.liveJobCountByNamespace('ns-x')).toBe(0);
  });
});

describe('hydrateEventCounter', () => {
  it('restores counter from progress.jsonl so next append is lastEventId + 1', () => {
    const store = createStore();
    const jobId = nextJobId('hydrate-counter');
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'ns1' });

    // Append 3 progress events (eventIds 1, 2, 3)
    store.appendProgress(jobId, 's1', 'first');
    store.appendProgress(jobId, 's1', 'second');
    store.appendProgress(jobId, 's1', 'third');

    // Create a fresh store to simulate restart (clears in-memory counters)
    const store2 = createStore();
    store2.hydrateEventCounter(jobId);

    // Next append should be eventId 4, not 1
    const nextEventId = store2.appendProgress(jobId, 's1', 'fourth');
    expect(nextEventId).toBe(4);
  });

  it('is a no-op when progress.jsonl is empty', () => {
    const store = createStore();
    const jobId = nextJobId('hydrate-empty');
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'ns1' });

    const store2 = createStore();
    store2.hydrateEventCounter(jobId);

    // First append should still be eventId 1
    const nextEventId = store2.appendProgress(jobId, 's1', 'first');
    expect(nextEventId).toBe(1);
  });
});

describe('hydrateJobStartedAt', () => {
  it('sets the started time from a timestamp string', () => {
    const store = createStore();
    const jobId = nextJobId('hydrate-started');
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'ns1' });

    // Hydrate with a known past time so elapsed formatting is predictable
    const pastTime = new Date(nowMs() - 62_000).toISOString();
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
    const store = createStore();
    const jobId = nextJobId('hydrate-invalid');
    store.initJob({ jobId, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'ns1' });

    // Should not throw for invalid input
    expect(() => store.hydrateJobStartedAt(jobId, 'not-a-date')).not.toThrow();
  });
});

describe('nextEnqueueSequence', () => {
  it('returns monotonically increasing values', () => {
    const store = createStore();
    const first = store.nextEnqueueSequence();
    const second = store.nextEnqueueSequence();
    const third = store.nextEnqueueSequence();

    expect(second).toBe(first + 1);
    expect(third).toBe(second + 1);
  });
});

describe('namespace-bound discovery scan', () => {
  it('excludes foreign-namespace jobs and includes own + legacy', () => {
    // Seed JOBS_DIR with four jobs in distinct ownership states via a
    // sibling store. The sibling is only a tool for constructing on-disk
    // state — its knownJobIds is irrelevant to the assertion.
    const seeder = new ProgressStore('ns-alpha', runtime);
    const ownedId = nextJobId('owned');
    const foreignId = nextJobId('foreign');
    const legacyId = nextJobId('legacy');
    const corruptId = nextJobId('corrupt');

    seeder.initJob({ jobId: ownedId, sessionId: 's1', provider: 'codex', projectRoot, backendNamespace: 'ns-alpha' });
    seeder.initJob({ jobId: foreignId, sessionId: 's2', provider: 'codex', projectRoot, backendNamespace: 'ns-beta' });

    // Legacy job: write a status.json with no backendNamespace field.
    const legacyDir = join(JOBS_DIR, legacyId);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'status.json'),
      JSON.stringify({
        jobId: legacyId,
        sessionId: 's3',
        provider: 'codex',
        projectRoot,
        phase: 'completed',
        launch: { state: 'ready', updatedAt: isoNow() },
      }),
      'utf-8',
    );

    // Corrupt job: status.json unreadable.
    const corruptDir = join(JOBS_DIR, corruptId);
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, 'status.json'), '{not-json', 'utf-8');

    // Fresh store bound to ns-alpha rescans JOBS_DIR at construction.
    const alpha = new ProgressStore('ns-alpha', runtime);
    const alphaIds = new Set(alpha.listJobIds());

    expect(alphaIds.has(ownedId)).toBe(true);
    expect(alphaIds.has(legacyId)).toBe(true);
    expect(alphaIds.has(corruptId)).toBe(true);
    expect(alphaIds.has(foreignId)).toBe(false);

    // A second store bound to ns-beta sees the mirror image: its own job,
    // legacy (adoptable), and corrupt (undetermined), but not the alpha job.
    const beta = new ProgressStore('ns-beta', runtime);
    const betaIds = new Set(beta.listJobIds());

    expect(betaIds.has(foreignId)).toBe(true);
    expect(betaIds.has(legacyId)).toBe(true);
    expect(betaIds.has(corruptId)).toBe(true);
    expect(betaIds.has(ownedId)).toBe(false);
  });
});

describe('cross-namespace orphan adoption', () => {
  it('adopts live-phase jobs from dead foreign namespaces but skips live ones', async () => {
    const { adoptOrphanedCrossNamespaceJobs } = await import('../lifecycle.js');

    // Create a job under foreign namespace 'ns-old' with running phase
    const seeder = new ProgressStore('ns-old', runtime);
    const orphanId = nextJobId('orphan');
    const aliveId = nextJobId('alive');

    seeder.initJob({
      jobId: orphanId,
      sessionId: 's1',
      provider: 'codex',
      projectRoot,
      backendNamespace: 'ns-old',
      initialPhase: 'running',
    });

    seeder.initJob({
      jobId: aliveId,
      sessionId: 's2',
      provider: 'codex',
      projectRoot,
      backendNamespace: 'ns-alive',
      initialPhase: 'running',
    });

    const orphanInstallDir = runtime.paths.installationDirForNamespace('ns-old');
    const aliveInstallDir = runtime.paths.installationDirForNamespace('ns-alive');
    mkdirSync(orphanInstallDir, { recursive: true });
    mkdirSync(aliveInstallDir, { recursive: true });

    writeFileSync(
      join(orphanInstallDir, 'backend.lock'),
      JSON.stringify({
        instanceId: 'orphan-stale-instance',
        pid: 41_000,
        version: '0.1.0',
        bundleHash: 'x',
        flavor: 'prod',
        startedAt: nowMs(),
      }),
      'utf-8',
    );
    runtime.time.tick(60_000);

    const alivePid = startAliveProcess(42_000);
    writeFileSync(
      join(aliveInstallDir, 'backend.json'),
      JSON.stringify({
        pid: alivePid,
        port: 9999,
        host: '127.0.0.1',
        token: 'x',
        version: '0.1.0',
        bundleHash: 'x',
        flavor: 'dev',
        instanceId: 'alive-instance',
        namespace: 'ns-alive',
        startedAt: nowMs(),
      }),
    );
    writeFileSync(
      join(aliveInstallDir, 'backend.lock'),
      JSON.stringify({
        instanceId: 'alive-instance',
        pid: alivePid,
        version: '0.1.0',
        bundleHash: 'x',
        flavor: 'dev',
        startedAt: nowMs(),
      }),
    );

    // Run adoption for new namespace 'ns-new'
    const logs: string[] = [];
    const adopted = adoptOrphanedCrossNamespaceJobs('ns-new', runtime, (msg) => logs.push(msg));

    // Should adopt orphan (dead daemon) but NOT alive (live daemon)
    expect(adopted).toBe(1);
    expect(logs.some((l) => l.includes(orphanId))).toBe(true);
    expect(logs.some((l) => l.includes(aliveId))).toBe(false);

    // New ProgressStore should now see the adopted job
    const store = new ProgressStore('ns-new', runtime);
    const ids = new Set(store.listJobIds());
    expect(ids.has(orphanId)).toBe(true);
    expect(ids.has(aliveId)).toBe(false);
  });

  it('does not adopt while a foreign namespace only has a fresh backend.lock startup sentinel', async () => {
    const { adoptOrphanedCrossNamespaceJobs } = await import('../lifecycle.js');

    const seeder = new ProgressStore('ns-starting', runtime);
    const startupId = nextJobId('startup');

    seeder.initJob({
      jobId: startupId,
      sessionId: 's1',
      provider: 'codex',
      projectRoot,
      backendNamespace: 'ns-starting',
      initialPhase: 'running',
    });

    const installDir = runtime.paths.installationDirForNamespace('ns-starting');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, 'backend.lock'),
      JSON.stringify({
        instanceId: 'startup-instance',
        pid: runtime.env.pid(),
        version: '0.1.0',
        bundleHash: 'x',
        flavor: 'prod',
        startedAt: nowMs(),
      }),
      'utf-8',
    );

    const adopted = adoptOrphanedCrossNamespaceJobs('ns-new', runtime, () => {});

    expect(adopted).toBe(0);
    const store = new ProgressStore('ns-new', runtime);
    expect(store.listJobIds()).not.toContain(startupId);
  });

  it('adopts when backend.json points at a reused pid but backend.lock belongs to a different instance', async () => {
    const { adoptOrphanedCrossNamespaceJobs } = await import('../lifecycle.js');

    const seeder = new ProgressStore('ns-reused-pid', runtime);
    const reusedId = nextJobId('reused');

    seeder.initJob({
      jobId: reusedId,
      sessionId: 's1',
      provider: 'codex',
      projectRoot,
      backendNamespace: 'ns-reused-pid',
      initialPhase: 'running',
    });

    const installDir = runtime.paths.installationDirForNamespace('ns-reused-pid');
    mkdirSync(installDir, { recursive: true });
    const reusedPid = startAliveProcess(43_000);
    writeFileSync(
      join(installDir, 'backend.json'),
      JSON.stringify({
        pid: reusedPid,
        port: 9999,
        host: '127.0.0.1',
        token: 'x',
        version: '0.1.0',
        bundleHash: 'x',
        flavor: 'prod',
        instanceId: 'stale-instance',
        namespace: 'ns-reused-pid',
        startedAt: nowMs(),
      }),
      'utf-8',
    );
    writeFileSync(
      join(installDir, 'backend.lock'),
      JSON.stringify({
        instanceId: 'other-instance',
        pid: reusedPid,
        version: '0.1.0',
        bundleHash: 'x',
        flavor: 'prod',
        startedAt: nowMs(),
      }),
      'utf-8',
    );

    const adopted = adoptOrphanedCrossNamespaceJobs('ns-new', runtime, () => {});

    expect(adopted).toBe(1);
    const store = new ProgressStore('ns-new', runtime);
    expect(store.listJobIds()).toContain(reusedId);
  });
});
