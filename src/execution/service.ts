import { randomUUID } from 'node:crypto';
import { pluginRootNamespace } from '../infra/paths.js';
import {
  isTerminalPhase,
  type JobKind,
  type JobPhase,
  type LaunchDecision,
  type LaunchState,
  type PersistedStatusRecord,
  type ProviderInstruction,
  type ProviderProgressEvent,
  type ProviderRequest,
  type TerminalResult,
  type WaitRequest,
  type WaitStreamEvent,
  type WorkflowResultMeta,
} from '../shared/types.js';
import { resolveCoralContent, stripAgentMetadata, parseAgentMeta } from './resolver.js';
import { getNewProvider } from '../providers/registry.js';
import { errorMessage } from '../shared/mcp-utils.js';
import type { EffortLevel } from '../shared/schemas.js';
import type { Provider, ProviderRuntime } from '../providers/types.js';
import {
  executePipeline,
  type PipelineResult,
  type StepDetail,
  WorkflowExecutionError,
} from '../workflow/pipe-executor.js';
import type { WorkflowInput } from '../workflow/schemas.js';
import type { PipelineAST } from '../workflow/types.js';
import {
  bindLaunchPermit,
  cancelQueued,
  CliBusyError,
  getActiveJobIds,
  queuePosition,
  requestLaunch,
  releaseLaunch,
  type AdmissionResult,
  type LaunchPool,
  type QueuedHandle,
} from './engine.js';
import { AbortRegistry, type AbortResult } from './abort-registry.js';
import { buildCoralInstruction } from './instruction.js';
import { ProgressStore, createReplayCursor, jobResultPath } from './progress-store.js';
import { SessionManager } from './session-manager.js';
import type { SessionEntry } from './session-manager.js';

import type { CallerContext } from './request-context.js';
export type { CallerContext } from './request-context.js';

declare const __PLUGIN_ROOT__: string;

export interface ExecInput {
  prompt: string;
  name?: string;
  model?: string;
  pool?: LaunchPool;
  cwd?: string;
  /** Set only by coralDispatch (agent metadata). MCP input never populates this. */
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
}

export interface ResumeInput {
  sessionId: string;
  prompt: string;
  name?: string;
  model?: string;
  pool?: LaunchPool;
  cwd?: string;
  /** Set only by coralDispatch (agent metadata). MCP input never populates this. */
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
}

export interface ForkInput {
  sessionId: string;
  name?: string;
  prompt?: string;
  model?: string;
  cwd?: string;
  /** Set only by coralDispatch (agent metadata). MCP input never populates this. */
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
}

export interface CoralInput {
  prompt: string;
  sessionId?: string;
  cwd?: string;
  effort?: EffortLevel;
}

export interface ListResult {
  sessions: SessionEntry[];
}

const QUEUE_FULL_MESSAGE = 'All slots and queue are full. Try again later.';
const QUEUED_ABORT_MESSAGE = 'Aborted while queued.';
const defaultPluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : process.cwd();

type AcceptedAdmission = Exclude<AdmissionResult, 'queue_full'>;
type ClaimJobOptions = {
  expectedVersion?: number;
  initialPhase?: Extract<JobPhase, 'queued' | 'launching'>;
  jobKind?: JobKind;
};

function canAdvanceLaunchState(status: PersistedStatusRecord | null): status is PersistedStatusRecord {
  return status !== null && !isTerminalPhase(status.phase) && status.launch.state !== 'ready';
}

function rejectLaunch(code: string, message: string): LaunchDecision {
  return {
    status: 'rejected',
    phase: 'preflight',
    code,
    message,
  };
}

function resolveBackendNamespace(pluginRoot: string): string {
  try {
    return pluginRootNamespace(pluginRoot);
  } catch {
    return pluginRootNamespace(defaultPluginRoot);
  }
}

