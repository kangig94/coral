import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PersistedProgressRecord,
  PersistedStatusRecord,
  ProviderRequest,
  ProviderResult,
  WaitStreamEvent,
} from '../../types.js';

import type { Provider } from '../../providers/types.js';
import { parseExpression } from '../../workflow/pipe-parser.js';
import {
  MAX_ACTIVE_SESSIONS,
  cancelQueued,
  getActiveJobIds,
  killAllChildren,
  queueDepth,
  releaseLaunch,
} from '../engine.js';
import { AbortRegistry } from '../abort-registry.js';
import { JOBS_DIR, jobResultPath, type ProgressStore } from '../progress-store.js';
import { SessionManager } from '../session-manager.js';
import { ExecutionService, type CallerContext } from '../service.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  getNewProvider: vi.fn(),
  resolveCoralContent: vi.fn(),
}));
const TEST_BACKEND_NAMESPACE = 'test-namespace';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
  };
});

vi.mock('../../providers/registry.js', () => ({
  getNewProvider: mockState.getNewProvider,
}));

vi.mock('../../coral/resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../../coral/resolver.js')>('../../coral/resolver.js');
  return {
    ...actual,
    resolveCoralContent: mockState.resolveCoralContent,
  };
});

type ServiceInternals = {
  abortRegistry: AbortRegistry;
  progressStore: ProgressStore;
  sessionManager: SessionManager;
};

const createdJobIds = new Set<string>();
let baselineJobIds = new Set<string>();

function getInternals(service: ExecutionService): ServiceInternals {
  return service as unknown as ServiceInternals;
}

function trackJob(jobId: string): void {
  createdJobIds.add(jobId);
}

