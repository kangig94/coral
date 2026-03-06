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
} from '../types.js';
import { resolveCoralContent, stripAgentMetadata } from '../coral/resolver.js';
import { getNewProvider } from '../providers/registry.js';
import { CORAL_DEFAULT_EFFORT } from '../shared/schemas.js';
import type { Provider, ProviderRuntime } from '../providers/types.js';
import { executePipeline } from '../workflow/pipe-executor.js';
import type { WorkflowInput } from '../workflow/schemas.js';
import type { PipelineAST } from '../workflow/types.js';
import { CliBusyError } from './engine.js';
import { buildCoralInstruction } from './instruction.js';
import { JobManager } from './job-manager.js';
import type { AbortResult } from './job-manager.js';
import { ProgressStore, createReplayCursor } from './progress-store.js';
import { SessionManager } from './session-manager.js';
import type { SessionEntry } from './session-manager.js';

export interface CallerContext {
  projectRoot: string;
  pluginRoot: string; // used by resolveCoralContent (module-level var set by esbuild)
}

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
  name?: string;
  model?: string;
  cwd?: string;
  effort?: string;
}

export interface ListResult {
  sessions: SessionEntry[];
}

const POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rejectLaunch(code: string, message: string): LaunchDecision {
  return {
    status: 'rejected',
    phase: 'preflight',
    code,
    message,
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
  private readonly jobManager: JobManager;
  private readonly progressStore: ProgressStore;

  constructor(ctx: CallerContext) {
    this.sessionManager = new SessionManager(ctx.projectRoot);
    this.jobManager = new JobManager();
    this.progressStore = new ProgressStore();
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
    const jobId = this.jobManager.allocate(session.sessionId, providerName);

    if (!this.sessionManager.claimForJob(session.sessionId, jobId)) {
      return rejectLaunch('session_busy', 'Session is already running a job');
    }

    this.progressStore.initJob(jobId, session.sessionId, providerName);

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

    this.runAsync(provider, session.sessionId, jobId, request);
    return { status: 'running', job: jobId, session: session.sessionId };
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

    const jobId = this.jobManager.allocate(session.sessionId, providerName);

    if (!this.sessionManager.claimForJob(session.sessionId, jobId)) {
      return rejectLaunch('session_busy', 'Session is already running a job');
    }

    this.progressStore.initJob(jobId, session.sessionId, providerName);

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

    this.runAsync(provider, session.sessionId, jobId, request);
    return { status: 'running', job: jobId, session: session.sessionId };
  }

  async fork(providerName: string, input: ForkInput, _ctx: CallerContext): Promise<LaunchDecision> {
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
    const jobId = this.jobManager.allocate(newSession.sessionId, providerName);

    if (!this.sessionManager.claimForJob(newSession.sessionId, jobId)) {
      return rejectLaunch('session_busy', 'New fork session already has an active job');
    }

    this.progressStore.initJob(jobId, newSession.sessionId, providerName);

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

    this.runAsync(provider, newSession.sessionId, jobId, request);
    return { status: 'running', job: jobId, session: newSession.sessionId };
  }

  async coralDispatch(
    providerName: string,
    coralName: string,
    input: CoralInput,
    ctx: CallerContext,
  ): Promise<LaunchDecision> {
    const { content } = resolveCoralContent(coralName);
    const stripped = stripAgentMetadata(content);
    const instruction = buildCoralInstruction(stripped);

    const effort = input.effort ?? CORAL_DEFAULT_EFFORT;
    const cwd = input.cwd ?? ctx.projectRoot;

    if (input.sessionId) {
      return this.resume(
        providerName,
        {
          sessionId: input.sessionId,
          prompt: input.prompt,
          name: input.name,
          model: input.model,
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
        name: input.name ?? `${coralName}-${Date.now()}`,
        model: input.model,
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
    const jobId = this.jobManager.allocate(session.sessionId, providerName);

    if (!this.sessionManager.claimForJob(session.sessionId, jobId)) {
      return rejectLaunch('session_busy', 'Session is already running a job');
    }

    this.progressStore.initJob(jobId, session.sessionId, providerName);
    this.markJobRunning(jobId);

    this.runWorkflowAsync(session.sessionId, jobId, providerName, ast, input, ctx);
    return { status: 'running', job: jobId, session: session.sessionId };
  }

  list(providerName: string): ListResult {
    return { sessions: this.sessionManager.list(providerName) };
  }

  abort(jobIds: string[]): AbortResult {
    return this.jobManager.abort(jobIds);
  }

  /** Poll until launch state is non-pending. Returns 'pending' if timeout expires. */
  async awaitLaunch(jobId: string, timeoutMs: number): Promise<LaunchState> {
    const start = Date.now();
    while (true) {
      const job = this.jobManager.get(jobId);
      if (job && job.launchState !== 'pending') return job.launchState;

      const status = this.progressStore.readStatus(jobId);
      if (status && status.launch.state !== 'pending') return status.launch.state;

      if (!job && status && status.phase !== 'launching') return 'ready';

      if (Date.now() - start >= timeoutMs) return 'pending';
      await sleep(200);
    }
  }

  /** Async generator yielding progress/terminal/timeout events for monitored jobs. */
  async *waitStream(req: WaitRequest): AsyncGenerator<WaitStreamEvent> {
    const { jobIds, timeoutSeconds = 600, cursor } = req;
    const startMs = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    const fromEventIds: Record<string, number> = cursor?.jobs ? { ...cursor.jobs } : {};
    const fileCursors = new Map(jobIds.map((id) => [id, createReplayCursor()]));
    const pending = new Set(jobIds);

    while (pending.size > 0) {
      if (Date.now() - startMs >= timeoutMs) {
        yield { type: 'timeout', runningJobIds: [...pending] };
        return;
      }

      for (const jobId of [...pending]) {
        const fileCursor = fileCursors.get(jobId)!;
        const fromEventId = fromEventIds[jobId] ?? 0;
        const status = this.progressStore.readStatus(jobId);
        if (!status) continue;

        const sessionId = status.sessionId;
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
              result: event.result ?? { text: '' },
            };
            pending.delete(jobId);
            break;
          }
        }
      }

      if (pending.size > 0) {
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }

  private runAsync(
    provider: Provider,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
  ): void {
    const signal = this.jobManager.getSignal(jobId);
    if (!signal) return;

    const onEvent = (event: ProviderProgressEvent): void => {
      const job = this.jobManager.get(jobId);
      if (job && job.launchState === 'pending') this.markJobRunning(jobId);
      this.progressStore.appendProgress(jobId, sessionId, event.message);
    };

    const runtime: ProviderRuntime = { signal, onEvent };

    provider.execute(request, runtime)
      .then((result) => {
        const job = this.jobManager.get(jobId);
        if (job && job.launchState === 'pending') this.markJobReady(jobId);

        const phase: JobPhase = result.aborted ? 'aborted' : 'completed';
        const terminalResult: TerminalResult = {
          text: result.text,
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
        this.progressStore.writeResultMd(jobId, result.text);
        this.jobManager.setPhase(jobId, phase);
        this.jobManager.remove(jobId);

        if (result.conversationRef) {
          this.sessionManager.setConversationRef(sessionId, result.conversationRef);
        } else if (result.nonResumable) {
          this.sessionManager.setNonResumable(sessionId);
        }
        this.sessionManager.releaseJob(sessionId, jobId);
      })
      .catch((err: unknown) => {
        if (err instanceof CliBusyError) {
          this.failJob(jobId, sessionId, 'busy', err.message);
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        this.failJob(jobId, sessionId, 'error', message);
      });
  }

  private markJobReady(jobId: string): void {
    this.jobManager.setLaunchState(jobId, 'ready');
    this.progressStore.updateLaunchState(jobId, 'ready');
  }

  private markJobRunning(jobId: string): void {
    this.markJobReady(jobId);
    this.jobManager.setPhase(jobId, 'running');
    this.progressStore.updatePhase(jobId, 'running');
  }

  private failJob(jobId: string, sessionId: string, launchState: LaunchState, message: string): void {
    this.jobManager.setLaunchState(jobId, launchState, message);
    this.progressStore.updateLaunchState(jobId, launchState, message);
    this.jobManager.setPhase(jobId, 'error');
    this.progressStore.appendTerminal(jobId, sessionId, { text: '', notice: message }, 'error');
    this.jobManager.remove(jobId);
    this.sessionManager.releaseJob(sessionId, jobId);
  }

  private runWorkflowAsync(
    sessionId: string,
    jobId: string,
    providerName: string,
    ast: PipelineAST,
    input: WorkflowInput,
    ctx: CallerContext,
  ): void {
    const signal = this.jobManager.getSignal(jobId);
    if (!signal) return;

    void executePipeline(
      ast,
      input.prompt,
      providerName,
      this,
      ctx,
      {
        atoms: input.atoms,
        signal,
        staleTimeoutMs: input.stale_timeout_seconds * 1000,
        onProgress: (message) => {
          this.progressStore.appendProgress(jobId, sessionId, message);
        },
      },
    )
      .then((text) => {
        const terminalResult: TerminalResult = { text };
        this.progressStore.appendTerminal(jobId, sessionId, terminalResult, 'completed');
        this.progressStore.writeResultMd(jobId, text);
        this.jobManager.setPhase(jobId, 'completed');
        this.jobManager.remove(jobId);
        this.sessionManager.setNonResumable(sessionId);
        this.sessionManager.releaseJob(sessionId, jobId);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const terminalResult: TerminalResult = { text: '', notice: message };
        this.progressStore.appendTerminal(jobId, sessionId, terminalResult, 'error');
        this.jobManager.setPhase(jobId, 'error');
        this.jobManager.remove(jobId);
        this.sessionManager.releaseJob(sessionId, jobId);
      });
  }
}