export function serializeWorkflowResult(details: StepDetail[]): {
  markdown: string;
  workflow: WorkflowResultMeta;
} {
  const lines: string[] = [];
  const steps: WorkflowResultMeta['steps'] = [];

  for (const detail of details) {
    lines.push(`# Step ${detail.stepIndex}.${detail.atomIndex}: ${detail.label}`);
    lines.push('');
    const start = lines.length + 1;
    const contentLines = detail.output.split('\n');
    lines.push(...contentLines);
    const end = lines.length;
    lines.push('');

    steps.push({
      agent: detail.label,
      step: detail.stepIndex,
      atom: detail.atomIndex,
      provider: detail.provider,
      start,
      end,
    });
  }

  return {
    markdown: lines.join('\n'),
    workflow: { steps },
  };
}

async function runProviderPreflight(provider: Provider): Promise<string | null> {
  if (!provider.preflight) return null;
  try {
    await provider.preflight();
    return null;
  } catch (error: unknown) {
    return errorMessage(error);
  }
}

class SessionClaimError extends Error {
  constructor() {
    super('Session claim failed');
    this.name = 'SessionClaimError';
  }
}

export class ExecutionService {
  private readonly sessionManager: SessionManager;
  private readonly abortRegistry: AbortRegistry;
  private readonly backendNamespace: string;
  private readonly bundleHash: string;
  private readonly progressStore: ProgressStore;
  private readonly jobPools = new Map<string, LaunchPool>();

  constructor(ctx: CallerContext, progressStore?: ProgressStore, bundleHash?: string) {
    this.sessionManager = new SessionManager(ctx.projectRoot);
    this.abortRegistry = new AbortRegistry();
    this.backendNamespace = resolveBackendNamespace(ctx.pluginRoot);
    this.bundleHash = bundleHash ?? 'unknown';
    this.progressStore = progressStore ?? new ProgressStore();
  }