function listJobDirs(): Set<string> {
  try {
    return new Set(
      readdirSync(JOBS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
  } catch {
    return new Set<string>();
  }
}

function trackAllJobDirs(): void {
  try {
    for (const jobId of listJobDirs()) {
      if (baselineJobIds.has(jobId)) continue;
      createdJobIds.add(jobId);
    }
  } catch {
    /* best effort */
  }
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeProvider(options?: {
  execute?: Provider['execute'];
  preflight?: Provider['preflight'];
}): { provider: Provider; execute: ReturnType<typeof vi.fn>; preflight?: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(
    options?.execute ??
      (async (): Promise<ProviderResult> => ({
        content: 'ok',
      })),
  );
  const preflight = options?.preflight ? vi.fn(options.preflight) : undefined;
  const provider: Provider = {
    name: 'codex',
    execute,
    ...(preflight ? { preflight } : {}),
  };
  return { provider, execute, preflight };
}

async function occupyProviderSlots(
  service: ExecutionService,
  ctx: CallerContext,
  providerName: string,
): Promise<string[]> {
  const decisions = await Promise.all(
    Array.from({ length: MAX_ACTIVE_SESSIONS }, (_value, index) =>
      service.start(providerName, { prompt: `occupy-${index}` }, ctx)),
  );

  const jobIds: string[] = [];
  for (const decision of decisions) {
    expect(decision.status).toBe('running');
    if (decision.status !== 'running') {
      throw new Error('expected running launch while occupying capacity');
    }
    trackJob(decision.job);
    jobIds.push(decision.job);
  }

  return jobIds;
}

async function waitForTerminalEvent(
  service: ExecutionService,
  jobId: string,
): Promise<Extract<WaitStreamEvent, { type: 'terminal' }>> {
  for await (const event of service.waitStream({ jobIds: [jobId], timeoutSeconds: 5 })) {
    if (event.type === 'terminal') {
      return event;
    }
  }

  throw new Error(`Expected terminal event for ${jobId}`);
}

describe('ExecutionService', () => {
  let ctx: CallerContext;

  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-execution-home-'));
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    ctx = { projectRoot, pluginRoot: join(projectRoot, 'plugin'), coralEnv: {} };
    baselineJobIds = listJobDirs();
    mockState.getNewProvider.mockReset();
    mockState.resolveCoralContent.mockReset();
  });

  afterEach(async () => {
    trackAllJobDirs();
    killAllChildren();
    for (const jobId of createdJobIds) {
      cancelQueued(jobId);
      releaseLaunch(jobId);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const jobId of createdJobIds) {
      rmSync(join(JOBS_DIR, jobId), { recursive: true, force: true });
    }
    createdJobIds.clear();
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.getNewProvider.mockReset();
    mockState.resolveCoralContent.mockReset();
    vi.restoreAllMocks();
  });

  it('start returns a running LaunchDecision with job and session ids', async () => {
    const never = new Promise<ProviderResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = new ExecutionService(ctx);

    const decision = await service.start('codex', { prompt: 'hello' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status === 'running') {
      trackJob(decision.job);
      expect(decision.job).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(decision.session).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    }
  });

  it('start rejects unknown providers', async () => {
    mockState.getNewProvider.mockReturnValue(undefined);
    const service = new ExecutionService(ctx);

    const decision = await service.start('missing', { prompt: 'hello' }, ctx);

    expect(decision).toEqual({
      status: 'rejected',
      phase: 'preflight',
      code: 'unknown_provider',
      message: 'Unknown provider: missing',
    });
  });

  it('start rejects when preflight throws', async () => {
    const { provider, preflight } = makeProvider({
      preflight: async () => {
        throw new Error('not ready');
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = new ExecutionService(ctx);

    const decision = await service.start('codex', { prompt: 'hello' }, ctx);

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({
      status: 'rejected',
      phase: 'preflight',
      code: 'preflight_failed',
      message: 'not ready',
    });
  });

  it('start returns queued when provider launch slots are full', async () => {
    const never = new Promise<ProviderResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = new ExecutionService(ctx);
    await occupyProviderSlots(service, ctx, 'codex');

    const decision = await service.start('codex', { prompt: 'queued job' }, ctx);

    expect(decision.status).toBe('queued');
    if (decision.status !== 'queued') throw new Error('expected queued launch');
    trackJob(decision.job);

    const { progressStore } = getInternals(service);
    expect(progressStore.readStatus(decision.job)).toMatchObject({
      jobId: decision.job,
      sessionId: decision.session,
      provider: 'codex',
      phase: 'queued',
      launch: {
        state: 'queued',
      },
    });
  });

  it('resume rejects when the session is missing', async () => {
    const { provider } = makeProvider();
    mockState.getNewProvider.mockReturnValue(provider);
    const service = new ExecutionService(ctx);

    const decision = await service.resume('codex', { sessionId: 'missing', prompt: 'hello' }, ctx);

    expect(decision).toMatchObject({
      status: 'rejected',
      phase: 'preflight',
      code: 'session_not_found',
    });
    if (decision.status === 'rejected') {
      expect(decision.message).toContain('Session not found: missing');
    }
  });

  it('resume rejects when the session already has an active job', async () => {
    const { provider } = makeProvider();
    mockState.getNewProvider.mockReturnValue(provider);
    const mgr = new SessionManager(ctx.projectRoot);
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', ctx.projectRoot);
    mgr.claimForJobSync(entry.sessionId, 'job-1');
    const service = new ExecutionService(ctx);

    const decision = await service.resume('codex', { sessionId: entry.sessionId, prompt: 'hello' }, ctx);

    expect(decision).toMatchObject({
      status: 'rejected',
      phase: 'preflight',
      code: 'session_busy',
    });
    if (decision.status === 'rejected') {
      expect(decision.message).toContain(`Session ${entry.sessionId} already has an active job`);
    }
  });

  it('resume rolls back queued admission when the session becomes busy during preflight', async () => {
    const never = new Promise<ProviderResult>(() => {});
    const blockingProvider = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(blockingProvider.provider);
    const service = new ExecutionService(ctx);
    await occupyProviderSlots(service, ctx, 'codex');

    const gate = createDeferred<void>();
    const racingProvider = makeProvider({
      preflight: async () => {
        await gate.promise;
      },
    });
    mockState.getNewProvider.mockReturnValue(racingProvider.provider);

    const mgr = new SessionManager(ctx.projectRoot);
    const entry = mgr.allocate('codex', 'alpha', 'gpt-5', ctx.projectRoot);
    const jobDirsBefore = listJobDirs();

    const decisionPromise = service.resume('codex', { sessionId: entry.sessionId, prompt: 'hello' }, ctx);
    expect(mgr.claimForJobSync(entry.sessionId, 'job-race')).toBe(true);
    gate.resolve();

    const decision = await decisionPromise;

    expect(decision.status).toBe('rejected');
    if (decision.status !== 'rejected') throw new Error('expected rejected');
    expect(decision.code).toBe('session_busy');
    expect(decision.message).toContain(`Session ${entry.sessionId} already has an active job`);
    expect(queueDepth()).toBe(0);
    expect(listJobDirs()).toEqual(jobDirsBefore);
    expect(mgr.get('codex', entry.sessionId)?.activeJobId).toBe('job-race');
  });

  it('fork allocates a new session id', async () => {
    const never = new Promise<ProviderResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const mgr = new SessionManager(ctx.projectRoot);
    const source = mgr.allocate('codex', 'source', 'gpt-5', ctx.projectRoot);
    const service = new ExecutionService(ctx);

    const decision = await service.fork('codex', { sessionId: source.sessionId, prompt: 'branch' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status === 'running') {
      trackJob(decision.job);
      expect(decision.session).not.toBe(source.sessionId);
      expect(mgr.get('codex', decision.session)?.name).toMatch(/^fork-/);
    }
  });

  it('abort aborts the correct jobs', async () => {
    const never = new Promise<ProviderResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = new ExecutionService(ctx);

    const first = await service.start('codex', { prompt: 'first' }, ctx);
    const second = await service.start('codex', { prompt: 'second' }, ctx);

    expect(first.status).toBe('running');
    expect(second.status).toBe('running');
    if (first.status !== 'running' || second.status !== 'running') {
      throw new Error('expected running jobs');
    }

    trackJob(first.job);
    trackJob(second.job);
    const result = service.abort([first.job, 'missing-job']);
    const { abortRegistry } = getInternals(service);

    expect(result).toEqual({
      aborted: [first.job],
      notFound: ['missing-job'],
    });
    expect(abortRegistry.getSignal(first.job)?.aborted).toBe(true);
    expect(abortRegistry.getSignal(second.job)?.aborted).toBe(false);
  });

  it('abort persists queued jobs as aborted instead of error', async () => {
    const never = new Promise<ProviderResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = new ExecutionService(ctx);
    await occupyProviderSlots(service, ctx, 'codex');

    const decision = await service.start('codex', { prompt: 'queued job' }, ctx);

    expect(decision.status).toBe('queued');
    if (decision.status !== 'queued') throw new Error('expected queued launch');
    trackJob(decision.job);

    const abortResult = service.abort([decision.job]);
    const { progressStore } = getInternals(service);

    expect(abortResult).toEqual({
      aborted: [decision.job],
      notFound: [],
    });
    expect(progressStore.readStatus(decision.job)).toMatchObject({
      phase: 'aborted',
      result: {
        aborted: true,
        notice: 'Aborted while queued.',
      },
    });
  });

  it('awaitLaunch returns ready once the launch state changes', async () => {
    const service = new ExecutionService(ctx);
    const { progressStore } = getInternals(service);
    const jobId = `test-await-launch-${Date.now()}`;
    progressStore.initJob(jobId, 'test-session', 'codex', ctx.projectRoot);

    setTimeout(() => {
      progressStore.updateLaunchState(jobId, 'ready');
    }, 10);

    await expect(service.awaitLaunch(jobId, 1000)).resolves.toBe('ready');
  });

  it('coralDispatch resolves coral content and injects a system instruction', async () => {
    const { provider, execute } = makeProvider();
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveCoralContent.mockReturnValue({
      type: 'agent',
      content: '---\nname: sample\n---\nInjected coral content',
      path: '/tmp/sample.md',
    });
    const service = new ExecutionService(ctx);

    const decision = await service.coralDispatch('codex', 'sample', { prompt: 'hello' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status === 'running') {
      trackJob(decision.job);
    }
    expect(mockState.resolveCoralContent).toHaveBeenCalledWith('sample');
    const [request] = execute.mock.calls[0] as unknown as [ProviderRequest];
    expect(request).toMatchObject({
      action: 'exec',
      prompt: 'hello',
      bypassPermissions: true,

      instruction: {
        content: 'Injected coral content',
        channel: 'system',
      },
    });
  });

  it('waitStream yields progress and terminal events in order', async () => {
    const service = new ExecutionService(ctx);
    const { progressStore } = getInternals(service);
    const status: PersistedStatusRecord = {
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      phase: 'running',
      launch: {
        state: 'ready',
        updatedAt: '2026-03-06T00:00:00.000Z',
      },
    };
    const replay: PersistedProgressRecord[] = [
      {
        jobId: 'job-1',
        sessionId: 'session-1',
        eventId: 1,
        type: 'progress',
        ts: '2026-03-06T00:00:01.000Z',
        message: 'step 1',
      },
      {
        jobId: 'job-1',
        sessionId: 'session-1',
        eventId: 2,
        type: 'terminal',
        ts: '2026-03-06T00:00:02.000Z',
        result: { content: 'done' },
      },
    ];

    vi.spyOn(progressStore, 'readStatus').mockReturnValue(status);
    vi.spyOn(progressStore, 'replayFrom').mockReturnValue(replay);

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: ['job-1'], timeoutSeconds: 1 })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'progress',
        jobId: 'job-1',
        sessionId: 'session-1',
        eventId: 1,
        message: 'step 1',
      },
      {
        type: 'terminal',
        completedJobId: 'job-1',
        sessionId: 'session-1',
        remainingJobIds: [],
        resultPath: `${JOBS_DIR}/job-1/result.md`,
        result: { content: 'done' },
      },
    ]);
  });

  it('waitStream yields terminal from status when no terminal event is replayed', async () => {
    const service = new ExecutionService(ctx);
    const { progressStore } = getInternals(service);
    vi.spyOn(progressStore, 'readStatus').mockReturnValue({
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      phase: 'completed',
      launch: {
        state: 'ready',
        updatedAt: '2026-03-06T00:00:00.000Z',
      },
      result: { content: 'done' },
    });
    vi.spyOn(progressStore, 'replayFrom').mockReturnValue([]);

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: ['job-1'], timeoutSeconds: 1 })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'terminal',
        completedJobId: 'job-1',
        sessionId: 'session-1',
        remainingJobIds: [],
        resultPath: `${JOBS_DIR}/job-1/result.md`,
        result: { content: 'done' },
      },
    ]);
  });

  it('waitStream re-reads terminal status after replay before waiting for more changes', async () => {
    const service = new ExecutionService(ctx);
    const { progressStore } = getInternals(service);
    const runningStatus: PersistedStatusRecord = {
      jobId: 'job-1',
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: ctx.projectRoot,
      backendNamespace: TEST_BACKEND_NAMESPACE,
      phase: 'running',
      launch: {
        state: 'ready',
        updatedAt: '2026-03-06T00:00:00.000Z',
      },
    };
    const terminalStatus: PersistedStatusRecord = {
      ...runningStatus,
      phase: 'completed',
      result: { content: 'done' },
    };

    vi.spyOn(progressStore, 'readStatus')
      .mockImplementationOnce(() => runningStatus)
      .mockImplementation(() => terminalStatus);
    vi.spyOn(progressStore, 'replayFrom').mockReturnValue([]);
    const waitForChange = vi.spyOn(progressStore, 'waitForChange').mockImplementation(() => {
      throw new Error('waitForChange should not be called once terminal status is visible');
    });

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: ['job-1'], timeoutSeconds: 600 })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'terminal',
        completedJobId: 'job-1',
        sessionId: 'session-1',
        remainingJobIds: [],
        resultPath: `${JOBS_DIR}/job-1/result.md`,
        result: { content: 'done' },
      },
    ]);
    expect(waitForChange).not.toHaveBeenCalled();
  });

  it('waitStream emits a queued event before replaying queued progress records', async () => {
    const never = new Promise<ProviderResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    const service = new ExecutionService(ctx);
    const runningJobIds = await occupyProviderSlots(service, ctx, 'codex');
    const decision = await service.start('codex', { prompt: 'queued job' }, ctx);

    expect(decision.status).toBe('queued');
    if (decision.status !== 'queued') throw new Error('expected queued launch');
    trackJob(decision.job);

    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: [decision.job], timeoutSeconds: 1 })) {
      events.push(event);
      if (events.length === 2) break;
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'queued',
      jobId: decision.job,
      sessionId: decision.session,
      queuePosition: 1,
      runningJobIds,
    });
    expect(events[1]).toMatchObject({
      type: 'progress',
      jobId: decision.job,
      sessionId: decision.session,
      eventId: 1,
    });
    if (events[1]?.type === 'progress') {
      expect(events[1].message).toContain('queued (position 1)');
    }
  });

  it('persists successful workflow results before exposing the terminal event', async () => {
    const { provider } = makeProvider({
      execute: async (request) => {
        if (request.name?.startsWith('architect')) {
          return { content: 'ARCH' };
        }
        if (request.name?.startsWith('resolver')) {
          return { content: 'FINAL' };
        }
        return { content: 'unexpected' };
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveCoralContent.mockImplementation((name: string) => ({
      type: 'agent',
      content: `Injected ${name} content`,
      path: `/tmp/${name}.md`,
    }));

    const service = new ExecutionService(ctx);
    const decision = await service.executeWorkflow(
      'codex',
      parseExpression('architect -> resolver'),
      {
        expression: 'architect -> resolver',
        init_prompt: 'seed',
        provider: 'codex',
        stale_timeout_seconds: 0,
      },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackAllJobDirs();

    const terminal = await waitForTerminalEvent(service, decision.job);
    const markdownAtTerminal = readFileSync(terminal.resultPath, 'utf-8');
    const session = new SessionManager(ctx.projectRoot).get('codex', decision.session);
    const { progressStore } = getInternals(service);
    const status = progressStore.readStatus(decision.job);

    expect(existsSync(terminal.resultPath)).toBe(true);
    expect(markdownAtTerminal).toBe([
      '# Step 0.0: architect',
      '',
      'ARCH',
      '',
      '# Step 1.0: resolver',
      '',
      'FINAL',
      '',
    ].join('\n'));
    expect(terminal.result).toEqual({
      content: 'FINAL',
      workflow: {
        steps: [
          {
            agent: 'architect',
            step: 0,
            atom: 0,
            provider: 'codex',
            start: 3,
            end: 3,
          },
          {
            agent: 'resolver',
            step: 1,
            atom: 0,
            provider: 'codex',
            start: 7,
            end: 7,
          },
        ],
      },
    });
    expect(status).toMatchObject({
      phase: 'completed',
      jobKind: 'workflow',
      result: terminal.result,
    });
    expect(session?.state).toBe('non_resumable');
  });

  it('keeps workflow session provenance on projectRoot while launching atoms in workDir', async () => {
    const seenCwds: string[] = [];
    const { provider } = makeProvider({
      execute: async (request) => {
        if (!request.cwd) throw new Error('expected workflow atom cwd');
        seenCwds.push(request.cwd);
        if (request.name?.startsWith('architect')) {
          return { content: 'ARCH' };
        }
        return { content: 'FINAL' };
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveCoralContent.mockImplementation((name: string) => ({
      type: 'agent',
      content: `Injected ${name} content`,
      path: `/tmp/${name}.md`,
    }));

    const service = new ExecutionService(ctx);
    const workDir = join(mockState.tmpHome, 'child-workdir');
    mkdirSync(workDir, { recursive: true });

    const decision = await service.executeWorkflow(
      'codex',
      parseExpression('architect -> resolver'),
      {
        expression: 'architect -> resolver',
        init_prompt: 'seed',
        provider: 'codex',
        stale_timeout_seconds: 0,
      },
      ctx,
      workDir,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackAllJobDirs();

    await waitForTerminalEvent(service, decision.job);

    const workflowSession = new SessionManager(ctx.projectRoot).get('codex', decision.session);
    const workDirSession = new SessionManager(workDir).get('codex', decision.session);

    expect(seenCwds).toEqual([workDir, workDir]);
    expect(workflowSession?.cwd).toBe(ctx.projectRoot);
    expect(workDirSession).toBeNull();
  });

  it('executeWorkflow bypasses launch admission when provider slots are full', async () => {
    const never = new Promise<ProviderResult>(() => {});
    const { provider } = makeProvider({ execute: () => never });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveCoralContent.mockImplementation((name: string) => ({
      type: 'agent',
      content: `Injected ${name} content`,
      path: `/tmp/${name}.md`,
    }));

    const service = new ExecutionService(ctx);
    for (const jobId of getActiveJobIds()) {
      releaseLaunch(jobId);
    }
    expect(queueDepth()).toBe(0);
    const activeJobIds = await occupyProviderSlots(service, ctx, 'codex');

    const decision = await service.executeWorkflow(
      'codex',
      parseExpression('architect'),
      {
        expression: 'architect',
        init_prompt: 'seed',
        provider: 'codex',
        stale_timeout_seconds: 0,
      },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackJob(decision.job);
    expect(getActiveJobIds()).toEqual(activeJobIds);
    const { progressStore } = getInternals(service);
    expect(progressStore.readStatus(decision.job)).toMatchObject({
      jobId: decision.job,
      sessionId: decision.session,
      jobKind: 'workflow',
      phase: 'running',
    });
  });

  it('persists partial workflow results on failure and marks the workflow session non_resumable', async () => {
    const { provider } = makeProvider({
      execute: async (request) => {
        if (request.name?.startsWith('architect')) {
          return { content: 'ARCH' };
        }
        if (request.name?.startsWith('resolver')) {
          return { content: '', notice: 'resolver failed' };
        }
        return { content: 'unexpected' };
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveCoralContent.mockImplementation((name: string) => ({
      type: 'agent',
      content: `Injected ${name} content`,
      path: `/tmp/${name}.md`,
    }));

    const service = new ExecutionService(ctx);
    const decision = await service.executeWorkflow(
      'codex',
      parseExpression('architect -> resolver'),
      {
        expression: 'architect -> resolver',
        init_prompt: 'seed',
        provider: 'codex',
        stale_timeout_seconds: 0,
      },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackAllJobDirs();

    const terminal = await waitForTerminalEvent(service, decision.job);
    const markdownAtTerminal = readFileSync(terminal.resultPath, 'utf-8');
    const session = new SessionManager(ctx.projectRoot).get('codex', decision.session);
    const { progressStore } = getInternals(service);
    const status = progressStore.readStatus(decision.job);

    expect(markdownAtTerminal).toBe('# Step 0.0: architect\n\nARCH\n');
    expect(terminal.result).toEqual({
      content: '',
      notice: "Step 1, atom 'resolver' failed: resolver failed",
      workflow: {
        steps: [
          {
            agent: 'architect',
            step: 0,
            atom: 0,
            provider: 'codex',
            start: 3,
            end: 3,
          },
        ],
      },
    });
    expect(status).toMatchObject({
      phase: 'error',
      result: terminal.result,
    });
    expect(session?.state).toBe('non_resumable');
  });

  it('persists partial workflow results on abort and marks the workflow session non_resumable', async () => {
    const { provider } = makeProvider({
      execute: async (request) => {
        if (request.name?.startsWith('architect')) {
          return { content: 'ARCH' };
        }
        if (request.name?.startsWith('resolver')) {
          return { content: '', aborted: true };
        }
        return { content: 'unexpected' };
      },
    });
    mockState.getNewProvider.mockReturnValue(provider);
    mockState.resolveCoralContent.mockImplementation((name: string) => ({
      type: 'agent',
      content: `Injected ${name} content`,
      path: `/tmp/${name}.md`,
    }));

    const service = new ExecutionService(ctx);
    const decision = await service.executeWorkflow(
      'codex',
      parseExpression('architect -> resolver'),
      {
        expression: 'architect -> resolver',
        init_prompt: 'seed',
        provider: 'codex',
        stale_timeout_seconds: 0,
      },
      ctx,
    );

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackAllJobDirs();

    const terminal = await waitForTerminalEvent(service, decision.job);
    const markdownAtTerminal = readFileSync(terminal.resultPath, 'utf-8');
    const session = new SessionManager(ctx.projectRoot).get('codex', decision.session);
    const { progressStore } = getInternals(service);
    const status = progressStore.readStatus(decision.job);

    expect(markdownAtTerminal).toBe('# Step 0.0: architect\n\nARCH\n');
    expect(terminal.result).toEqual({
      content: '',
      aborted: true,
      notice: "Step 1, atom 'resolver' failed: aborted",
      workflow: {
        steps: [
          {
            agent: 'architect',
            step: 0,
            atom: 0,
            provider: 'codex',
            start: 3,
            end: 3,
          },
        ],
      },
    });
    expect(status).toMatchObject({
      phase: 'aborted',
      result: terminal.result,
    });
    expect(session?.state).toBe('non_resumable');
  });

  it('start falls back to status-only terminal persistence when appendTerminal throws', async () => {
    const { provider } = makeProvider();
    mockState.getNewProvider.mockReturnValue(provider);

    const service = new ExecutionService(ctx);
    const { progressStore } = getInternals(service);
    const appendTerminal = vi.spyOn(progressStore, 'appendTerminal').mockImplementation(() => {
      throw new Error('disk full');
    });
    const markTerminalStatus = vi.spyOn(progressStore, 'markTerminalStatus');

    const decision = await service.start('codex', { prompt: 'hello' }, ctx);

    expect(decision.status).toBe('running');
    if (decision.status !== 'running') throw new Error('expected running');
    trackJob(decision.job);

    const terminal = await waitForTerminalEvent(service, decision.job);
    const status = progressStore.readStatus(decision.job);

    expect(appendTerminal).toHaveBeenCalled();
    expect(markTerminalStatus).toHaveBeenCalledWith(
      decision.job,
      decision.session,
      expect.objectContaining({ content: 'ok' }),
      'completed',
    );
    expect(terminal.result).toEqual({ content: 'ok' });
    expect(status).toMatchObject({
      phase: 'completed',
      result: { content: 'ok' },
    });
  });

  it('finishQueuedAbort falls back to status-only terminal persistence when appendTerminal throws', () => {
    const service = new ExecutionService(ctx);
    const { progressStore } = getInternals(service);
    const jobId = `queued-abort-${randomUUID()}`;
    trackJob(jobId);
    progressStore.initJob(jobId, 'session-1', 'codex', ctx.projectRoot);
    vi.spyOn(progressStore, 'appendTerminal').mockImplementation(() => {
      throw new Error('disk full');
    });
    const markTerminalStatus = vi.spyOn(progressStore, 'markTerminalStatus');

    (
      service as unknown as {
        finishQueuedAbort(jobId: string, sessionId: string, message: string): void;
      }
    ).finishQueuedAbort(jobId, 'session-1', 'Aborted while queued.');

    expect(markTerminalStatus).toHaveBeenCalledWith(
      jobId,
      'session-1',
      { content: '', aborted: true, notice: 'Aborted while queued.' },
      'aborted',
    );
    expect(progressStore.readStatus(jobId)).toMatchObject({ phase: 'aborted' });
  });

  it('failJob falls back to status-only terminal persistence when appendTerminal throws', () => {
    const service = new ExecutionService(ctx);
    const { progressStore } = getInternals(service);
    const jobId = `fail-job-${randomUUID()}`;
    trackJob(jobId);
    progressStore.initJob(jobId, 'session-1', 'codex', ctx.projectRoot);
    vi.spyOn(progressStore, 'appendTerminal').mockImplementation(() => {
      throw new Error('disk full');
    });
    const markTerminalStatus = vi.spyOn(progressStore, 'markTerminalStatus');

    (
      service as unknown as {
        failJob(jobId: string, sessionId: string, launchState: string, message: string): void;
      }
    ).failJob(jobId, 'session-1', 'error', 'provider failed');

    expect(markTerminalStatus).toHaveBeenCalledWith(
      jobId,
      'session-1',
      { content: '', notice: 'provider failed' },
      'error',
    );
    expect(progressStore.readStatus(jobId)).toMatchObject({ phase: 'error' });
  });

  it('finishWorkflowJob falls back to status-only terminal persistence when appendTerminal throws', () => {
    const service = new ExecutionService(ctx);
    const { progressStore } = getInternals(service);
    const jobId = `workflow-terminal-${randomUUID()}`;
    trackJob(jobId);
    progressStore.initJob(jobId, 'session-1', 'codex', ctx.projectRoot);
    vi.spyOn(progressStore, 'appendTerminal').mockImplementation(() => {
      throw new Error('disk full');
    });
    const markTerminalStatus = vi.spyOn(progressStore, 'markTerminalStatus');
    const result = { content: 'done', workflow: { steps: [] } };

    (
      service as unknown as {
        finishWorkflowJob(
          sessionId: string,
          jobId: string,
          phase: 'completed' | 'error' | 'aborted',
          result: { content: string; workflow: { steps: unknown[] } },
          markdown: string,
        ): void;
      }
    ).finishWorkflowJob('session-1', jobId, 'completed', result, '# workflow\n');

    expect(markTerminalStatus).toHaveBeenCalledWith(jobId, 'session-1', result, 'completed');
    expect(progressStore.readStatus(jobId)).toMatchObject({
      phase: 'completed',
      result,
    });
    expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe('# workflow\n');
  });

  it.each([
    {
      phase: 'completed' as const,
      result: { content: 'done', workflow: { steps: [] } },
      markdown: '# completed\n',
    },
    {
      phase: 'error' as const,
      result: { content: '', notice: 'failed', workflow: { steps: [] } },
      markdown: '# failed\n',
    },
    {
      phase: 'aborted' as const,
      result: { content: '', aborted: true, notice: 'aborted', workflow: { steps: [] } },
      markdown: '# aborted\n',
    },
  ])(
    'finishWorkflowJob writes result.md before %s terminal persistence and marks the session non_resumable afterward',
    ({ phase, result, markdown }) => {
      const service = new ExecutionService(ctx);
      const { progressStore, sessionManager } = getInternals(service);
      const session = sessionManager.allocate('codex', `workflow-${phase}`, 'workflow', ctx.projectRoot);
      const jobId = `workflow-order-${phase}-${randomUUID()}`;
      trackJob(jobId);
      progressStore.initJob(jobId, session.sessionId, 'codex', ctx.projectRoot, 'workflow');
      expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);

      const order: string[] = [];
      const originalWriteWorkflowResult = progressStore.writeWorkflowResultMdOrThrow.bind(progressStore);
      const originalAppendTerminal = progressStore.appendTerminal.bind(progressStore);
      const originalSetNonResumable = sessionManager.setNonResumable.bind(sessionManager);

      vi.spyOn(progressStore, 'writeWorkflowResultMdOrThrow').mockImplementation((targetJobId, persistedMarkdown) => {
        order.push('artifact');
        return originalWriteWorkflowResult(targetJobId, persistedMarkdown);
      });
      vi.spyOn(progressStore, 'appendTerminal').mockImplementation((targetJobId, targetSessionId, terminalResult, terminalPhase) => {
        order.push('terminal');
        expect(existsSync(jobResultPath(targetJobId))).toBe(true);
        expect(readFileSync(jobResultPath(targetJobId), 'utf-8')).toBe(markdown);
        expect(new SessionManager(ctx.projectRoot).get('codex', targetSessionId)?.state).toBe('pending');
        return originalAppendTerminal(targetJobId, targetSessionId, terminalResult, terminalPhase);
      });
      vi.spyOn(sessionManager, 'setNonResumable').mockImplementation((targetSessionId) => {
        order.push('non_resumable');
        expect(progressStore.readStatus(jobId)).toMatchObject({
          phase,
          result,
        });
        return originalSetNonResumable(targetSessionId);
      });

      (
        service as unknown as {
          finishWorkflowJob(
            sessionId: string,
            jobId: string,
            terminalPhase: 'completed' | 'error' | 'aborted',
            terminalResult: typeof result,
            persistedMarkdown: string,
          ): void;
        }
      ).finishWorkflowJob(session.sessionId, jobId, phase, result, markdown);

      expect(order).toEqual(['artifact', 'terminal', 'non_resumable']);
      expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe(markdown);
      expect(sessionManager.get('codex', session.sessionId)?.state).toBe('non_resumable');
    },
  );

  it('finishWorkflowJob writes result.md before status-only terminal fallback and marks the session non_resumable afterward', () => {
    const service = new ExecutionService(ctx);
    const { progressStore, sessionManager } = getInternals(service);
    const session = sessionManager.allocate('codex', 'workflow-fallback', 'workflow', ctx.projectRoot);
    const jobId = `workflow-fallback-order-${randomUUID()}`;
    const phase = 'aborted' as const;
    const result = { content: '', aborted: true, notice: 'aborted', workflow: { steps: [] } };
    const markdown = '# fallback\n';
    trackJob(jobId);
    progressStore.initJob(jobId, session.sessionId, 'codex', ctx.projectRoot, 'workflow');
    expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);

    const order: string[] = [];
    const originalWriteWorkflowResult = progressStore.writeWorkflowResultMdOrThrow.bind(progressStore);
    const originalMarkTerminalStatus = progressStore.markTerminalStatus.bind(progressStore);
    const originalSetNonResumable = sessionManager.setNonResumable.bind(sessionManager);

    vi.spyOn(progressStore, 'writeWorkflowResultMdOrThrow').mockImplementation((targetJobId, persistedMarkdown) => {
      order.push('artifact');
      return originalWriteWorkflowResult(targetJobId, persistedMarkdown);
    });
    vi.spyOn(progressStore, 'appendTerminal').mockImplementation(() => {
      throw new Error('disk full');
    });
    vi.spyOn(progressStore, 'markTerminalStatus').mockImplementation((targetJobId, targetSessionId, terminalResult, terminalPhase) => {
      order.push('terminal');
      expect(existsSync(jobResultPath(targetJobId))).toBe(true);
      expect(readFileSync(jobResultPath(targetJobId), 'utf-8')).toBe(markdown);
      expect(new SessionManager(ctx.projectRoot).get('codex', targetSessionId)?.state).toBe('pending');
      return originalMarkTerminalStatus(targetJobId, targetSessionId, terminalResult, terminalPhase);
    });
    vi.spyOn(sessionManager, 'setNonResumable').mockImplementation((targetSessionId) => {
      order.push('non_resumable');
      expect(progressStore.readStatus(jobId)).toMatchObject({
        phase,
        result,
      });
      return originalSetNonResumable(targetSessionId);
    });

    (
      service as unknown as {
        finishWorkflowJob(
          sessionId: string,
          jobId: string,
          terminalPhase: 'completed' | 'error' | 'aborted',
          terminalResult: typeof result,
          persistedMarkdown: string,
        ): void;
      }
    ).finishWorkflowJob(session.sessionId, jobId, phase, result, markdown);

    expect(order).toEqual(['artifact', 'terminal', 'non_resumable']);
    expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe(markdown);
    expect(sessionManager.get('codex', session.sessionId)?.state).toBe('non_resumable');
  });
});

// @flaky — timing-sensitive concurrent fork tests; passes in isolation, retry under parallel suite
describe('ExecutionService adversarial', { retry: 2 }, () => {
  let ctx: CallerContext;

  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'red-exec-home-'));
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    ctx = { projectRoot, pluginRoot: join(projectRoot, 'plugin'), coralEnv: {} };
    baselineJobIds = listJobDirs();
    mockState.getNewProvider.mockReset();
    mockState.resolveCoralContent.mockReset();
  });

  afterEach(() => {
    trackAllJobDirs();
    for (const jobId of createdJobIds) {
      rmSync(join(JOBS_DIR, jobId), { recursive: true, force: true });
    }
    createdJobIds.clear();
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
    mockState.getNewProvider.mockReset();
    mockState.resolveCoralContent.mockReset();
  });

  describe('ExecutionService.resume() adversarial', () => {
    it('rejects with non_resumable code when session state is non_resumable', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);

      const mgr = new SessionManager(ctx.projectRoot);
      const entry = mgr.allocate('codex', 'alpha', 'gpt-5', ctx.projectRoot);
      mgr.setNonResumable(entry.sessionId);

      const service = new ExecutionService(ctx);
      const decision = await service.resume('codex', { sessionId: entry.sessionId, prompt: 'hello' }, ctx);

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('non_resumable');
      expect(decision.message).toContain(`Session ${entry.sessionId} is non-resumable`);
    });

    it('rejects with session_busy when session has activeJobId set (via live start)', async () => {
      const never = new Promise<ProviderResult>(() => {});
      const { provider } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);

      const service = new ExecutionService(ctx);
      const firstDecision = await service.start('codex', { prompt: 'first' }, ctx);
      expect(firstDecision.status).toBe('running');
      if (firstDecision.status !== 'running') throw new Error('expected running');
      trackJob(firstDecision.job);

      const decision = await service.resume('codex', { sessionId: firstDecision.session, prompt: 'resume' }, ctx);

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('session_busy');
      expect(decision.message).toContain(`Session ${firstDecision.session} already has an active job`);
    });

    it('rejects with unknown_provider without setting activeJobId on the session', async () => {
      mockState.getNewProvider.mockReturnValue(undefined);
      const mgr = new SessionManager(ctx.projectRoot);
      const entry = mgr.allocate('codex', 'alpha', 'gpt-5', ctx.projectRoot);

      const service = new ExecutionService(ctx);
      const decision = await service.resume('codex', { sessionId: entry.sessionId, prompt: 'hi' }, ctx);

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('unknown_provider');
      expect(mgr.get('codex', entry.sessionId)?.activeJobId).toBeUndefined();
    });

    it('allows exactly one concurrent resume and rejects the stale loser with session_busy', async () => {
      const gate = createDeferred<void>();
      const never = new Promise<ProviderResult>(() => {});
      const { provider } = makeProvider({
        preflight: async () => {
          await gate.promise;
        },
        execute: async () => never,
      });
      mockState.getNewProvider.mockReturnValue(provider);

      const mgr = new SessionManager(ctx.projectRoot);
      const entry = mgr.allocate('codex', 'alpha', 'gpt-5', ctx.projectRoot);
      const jobDirsBefore = listJobDirs();
      const service = new ExecutionService(ctx);

      const firstResume = service.resume('codex', { sessionId: entry.sessionId, prompt: 'one' }, ctx);
      const secondResume = service.resume('codex', { sessionId: entry.sessionId, prompt: 'two' }, ctx);
      gate.resolve();

      const decisions = await Promise.all([firstResume, secondResume]);
      const running = decisions.filter((decision) => decision.status === 'running');
      const rejected = decisions.filter((decision) => decision.status === 'rejected');

      expect(running).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winner = running[0];
      if (!winner || winner.status !== 'running') throw new Error('expected running winner');
      trackJob(winner.job);

      const loser = rejected[0];
      if (!loser || loser.status !== 'rejected') throw new Error('expected rejected loser');
      expect(loser.code).toBe('session_busy');
      expect(loser.message).toContain(`Session ${entry.sessionId} already has an active job`);
      expect(mgr.get('codex', entry.sessionId)?.activeJobId).toBe(winner.job);
      expect([...listJobDirs()].filter((jobId) => !jobDirsBefore.has(jobId))).toHaveLength(1);
    });
  });

  describe('ExecutionService.fork() adversarial', () => {
    it('rejects with session_busy when source session has an active job', async () => {
      const never = new Promise<ProviderResult>(() => {});
      const { provider } = makeProvider({ execute: () => never });
      mockState.getNewProvider.mockReturnValue(provider);

      const service = new ExecutionService(ctx);
      const firstDecision = await service.start('codex', { prompt: 'first' }, ctx);
      expect(firstDecision.status).toBe('running');
      if (firstDecision.status !== 'running') throw new Error('expected running');
      trackJob(firstDecision.job);

      const forkDecision = await service.fork('codex', { sessionId: firstDecision.session, prompt: 'branch' }, ctx);

      expect(forkDecision.status).toBe('rejected');
      if (forkDecision.status !== 'rejected') throw new Error('expected rejected');
      expect(forkDecision.code).toBe('session_busy');
      expect(forkDecision.message).toContain(`Session ${firstDecision.session} already has an active job`);
    });

    it('rejects with unknown_provider without allocating a new session', async () => {
      mockState.getNewProvider.mockReturnValue(undefined);
      const mgr = new SessionManager(ctx.projectRoot);
      const source = mgr.allocate('codex', 'source', 'gpt-5', ctx.projectRoot);
      const sessionsBefore = mgr.list('codex').length;

      const service = new ExecutionService(ctx);
      const decision = await service.fork('codex', { sessionId: source.sessionId, prompt: 'branch' }, ctx);

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('unknown_provider');
      expect(mgr.list('codex').length).toBe(sessionsBefore);
    });

    it('rejects when the source session becomes busy during preflight without allocating a new fork session', async () => {
      const gate = createDeferred<void>();
      const { provider } = makeProvider({
        preflight: async () => {
          await gate.promise;
        },
      });
      mockState.getNewProvider.mockReturnValue(provider);

      const mgr = new SessionManager(ctx.projectRoot);
      const source = mgr.allocate('codex', 'source', 'gpt-5', ctx.projectRoot);
      const sessionsBefore = mgr.list('codex').length;
      const jobDirsBefore = listJobDirs();

      const service = new ExecutionService(ctx);
      const decisionPromise = service.fork('codex', { sessionId: source.sessionId, prompt: 'branch' }, ctx);
      expect(mgr.claimForJobSync(source.sessionId, 'job-race')).toBe(true);
      gate.resolve();

      const decision = await decisionPromise;

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('session_busy');
      expect(decision.message).toContain(`Session ${source.sessionId} already has an active job`);
      expect(mgr.list('codex').length).toBe(sessionsBefore);
      expect(listJobDirs()).toEqual(jobDirsBefore);
    });

    it('allows exactly one concurrent fork and rejects the stale loser with session_busy', async () => {
      const gate = createDeferred<void>();
      const never = new Promise<ProviderResult>(() => {});
      const { provider } = makeProvider({
        preflight: async () => {
          await gate.promise;
        },
        execute: async () => never,
      });
      mockState.getNewProvider.mockReturnValue(provider);

      const mgr = new SessionManager(ctx.projectRoot);
      const source = mgr.allocate('codex', 'source', 'gpt-5', ctx.projectRoot);
      const sessionsBefore = mgr.list('codex').length;
      const sourceVersionBefore = mgr.get('codex', source.sessionId)?.version;
      const jobDirsBefore = listJobDirs();
      const service = new ExecutionService(ctx);

      const firstFork = service.fork('codex', { sessionId: source.sessionId, prompt: 'branch-one' }, ctx);
      const secondFork = service.fork('codex', { sessionId: source.sessionId, prompt: 'branch-two' }, ctx);
      gate.resolve();

      const decisions = await Promise.all([firstFork, secondFork]);
      const running = decisions.filter((decision) => decision.status === 'running');
      const rejected = decisions.filter((decision) => decision.status === 'rejected');

      expect(running).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winner = running[0];
      if (!winner || winner.status !== 'running') throw new Error('expected running winner');
      trackJob(winner.job);

      const loser = rejected[0];
      if (!loser || loser.status !== 'rejected') throw new Error('expected rejected loser');
      expect(loser.code).toBe('session_busy');
      expect(loser.message).toContain(`Session ${source.sessionId} already has an active job`);
      expect(mgr.list('codex')).toHaveLength(sessionsBefore + 1);
      expect(mgr.get('codex', source.sessionId)?.activeJobId).toBeUndefined();
      expect(mgr.get('codex', source.sessionId)?.version).toBeGreaterThan(sourceVersionBefore ?? 0);
      expect([...listJobDirs()].filter((jobId) => !jobDirsBefore.has(jobId))).toHaveLength(1);
    });

    it('rejects with session_not_found for a non-existent source session', async () => {
      const { provider } = makeProvider();
      mockState.getNewProvider.mockReturnValue(provider);

      const service = new ExecutionService(ctx);
      const decision = await service.fork('codex', { sessionId: 'ghost-session', prompt: 'branch' }, ctx);

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') throw new Error('expected rejected');
      expect(decision.code).toBe('session_not_found');
      expect(decision.message).toContain('Session not found: ghost-session');
    });
  });

  describe('rejected LaunchDecision does not allocate job or session resources', () => {
    it('start() rejected decision has no job or session property', async () => {
      mockState.getNewProvider.mockReturnValue(undefined);
      const service = new ExecutionService(ctx);

      const decision = await service.start('missing', { prompt: 'test' }, ctx);

      expect(decision.status).toBe('rejected');
      expect(decision).not.toHaveProperty('job');
      expect(decision).not.toHaveProperty('session');
    });

    it('abort() reports all jobIds as notFound after a series of preflight rejections', async () => {
      mockState.getNewProvider.mockReturnValue(undefined);
      const service = new ExecutionService(ctx);

      await service.start('missing', { prompt: 'a' }, ctx);
      await service.start('missing', { prompt: 'b' }, ctx);

      const result = service.abort(['phantom-job-1', 'phantom-job-2']);
      expect(result.aborted).toEqual([]);
      expect(result.notFound).toEqual(['phantom-job-1', 'phantom-job-2']);
    });
  });

  describe('ExecutionService.waitStream() adversarial', () => {
    it('timeout event runningJobIds contains ALL still-pending jobs, not just one', async () => {
      const jobIdA = `red-ws-a-${randomUUID()}`;
      const jobIdB = `red-ws-b-${randomUUID()}`;
      createdJobIds.add(jobIdA);
      createdJobIds.add(jobIdB);

      const service = new ExecutionService(ctx);
      const { progressStore } = getInternals(service);

      vi.spyOn(progressStore, 'readStatus').mockImplementation((...args: unknown[]) => {
        const jobId = args[0] as string;
        if (jobId === jobIdA) {
          return {
            jobId: jobIdA,
            sessionId: 'session-a',
            provider: 'codex',
            projectRoot: ctx.projectRoot,
            backendNamespace: TEST_BACKEND_NAMESPACE,
            phase: 'running',
            launch: { state: 'ready', updatedAt: '' },
          };
        }
        if (jobId === jobIdB) {
          return {
            jobId: jobIdB,
            sessionId: 'session-b',
            provider: 'codex',
            projectRoot: ctx.projectRoot,
            backendNamespace: TEST_BACKEND_NAMESPACE,
            phase: 'running',
            launch: { state: 'ready', updatedAt: '' },
          };
        }
        return null;
      });
      vi.spyOn(progressStore, 'replayFrom').mockReturnValue([]);

      const events: WaitStreamEvent[] = [];
      for await (const event of service.waitStream({
        jobIds: [jobIdA, jobIdB],
        timeoutSeconds: 0.001,
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('timeout');
      if (events[0].type !== 'timeout') throw new Error('expected timeout');
      expect(events[0].runningJobIds).toContain(jobIdA);
      expect(events[0].runningJobIds).toContain(jobIdB);
      expect(events[0].runningJobIds).toHaveLength(2);
    });

    it('cursor fromEventId skips already-delivered events (only newer events returned)', async () => {
      const jobId = `red-ws-cursor-${randomUUID()}`;
      createdJobIds.add(jobId);

      const service = new ExecutionService(ctx);
      const { progressStore } = getInternals(service);

      vi.spyOn(progressStore, 'readStatus').mockImplementation((...args: unknown[]) => {
        const jid = args[0] as string;
        if (jid !== jobId) return null;
        return {
          jobId,
          sessionId: 'session-1',
          provider: 'codex',
          projectRoot: ctx.projectRoot,
          backendNamespace: TEST_BACKEND_NAMESPACE,
          phase: 'running',
          launch: { state: 'ready', updatedAt: '' },
        };
      });
      vi.spyOn(progressStore, 'replayFrom').mockImplementation((...args: unknown[]) => {
        const [jid, fromEventId] = args as [string, number];
        void jid;
        const all = [
          { jobId, sessionId: 'session-1', eventId: 1, type: 'progress' as const, ts: '', message: 'event-1' },
          { jobId, sessionId: 'session-1', eventId: 2, type: 'progress' as const, ts: '', message: 'event-2' },
          { jobId, sessionId: 'session-1', eventId: 3, type: 'terminal' as const, ts: '', result: { content: 'done' } },
        ];
        return all.filter((e) => e.eventId > fromEventId);
      });

      const events: WaitStreamEvent[] = [];
      for await (const event of service.waitStream({
        jobIds: [jobId],
        timeoutSeconds: 5,
        cursor: { jobs: { [jobId]: 2 } },
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('terminal');
      if (events[0].type !== 'terminal') throw new Error('expected terminal');
      expect(events[0].completedJobId).toBe(jobId);
      expect(events[0].resultPath).toBe(jobResultPath(jobId));

      const progressMessages = events
        .filter((e): e is Extract<WaitStreamEvent, { type: 'progress' }> => e.type === 'progress')
        .map((e) => e.message);
      expect(progressMessages).not.toContain('event-1');
      expect(progressMessages).not.toContain('event-2');
    });
  });
});
