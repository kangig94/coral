import { randomUUID } from 'node:crypto';
import type {
  JobPhase,
  LaunchDecision,
  LaunchState,
  ProviderInstruction,
  ProviderProgressEvent,
  ProviderRequest,
  TerminalResult,
  WaitRequest,
  WaitStreamEvent,
  WorkflowResultMeta,
} from '../types.js';
import { resolveCoralContent, stripAgentMetadata, parseAgentMeta } from '../coral/resolver.js';
import { getNewProvider } from '../providers/registry.js';
import { CORAL_DEFAULT_EFFORT, type EffortLevel } from '../shared/schemas.js';
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
  type QueuedHandle,
} from './engine.js';
import { AbortRegistry, type AbortResult } from './abort-registry.js';
import { buildCoralInstruction } from './instruction.js';
import { ProgressStore, createReplayCursor, jobResultPath } from './progress-store.js';
import { SessionManager } from './session-manager.js';
import type { SessionEntry } from './session-manager.js';

import type { CallerContext } from './request-context.js';
export type { CallerContext } from './request-context.js';

export interface ExecInput {
  prompt: string;
  name?: string;
  model?: string;
  cwd?: string;
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
  cwd?: string;
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

type AcceptedAdmission = Exclude<AdmissionResult, 'queue_full'>;

function rejectLaunch(code: string, message: string): LaunchDecision {
  return {
    status: 'rejected',
    phase: 'preflight',
    code,
    message,
  };
}

export function serializeWorkflowResult(details: StepDetail[]): {
  markdown: string;
  workflow: WorkflowResultMeta;
} {
  const lines: string[] = [];
  const steps: WorkflowResultMeta['steps'] = [];

  for (const detail of details) {
    lines.push(`# Step ${detail.stepIndex + 1}.${detail.atomIndex + 1}: ${detail.label}`);
    lines.push('');
    const start = lines.length + 1;
    const contentLines = detail.output.split('\n');
    lines.push(...contentLines);
    const end = lines.length;
    lines.push('');

    steps.push({
      agent: detail.label,
      step: detail.stepIndex + 1,
      atom: detail.atomIndex + 1,
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
    return error instanceof Error ? error.message : String(error);
  }
}

export class ExecutionService {
  private readonly sessionManager: SessionManager;
  private readonly abortRegistry: AbortRegistry;
  private readonly progressStore: ProgressStore;

  constructor(ctx: CallerContext, progressStore?: ProgressStore) {
    this.sessionManager = new SessionManager(ctx.projectRoot);
    this.abortRegistry = new AbortRegistry();
    this.progressStore = progressStore ?? new ProgressStore();
  }

  private claimAndAdmitJob(
    sessionId: string,
    providerName: string,
    sessionBusyMessage: string,
  ): { jobId: string; admission: AcceptedAdmission } | LaunchDecision {
    const jobId = randomUUID();

    if (!this.sessionManager.claimForJob(sessionId, jobId)) {
      return rejectLaunch('session_busy', sessionBusyMessage);
    }

    const admission = requestLaunch(jobId, providerName);
    if (admission === 'queue_full') {
      this.sessionManager.releaseJob(sessionId, jobId);
      return rejectLaunch('busy', QUEUE_FULL_MESSAGE);
    }

    return { jobId, admission };
  }

  private launchProviderJob(
    provider: Provider,
    sessionId: string,
    jobId: string,
    providerName: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    projectRoot: string,
  ): LaunchDecision {
    const initialPhase: Extract<JobPhase, 'queued' | 'launching'> = admission.type === 'queued' ? 'queued' : 'launching';
    this.abortRegistry.register(jobId);
    this.progressStore.initJob(jobId, sessionId, providerName, projectRoot, undefined, initialPhase);

    if (admission.type === 'queued') {
      this.markJobQueued(jobId, sessionId, admission.queuePosition);
      this.runAsync(provider, sessionId, jobId, request, admission);
      return { status: 'queued', job: jobId, session: sessionId };
    }

    this.runAsync(provider, sessionId, jobId, request, admission);
    return { status: 'running', job: jobId, session: sessionId };
  }

  async start(providerName: string, input: ExecInput, ctx: CallerContext): Promise<LaunchDecision> {
    const provider = getNewProvider(providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const preflightError = await runProviderPreflight(provider);
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

    const cwd = input.cwd ?? ctx.projectRoot;
    const name = input.name ?? `session-${Date.now()}`;
    const model = input.model ?? 'unknown';

    const session = this.sessionManager.allocate(providerName, name, model, cwd);
    const admitted = this.claimAndAdmitJob(session.sessionId, providerName, 'Session is already running a job');
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
    };

    return this.launchProviderJob(
      provider,
      session.sessionId,
      admitted.jobId,
      providerName,
      request,
      admitted.admission,
      ctx.projectRoot,
    );
  }

  async resume(providerName: string, input: ResumeInput, ctx: CallerContext): Promise<LaunchDecision> {
    const provider = getNewProvider(providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

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
      return rejectLaunch(
        'session_busy',
        `Session ${input.sessionId} already has an active job. Wait for it to complete or abort it first.`,
      );
    }

    const preflightError = await runProviderPreflight(provider);
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

    const admitted = this.claimAndAdmitJob(session.sessionId, providerName, 'Session is already running a job');
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
    };

    return this.launchProviderJob(
      provider,
      session.sessionId,
      admitted.jobId,
      providerName,
      request,
      admitted.admission,
      ctx.projectRoot,
    );
  }

  async fork(providerName: string, input: ForkInput, ctx: CallerContext): Promise<LaunchDecision> {
    const provider = getNewProvider(providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const sourceSession = this.sessionManager.get(providerName, input.sessionId);
    if (!sourceSession) return rejectLaunch(
      'session_not_found',
      `Session not found: ${input.sessionId}. Use exec to start a new session.`,
    );
    if (sourceSession.activeJobId) {
      return rejectLaunch(
        'session_busy',
        `Session ${input.sessionId} already has an active job. Wait for it to complete or abort it first.`,
      );
    }

    const preflightError = await runProviderPreflight(provider);
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

    const name = input.name ?? `fork-${Date.now()}`;
    const model = input.model ?? sourceSession.model;
    const cwd = input.cwd ?? sourceSession.cwd;
    const newSession = this.sessionManager.allocate(providerName, name, model, cwd);
    const admitted = this.claimAndAdmitJob(
      newSession.sessionId,
      providerName,
      'New fork session already has an active job',
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
    };

    return this.launchProviderJob(
      provider,
      newSession.sessionId,
      admitted.jobId,
      providerName,
      request,
      admitted.admission,
      ctx.projectRoot,
    );
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
    const effort = input.effort ?? CORAL_DEFAULT_EFFORT;
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
  ): Promise<LaunchDecision> {
    if (!getNewProvider(providerName)) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const session = this.sessionManager.allocate(providerName, `workflow-${Date.now()}`, 'workflow', ctx.projectRoot);
    // Workflow jobs bypass the admission queue: the workflow coordinator itself
    // does not occupy a child-process slot — only the individual atoms it launches do.
    const jobId = this.abortRegistry.register();

    if (!this.sessionManager.claimForJob(session.sessionId, jobId)) {
      return rejectLaunch('session_busy', 'Session is already running a job');
    }

    this.progressStore.initJob(jobId, session.sessionId, providerName, ctx.projectRoot, 'workflow');
    this.markJobRunning(jobId);

    this.runWorkflowAsync(session.sessionId, jobId, providerName, ast, input, ctx);
    return { status: 'running', job: jobId, session: session.sessionId };
  }

  list(providerName: string): ListResult {
    return { sessions: this.sessionManager.list(providerName) };
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
        if (status.phase === 'queued' && !emittedQueued.has(jobId)) {
          emittedQueued.add(jobId);
          yield {
            type: 'queued',
            jobId,
            sessionId,
            queuePosition: queuePosition(jobId) ?? 0,
            runningJobIds: getActiveJobIds(),
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

  private runAsync(
    provider: Provider,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
  ): void {
    const signal = this.abortRegistry.getSignal(jobId);
    if (!signal) {
      if (admission.type === 'queued') admission.cancel();
      else releaseLaunch(jobId);
      return;
    }

    const onEvent = (event: ProviderProgressEvent): void => {
      const currentStatus = this.progressStore.readStatus(jobId);
      if (
        currentStatus
        && currentStatus.phase !== 'completed'
        && currentStatus.phase !== 'error'
        && currentStatus.phase !== 'aborted'
        && currentStatus.launch.state !== 'ready'
      ) {
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

        bindLaunchPermit(jobId, signal);
        const runtime: ProviderRuntime = { signal, onEvent };
        const result = await provider.execute(request, runtime);

        const currentStatus = this.progressStore.readStatus(jobId);
        if (
          currentStatus
          && currentStatus.phase !== 'completed'
          && currentStatus.phase !== 'error'
          && currentStatus.phase !== 'aborted'
          && currentStatus.launch.state !== 'ready'
        ) {
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

        this.progressStore.appendTerminal(jobId, sessionId, terminalResult, phase);
        this.progressStore.writeResultMd(jobId, result.content);
        this.abortRegistry.remove(jobId);

        if (result.conversationRef) {
          this.sessionManager.setConversationRef(sessionId, result.conversationRef);
        } else if (result.nonResumable) {
          this.sessionManager.setNonResumable(sessionId);
        }
        this.sessionManager.releaseJob(sessionId, jobId);
      } catch (err: unknown) {
        const currentStatus = this.progressStore.readStatus(jobId);
        if (!currentStatus || currentStatus.phase === 'completed' || currentStatus.phase === 'error' || currentStatus.phase === 'aborted') {
          return;
        }

        if (err instanceof CliBusyError) {
          this.failJob(jobId, sessionId, 'busy', err.message);
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        this.failJob(jobId, sessionId, 'error', message);
      } finally {
        if (permitAcquired) releaseLaunch(jobId);
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
    this.progressStore.appendTerminal(jobId, sessionId, { content: '', aborted: true, notice: message }, 'aborted');
    this.abortRegistry.remove(jobId);
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
    this.progressStore.appendTerminal(jobId, sessionId, { content: '', notice: message }, 'error');
    this.abortRegistry.remove(jobId);
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
    this.progressStore.appendTerminal(jobId, sessionId, result, phase);
    this.sessionManager.setNonResumable(sessionId);
    this.abortRegistry.remove(jobId);
    this.sessionManager.releaseJob(sessionId, jobId);
  }

  private finishWorkflowWithEmptyArtifact(
    sessionId: string,
    jobId: string,
    message: string,
    aborted: boolean,
  ): void {
    const phase: Extract<JobPhase, 'error' | 'aborted'> = aborted ? 'aborted' : 'error';
    const result: TerminalResult = aborted
      ? { content: '', aborted: true, notice: message, workflow: { steps: [] } }
      : { content: '', notice: message, workflow: { steps: [] } };
    this.finishWorkflowJob(sessionId, jobId, phase, result, '');
  }

  private runWorkflowAsync(
    sessionId: string,
    jobId: string,
    providerName: string,
    ast: PipelineAST,
    input: WorkflowInput,
    ctx: CallerContext,
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
          this.finishWorkflowWithEmptyArtifact(sessionId, jobId, message, aborted);
        }
      });
  }
}