  private async claimJobAtomic(
    session: SessionEntry,
    jobId: string,
    providerName: string,
    projectRoot: string,
    options: ClaimJobOptions = {},
  ): Promise<SessionEntry> {
    this.progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: providerName,
      projectRoot,
      backendNamespace: this.backendNamespace,
      bundleHash: this.bundleHash,
      jobKind: options.jobKind,
      initialPhase: options.initialPhase ?? 'launching',
    });

    try {
      const claimed = await this.sessionManager.claimForJobAtomic(
        session.sessionId,
        jobId,
        options.expectedVersion ?? session.version,
      );
      if (!claimed) {
        throw new SessionClaimError();
      }
      return session;
    } catch (error: unknown) {
      this.progressStore.rollbackJob(jobId);
      throw error;
    }
  }

  private async claimAndAdmitJob(
    session: SessionEntry,
    providerName: string,
    projectRoot: string,
    sessionBusyMessage: string,
    expectedVersion: number = session.version,
    pool: LaunchPool = 'default',
  ): Promise<{ jobId: string; admission: AcceptedAdmission } | LaunchDecision> {
    const jobId = randomUUID();
    this.jobPools.set(jobId, pool);
    const admission = requestLaunch(jobId, providerName, pool);
    if (admission === 'queue_full') {
      this.jobPools.delete(jobId);
      return rejectLaunch('busy', QUEUE_FULL_MESSAGE);
    }

    const initialPhase: Extract<JobPhase, 'queued' | 'launching'> = admission.type === 'queued' ? 'queued' : 'launching';

    try {
      await this.claimJobAtomic(session, jobId, providerName, projectRoot, { expectedVersion, initialPhase });
    } catch (error: unknown) {
      if (admission.type === 'queued') {
        const waitForPermit = admission.waitForPermit();
        admission.cancel();
        void waitForPermit.catch(() => {});
      } else {
        releaseLaunch(jobId, pool);
      }
      this.jobPools.delete(jobId);

      if (error instanceof SessionClaimError) {
        return rejectLaunch('session_busy', sessionBusyMessage);
      }
      throw error;
    }

    return { jobId, admission };
  }

  private launchProviderJob(
    provider: Provider,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    pool: LaunchPool = 'default',
  ): LaunchDecision {
    this.abortRegistry.register(jobId);

    const decisionStatus = admission.type === 'queued' ? 'queued' : 'running';
    if (admission.type === 'queued') {
      this.markJobQueued(jobId, sessionId, admission.queuePosition);
    }

    this.runAsync(provider, sessionId, jobId, request, admission, pool);
    return { status: decisionStatus, job: jobId, session: sessionId };
  }

  async start(providerName: string, input: ExecInput, ctx: CallerContext): Promise<LaunchDecision> {
    const provider = getNewProvider(providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const preflightError = await runProviderPreflight(provider);
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

    const cwd = input.cwd ?? ctx.projectRoot;
    const name = input.name ?? `session-${Date.now()}`;
    const model = input.model ?? 'unknown';
    const pool = input.pool ?? 'default';

    const session = this.sessionManager.allocate(providerName, name, model, cwd, ctx.projectRoot);
    const admitted = await this.claimAndAdmitJob(
      session,
      providerName,
      ctx.projectRoot,
      'Session is already running a job',
      session.version,
      pool,
    );
    if ('status' in admitted) return admitted;

    const request: ProviderRequest = {
      action: 'exec',
      sessionId: session.sessionId,
      name: input.name,
      prompt: input.prompt,
      model: input.model,
      cwd,
      effort: input.effort,
      bypassPermissions: input.bypassPermissions ?? false,
      systemPrompt: input.systemPrompt,
      instruction: input.instruction,
      coralEnv: ctx.coralEnv,
    };

    return this.launchProviderJob(
      provider,
      session.sessionId,
      admitted.jobId,
      request,
      admitted.admission,
      pool,
    );
  }

  async resume(providerName: string, input: ResumeInput, ctx: CallerContext): Promise<LaunchDecision> {
    const provider = getNewProvider(providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const busyMessage = `Session ${input.sessionId} already has an active job. Wait for it to complete or abort it first.`;
    const session = this.sessionManager.get(providerName, input.sessionId);
    if (!session) return rejectLaunch(
      'session_not_found',
      `Session not found: ${input.sessionId}. Use exec to start a new session.`,
    );
    if (session.state === 'non_resumable') {
      return rejectLaunch(
        'non_resumable',
        `Session ${input.sessionId} is non-resumable. Use exec to start a new session or fork to branch from it.`,
      );
    }
    if (session.activeJobId) {
      return rejectLaunch('session_busy', busyMessage);
    }
    const expectedVersion = session.version;
    const pool = input.pool ?? 'default';

    const preflightError = await runProviderPreflight(provider);
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

    const admitted = await this.claimAndAdmitJob(
      session,
      providerName,
      ctx.projectRoot,
      busyMessage,
      expectedVersion,
      pool,
    );
    if ('status' in admitted) return admitted;

    const request: ProviderRequest = {
      action: 'resume',
      sessionId: session.sessionId,
      prompt: input.prompt,
      conversationRef: session.conversationRef,
      model: input.model,
      cwd: input.cwd ?? session.cwd,
      effort: input.effort,
      bypassPermissions: input.bypassPermissions ?? false,
      systemPrompt: input.systemPrompt,
      instruction: input.instruction,
      coralEnv: ctx.coralEnv,
    };

    return this.launchProviderJob(
      provider,
      session.sessionId,
      admitted.jobId,
      request,
      admitted.admission,
      pool,
    );
  }

  async fork(providerName: string, input: ForkInput, ctx: CallerContext): Promise<LaunchDecision> {
    const provider = getNewProvider(providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const sourceBusyMessage = `Session ${input.sessionId} already has an active job. Wait for it to complete or abort it first.`;
    const sourceSession = this.sessionManager.get(providerName, input.sessionId);
    if (!sourceSession) return rejectLaunch(
      'session_not_found',
      `Session not found: ${input.sessionId}. Use exec to start a new session.`,
    );
    if (sourceSession.activeJobId) {
      return rejectLaunch('session_busy', sourceBusyMessage);
    }
    const sourceExpectedVersion = sourceSession.version;

    const preflightError = await runProviderPreflight(provider);
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

    const sourceClaimId = randomUUID();
    const sourceClaimed = await this.sessionManager.claimForJobAtomic(
      sourceSession.sessionId,
      sourceClaimId,
      sourceExpectedVersion,
    );
    if (!sourceClaimed) {
      return rejectLaunch('session_busy', sourceBusyMessage);
    }

    try {
      const name = input.name ?? `fork-${Date.now()}`;
      const model = input.model ?? sourceSession.model;
      const cwd = input.cwd ?? sourceSession.cwd;
      const newSession = this.sessionManager.allocate(providerName, name, model, cwd, ctx.projectRoot);
      const admitted = await this.claimAndAdmitJob(
        newSession,
        providerName,
        ctx.projectRoot,
        'New fork session already has an active job',
        newSession.version,
      );
      if ('status' in admitted) return admitted;

      const request: ProviderRequest = {
        action: 'fork',
        sessionId: newSession.sessionId,
        name: input.name,
        prompt: input.prompt ?? '',
        conversationRef: sourceSession.conversationRef,
        model: input.model,
        cwd,
        effort: input.effort,
        bypassPermissions: input.bypassPermissions ?? false,
        systemPrompt: input.systemPrompt,
        instruction: input.instruction,
        coralEnv: ctx.coralEnv,
      };

      return this.launchProviderJob(
        provider,
        newSession.sessionId,
        admitted.jobId,
        request,
        admitted.admission,
      );
    } finally {
      this.sessionManager.releaseJob(sourceSession.sessionId, sourceClaimId);
    }
  }

  async coralDispatch(
    providerName: string,
    coralName: string,
    input: CoralInput,
    ctx: CallerContext,
  ): Promise<LaunchDecision> {
    const { content } = resolveCoralContent(coralName);
    const meta = parseAgentMeta(content);
    const stripped = stripAgentMetadata(content);
    const instruction = buildCoralInstruction(stripped);

    const model = meta.model;
    const effort = input.effort;
    const cwd = input.cwd ?? ctx.projectRoot;

    if (input.sessionId) {
      return this.resume(
        providerName,
        {
          sessionId: input.sessionId,
          prompt: input.prompt,
          name: coralName,
          model,
          cwd,
          effort,
          bypassPermissions: true,
          instruction,
        },
        ctx,
      );
    }

    return this.start(
      providerName,
      {
        prompt: input.prompt,
        name: `${coralName}-${Date.now()}`,
        model,
        cwd,
        effort,
        bypassPermissions: true,
        instruction,
      },
      ctx,
    );
  }

  async executeWorkflow(
    providerName: string,
    ast: PipelineAST,
    input: WorkflowInput,
    ctx: CallerContext,
    workDir?: string,
  ): Promise<LaunchDecision> {
    if (!getNewProvider(providerName)) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const session = this.sessionManager.allocate(providerName, `workflow-${Date.now()}`, 'workflow', ctx.projectRoot, ctx.projectRoot);
    // Workflow jobs bypass the admission queue: the workflow coordinator itself
    // does not occupy a child-process slot — only the individual atoms it launches do.
    const jobId = this.abortRegistry.register();

    try {
      await this.claimJobAtomic(session, jobId, providerName, ctx.projectRoot, {
        expectedVersion: session.version,
        jobKind: 'workflow',
      });
    } catch (error: unknown) {
      this.abortRegistry.remove(jobId);
      if (error instanceof SessionClaimError) {
        return rejectLaunch('session_busy', 'Session is already running a job');
      }
      throw error;
    }

    this.markJobRunning(jobId);

    this.runWorkflowAsync(session.sessionId, jobId, providerName, ast, input, ctx, workDir);
    return { status: 'running', job: jobId, session: session.sessionId };
  }

  list(providerName: string): ListResult {
    return { sessions: this.sessionManager.list(providerName) };
  }

  getConversationRef(providerName: string, sessionId: string): string | undefined {
    return this.sessionManager.get(providerName, sessionId)?.conversationRef;
  }

  abort(jobIds: string[]): AbortResult {
    const aborted: string[] = [];
    const notFound: string[] = [];

    for (const jobId of jobIds) {
      if (!this.abortRegistry.has(jobId)) {
        notFound.push(jobId);
        continue;
      }

      const status = this.progressStore.readStatus(jobId);
      if (status?.phase === 'queued' && cancelQueued(jobId)) {
        this.finishQueuedAbort(jobId, status.sessionId, QUEUED_ABORT_MESSAGE);
        aborted.push(jobId);
        continue;
      }

      this.abortRegistry.abort([jobId]);
      aborted.push(jobId);
    }

    return { aborted, notFound };
  }

  /**
   * Poll until launch state is non-pending. Returns 'pending' if timeout expires.
   * Returns 'queued' immediately for queued jobs — callers must NOT treat this as an error.
   * Use waitStream() to monitor actual completion after a 'queued' return.
   */
  async awaitLaunch(jobId: string, timeoutMs: number): Promise<LaunchState> {
    const start = Date.now();
    while (true) {
      const seq = this.progressStore.getChangeSeq();
      const status = this.progressStore.readStatus(jobId);
      if (status && status.launch.state !== 'pending') return status.launch.state;

      const remainingMs = timeoutMs - (Date.now() - start);
      if (remainingMs <= 0) return 'pending';
      await Promise.race([
        this.progressStore.waitForChange(seq),
        new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
      ]);
    }
  }

  /** Async generator yielding queued/progress/terminal/timeout events for monitored jobs. */
  async *waitStream(req: WaitRequest): AsyncGenerator<WaitStreamEvent> {
    const { jobIds, timeoutSeconds = 600, cursor } = req;
    const startMs = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    const fromEventIds: Record<string, number> = cursor?.jobs ? { ...cursor.jobs } : {};
    const fileCursors = new Map(jobIds.map((id) => [id, createReplayCursor()]));
    const emittedQueued = new Set<string>();
    const pending = new Set(jobIds);

    while (pending.size > 0) {
      if (Date.now() - startMs >= timeoutMs) {
        yield { type: 'timeout', runningJobIds: [...pending] };
        return;
      }

      const seq = this.progressStore.getChangeSeq();

      for (const jobId of [...pending]) {
        const fileCursor = fileCursors.get(jobId)!;
        const fromEventId = fromEventIds[jobId] ?? 0;
        const status = this.progressStore.readStatus(jobId);
        if (!status) continue;

        const sessionId = status.sessionId;
        const pool = this.jobPools.get(jobId) ?? 'default';
        if (status.phase === 'queued' && !emittedQueued.has(jobId)) {
          emittedQueued.add(jobId);
          yield {
            type: 'queued',
            jobId,
            sessionId,
            queuePosition: queuePosition(jobId, pool) ?? 0,
            runningJobIds: getActiveJobIds(pool),
          };
        }
        const events = this.progressStore.replayFrom(jobId, fromEventId, fileCursor);

        for (const event of events) {
          fromEventIds[jobId] = event.eventId;

          if (event.type === 'progress') {
            yield {
              type: 'progress',
              jobId,
              sessionId,
              eventId: event.eventId,
              message: event.message ?? '',
            };
          } else if (event.type === 'terminal') {
            const remainingJobIds = jobIds.filter((id) => id !== jobId && pending.has(id));
            yield {
              type: 'terminal',
              completedJobId: jobId,
              sessionId,
              remainingJobIds,
              resultPath: jobResultPath(jobId),
              result: event.result ?? { content: '' },
            };
            pending.delete(jobId);
            break;
          }
        }

        const currentStatus = this.progressStore.readStatus(jobId);
        if (
          pending.has(jobId)
          && currentStatus
          && isTerminalPhase(currentStatus.phase)
        ) {
          const remainingJobIds = jobIds.filter((id) => id !== jobId && pending.has(id));
          yield {
            type: 'terminal',
            completedJobId: jobId,
            sessionId: currentStatus.sessionId,
            remainingJobIds,
            resultPath: jobResultPath(jobId),
            result: currentStatus.result ?? { content: '' },
          };
          pending.delete(jobId);
        }
      }

      if (pending.size > 0) {
        const remainingMs = timeoutMs - (Date.now() - startMs);
        if (remainingMs <= 0) continue;
        await Promise.race([
          this.progressStore.waitForChange(seq),
          new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
        ]);
      }
    }
  }

  async waitStreamOnce(jobId: string, timeoutMs?: number): Promise<{ content: string; nonResumable: boolean }> {
    const request: WaitRequest = { jobIds: [jobId] };
    if (timeoutMs !== undefined) {
      request.timeoutSeconds = timeoutMs / 1000;
    }

    for await (const event of this.waitStream(request)) {
      if (event.type === 'terminal' && event.completedJobId === jobId) {
        return {
          content: event.result.content,
          nonResumable: event.result.nonResumable ?? false,
        };
      }
      if (event.type === 'timeout') {
        throw new Error('Job timed out waiting for terminal result');
      }
    }

    throw new Error(`Job ${jobId} ended without a terminal result`);
  }

  private runAsync(
    provider: Provider,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    pool: LaunchPool,
  ): void {
    const signal = this.abortRegistry.getSignal(jobId);
    if (!signal) {
      if (admission.type === 'queued') admission.cancel();
      else releaseLaunch(jobId, pool);
      return;
    }

    const onEvent = (event: ProviderProgressEvent): void => {
      const currentStatus = this.progressStore.readStatus(jobId);
      if (canAdvanceLaunchState(currentStatus)) {
        this.markJobRunning(jobId);
      }
      this.progressStore.appendProgress(jobId, sessionId, event.message);
    };

    void (async () => {
      let permitAcquired = admission.type === 'immediate';

      try {
        if (admission.type === 'queued') {
          const queueOutcome = await this.waitForQueuedPermit(admission, signal);
          if (queueOutcome === 'aborted') {
            this.finishQueuedAbort(jobId, sessionId, QUEUED_ABORT_MESSAGE);
            return;
          }

          permitAcquired = true;
          this.markJobLaunching(jobId);
          this.progressStore.appendProgress(jobId, sessionId, 'dequeued, launching');
        }

        bindLaunchPermit(jobId, signal, pool);
        const runtime: ProviderRuntime = { signal, onEvent };
        const result = await provider.execute(request, runtime);

        if (canAdvanceLaunchState(this.progressStore.readStatus(jobId))) {
          this.markJobReady(jobId);
        }

        const phase: JobPhase = result.aborted ? 'aborted' : 'completed';
        const terminalResult: TerminalResult = {
          content: result.content,
          durationMs: result.durationMs,
          aborted: result.aborted,
          nonResumable: result.nonResumable,
          exitCode: result.exitCode,
          notice: result.notice,
          errors: result.errors,
          warnings: result.warnings,
          usage: result.usage,
        };

        this.writeTerminalResult(jobId, sessionId, terminalResult, phase);
        this.progressStore.writeResultMd(jobId, result.content);
        this.abortRegistry.remove(jobId);
        this.jobPools.delete(jobId);

        if (result.conversationRef) {
          this.sessionManager.setConversationRef(sessionId, result.conversationRef);
        } else if (result.nonResumable) {
          this.sessionManager.setNonResumable(sessionId);
        }
        this.sessionManager.releaseJob(sessionId, jobId);
      } catch (err: unknown) {
        const currentStatus = this.progressStore.readStatus(jobId);
        if (!currentStatus || isTerminalPhase(currentStatus.phase)) {
          return;
        }

        if (err instanceof CliBusyError) {
          this.failJob(jobId, sessionId, 'busy', err.message);
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        this.failJob(jobId, sessionId, 'error', message);
      } finally {
        if (permitAcquired) releaseLaunch(jobId, pool);
      }
    })();
  }

  private markJobQueued(jobId: string, sessionId: string, queuePosition: number): void {
    this.progressStore.updateLaunchState(jobId, 'queued');
    this.progressStore.appendProgress(jobId, sessionId, `queued (position ${queuePosition})`);
  }

  private markJobLaunching(jobId: string): void {
    this.progressStore.updatePhase(jobId, 'launching');
  }

  private async waitForQueuedPermit(
    admission: QueuedHandle,
    signal: AbortSignal,
  ): Promise<'granted' | 'aborted'> {
    return new Promise<'granted' | 'aborted'>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        admission.cancel();
        cleanup();
        resolve('aborted');
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
      admission.waitForPermit()
        .then(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve('granted');
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
    });
  }

  private finishQueuedAbort(jobId: string, sessionId: string, message: string): void {
    this.progressStore.updateLaunchState(jobId, 'error', message);
    this.writeTerminalResult(jobId, sessionId, { content: '', aborted: true, notice: message }, 'aborted');
    this.abortRegistry.remove(jobId);
    this.jobPools.delete(jobId);
    this.sessionManager.releaseJob(sessionId, jobId);
  }

  private markJobReady(jobId: string): void {
    this.progressStore.updateLaunchState(jobId, 'ready');
  }

  private markJobRunning(jobId: string): void {
    this.markJobReady(jobId);
    this.progressStore.updatePhase(jobId, 'running');
  }

  private failJob(jobId: string, sessionId: string, launchState: LaunchState, message: string): void {
    this.progressStore.updateLaunchState(jobId, launchState, message);
    this.writeTerminalResult(jobId, sessionId, { content: '', notice: message }, 'error');
    this.abortRegistry.remove(jobId);
    this.jobPools.delete(jobId);
    this.sessionManager.releaseJob(sessionId, jobId);
  }

  private finishWorkflowJob(
    sessionId: string,
    jobId: string,
    phase: Extract<JobPhase, 'completed' | 'error' | 'aborted'>,
    result: TerminalResult,
    markdown: string,
  ): void {
    this.progressStore.writeWorkflowResultMdOrThrow(jobId, markdown);
    this.writeTerminalResult(jobId, sessionId, result, phase);
    this.sessionManager.setNonResumable(sessionId);
    this.abortRegistry.remove(jobId);
    this.sessionManager.releaseJob(sessionId, jobId);
  }

  private writeTerminalResult(jobId: string, sessionId: string, result: TerminalResult, phase: JobPhase): void {
    try {
      this.progressStore.appendTerminal(jobId, sessionId, result, phase);
    } catch {
      this.progressStore.markTerminalStatus(jobId, result, phase);
    }
  }

  private runWorkflowAsync(
    sessionId: string,
    jobId: string,
    providerName: string,
    ast: PipelineAST,
    input: WorkflowInput,
    ctx: CallerContext,
    workDir?: string,
  ): void {
    const signal = this.abortRegistry.getSignal(jobId);
    if (!signal) return;

    void executePipeline(
      ast,
      input.init_prompt,
      providerName,
      this,
      ctx,
      {
        atoms: input.atoms,
        context: input.context,
        workDir,
        signal,
        staleTimeoutMs: input.stale_timeout_seconds * 1000,
        onProgress: (message) => {
          this.progressStore.appendProgress(jobId, sessionId, message);
        },
      },
    )
      .then((result: PipelineResult) => {
        const serialized = serializeWorkflowResult(result.stepDetails);
        this.finishWorkflowJob(
          sessionId,
          jobId,
          'completed',
          {
            content: result.finalOutput,
            workflow: serialized.workflow,
          },
          serialized.markdown,
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const aborted = err instanceof WorkflowExecutionError ? err.aborted : signal.aborted;
        const phase: Extract<JobPhase, 'error' | 'aborted'> = aborted ? 'aborted' : 'error';
        const stepDetails = err instanceof WorkflowExecutionError ? err.stepDetails : [];

        try {
          const serialized = serializeWorkflowResult(stepDetails);
          const terminalResult: TerminalResult = aborted
            ? {
              content: '',
              aborted: true,
              notice: message,
              workflow: serialized.workflow,
            }
            : {
              content: '',
              notice: message,
              workflow: serialized.workflow,
            };
          this.finishWorkflowJob(sessionId, jobId, phase, terminalResult, serialized.markdown);
        } catch {
          const emptyResult: TerminalResult = aborted
            ? { content: '', aborted: true, notice: message, workflow: { steps: [] } }
            : { content: '', notice: message, workflow: { steps: [] } };
          this.finishWorkflowJob(sessionId, jobId, phase, emptyResult, '');
        }
      });
  }
}
