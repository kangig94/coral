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
import { CORAL_DEFAULT_EFFORT } from '../../shared/schemas.js';
import type { Provider } from '../../providers/types.js';
import { parseExpression } from '../../workflow/pipe-parser.js';
import {
  MAX_ACTIVE_CHILDREN,
  cancelQueued,
  killAllChildren,
  releaseLaunch,
} from '../engine.js';
import { JOBS_DIR, jobResultPath, type ProgressStore } from '../progress-store.js';
import { SessionManager } from '../session-manager.js';
import { ExecutionService, type CallerContext } from '../service.js';
import type { JobManager } from '../job-manager.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  getNewProvider: vi.fn(),
  resolveCoralContent: vi.fn(),
}));

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
  jobManager: JobManager;
  progressStore: ProgressStore;
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
    capabilities: { resumable: true, forkable: true },
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
    Array.from({ length: MAX_ACTIVE_CHILDREN }, (_value, index) =>
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
    ctx = { projectRoot, pluginRoot: join(projectRoot, 'plugin') };
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
    mgr.claimForJob(entry.sessionId, 'job-1');
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
    const { jobManager } = getInternals(service);

    expect(result).toEqual({
      aborted: [first.job],
      notFound: ['missing-job'],
    });
    expect(jobManager.get(first.job)?.controller.signal.aborted).toBe(true);
    expect(jobManager.get(second.job)?.controller.signal.aborted).toBe(false);
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
    const { jobManager, progressStore } = getInternals(service);

    expect(abortResult).toEqual({
      aborted: [decision.job],
      notFound: [],
    });
    expect(jobManager.get(decision.job)).toBeNull();
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
    const { jobManager } = getInternals(service);
    const jobId = jobManager.allocate('session-1', 'codex');

    setTimeout(() => {
      jobManager.setLaunchState(jobId, 'ready');
    }, 10);

    await expect(service.awaitLaunch(jobId, 1000)).resolves.toBe('ready');
    jobManager.remove(jobId);
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
      effort: CORAL_DEFAULT_EFFORT,
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
        prompt: 'seed',
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
      '# Step 1.1: architect',
      '',
      'ARCH',
      '',
      '# Step 2.1: resolver',
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
            step: 1,
            atom: 1,
            kind: 'agent',
            provider: 'codex',
            tagName: 'architect',
            headingLine: 1,
            line: 3,
            endLine: 3,
          },
          {
            agent: 'resolver',
            step: 2,
            atom: 1,
            kind: 'agent',
            provider: 'codex',
            tagName: 'resolver',
            headingLine: 5,
            line: 7,
            endLine: 7,
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
        prompt: 'seed',
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

    expect(markdownAtTerminal).toBe('# Step 1.1: architect\n\nARCH\n');
    expect(terminal.result).toEqual({
      content: '',
      notice: "Step 2, atom 'resolver' failed: resolver failed",
      workflow: {
        steps: [
          {
            agent: 'architect',
            step: 1,
            atom: 1,
            kind: 'agent',
            provider: 'codex',
            tagName: 'architect',
            headingLine: 1,
            line: 3,
            endLine: 3,
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
        prompt: 'seed',
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

    expect(markdownAtTerminal).toBe('# Step 1.1: architect\n\nARCH\n');
    expect(terminal.result).toEqual({
      content: '',
      aborted: true,
      notice: "Step 2, atom 'resolver' failed: aborted",
      workflow: {
        steps: [
          {
            agent: 'architect',
            step: 1,
            atom: 1,
            kind: 'agent',
            provider: 'codex',
            tagName: 'architect',
            headingLine: 1,
            line: 3,
            endLine: 3,
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
});

describe('ExecutionService adversarial', () => {
  let ctx: CallerContext;

  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'red-exec-home-'));
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    ctx = { projectRoot, pluginRoot: join(projectRoot, 'plugin') };
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
          return { jobId: jobIdA, sessionId: 'session-a', provider: 'codex', phase: 'running', launch: { state: 'ready', updatedAt: '' } };
        }
        if (jobId === jobIdB) {
          return { jobId: jobIdB, sessionId: 'session-b', provider: 'codex', phase: 'running', launch: { state: 'ready', updatedAt: '' } };
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
        return { jobId, sessionId: 'session-1', provider: 'codex', phase: 'running', launch: { state: 'ready', updatedAt: '' } };
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
