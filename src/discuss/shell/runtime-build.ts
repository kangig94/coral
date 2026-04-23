import {
  makeEvent,
  type PersistedDiscussAgentRun,
  type SessionCreatedAgentExecutionConfig,
} from '../events.js';
import type { PersistedDiscussSnapshot } from '../events.js';
import { readDiscussSourcesWithStorage } from './discuss-sources-catalog.js';
import { backendLog } from '../../infra/backend-log.js';
import { nowIsoString } from '../../infra/time.js';
import { isLivePhase } from '../../jobs/phase.js';
import type { JobStatus } from '../../jobs/records.js';
import { errorMessage, formatError } from '../../infra/error-format.js';
import type { CallerContext } from '../../infra/request-context.js';
import { appendRuntimeEvents, loadAttachedOrPersistedSnapshot } from './persistence.js';
import type { JobContinuitySnapshot } from '../../jobs/continuity.js';
import type {
  AgentConfig,
  DiscussContext,
  DiscussLaunchDecision,
  DiscussService,
  DiscussWaitResult,
} from './context.js';
import {
  clearAllDiscuss,
  getOrCreate as getOrCreateDiscussContext,
  hasRunningSessions,
} from './live-registry.js';
import * as discussLoop from './loop.js';
import * as discussOperations from './operations.js';
import type { RecoveredDiscussResume } from './operations.js';
import { knownDiscussSources, type DiscussReadHelpersDeps } from './read-helpers.js';
import { DiscussSessionStore } from './session-store.js';
import type { Runtime } from '../../runtime/ports.js';

export const DEFAULT_DISCUSS_PROVIDER = 'claude';
const RETRYABLE_ATTEMPT_OUTCOMES = new Set([
  'execution_error',
  'recovery_failed',
  'recovery_missing',
  'retryable_parse_error',
]);

export const CONTINUE_TURN_INSTRUCTION =
  'You are participating in a backend-managed multi-agent discussion. Follow the prompt exactly and return only the requested format.';
export const FOLLOW_UP_TURN_INSTRUCTION =
  'You are answering a moderator follow-up in an ongoing discussion. Respond with the answer text only. Do not use markdown or code fences.';
export const PURPOSE_BID = 'bid';
export const PURPOSE_SPEECH = 'speech';
export const PURPOSE_EPOCH_EVALUATION = 'epoch_evaluation';
export const PURPOSE_FOLLOW_UP = 'follow_up';
export const PURPOSE_SYNTHESIS = 'synthesis';

export type DiscussPurpose =
  | typeof PURPOSE_BID
  | typeof PURPOSE_SPEECH
  | typeof PURPOSE_EPOCH_EVALUATION
  | typeof PURPOSE_FOLLOW_UP
  | typeof PURPOSE_SYNTHESIS;

export type AttemptSuccess = {
  ok: true;
  attempt: number;
  jobId: string;
  content: string;
  continuity: JobContinuitySnapshot | null;
};

export type AttemptFailure = {
  ok: false;
  attempt?: number;
  consumedAttempt: boolean;
  message: string;
};

export type AttemptResult = AttemptSuccess | AttemptFailure;

export type ExecuteAgentAttemptParams = {
  agentName: string;
  sessionId: string;
  provider: string;
  model: string | undefined;
  prompt: string;
  instruction: string;
  cwd: string;
  callerCtx: CallerContext;
  purpose: DiscussPurpose;
  timeoutMs?: number;
};

export type RunPlainTurnParams = ExecuteAgentAttemptParams;

export type RunFacilitatorTurnParams = {
  sessionId: string;
  prompt: string;
  instruction: string;
  callerCtx: CallerContext;
  timeoutMs: number;
  purpose: DiscussPurpose;
};

export type RecordJobFinishedParams = {
  sessionId: string;
  agentName: string;
  purpose: DiscussPurpose;
  jobId: string;
  attempt: number;
  outcome: string;
};

type FacilitatorRun = {
  agentName: string;
  provider: string;
  model?: string;
};

function isRetryableAttemptOutcome(outcome: string | undefined): boolean {
  return outcome !== undefined && RETRYABLE_ATTEMPT_OUTCOMES.has(outcome);
}

export function isAttemptSuccess(result: AttemptResult): result is AttemptSuccess {
  return result.ok;
}

export function normalizeModel(model: string | undefined): string | undefined {
  if (model === undefined || model.length === 0) {
    return undefined;
  }
  return model;
}

export function buildAgentExecutionConfig(agents: AgentConfig[]): Record<string, SessionCreatedAgentExecutionConfig> {
  return Object.fromEntries(
    agents.map((agent) => {
      const isManualObserver =
        (agent.participation ?? 'required') === 'observer' && agent.provider === undefined && agent.model === undefined;

      if (isManualObserver) {
        return [agent.name, { manual: true }];
      }

      return [
        agent.name,
        {
          manual: false,
          provider: agent.provider ?? DEFAULT_DISCUSS_PROVIDER,
          model: agent.model ?? '',
        },
      ];
    }),
  ) as Record<string, SessionCreatedAgentExecutionConfig>;
}

export function nextAttemptForPurpose(run: PersistedDiscussAgentRun | undefined, purpose: DiscussPurpose): number {
  if (!run) {
    return 1;
  }
  if (run.currentJobPurpose === purpose && run.currentJobId !== undefined) {
    return run.currentAttempt ?? 1;
  }
  if (isRetryableAttemptOutcome(run.lastAttemptOutcome)) {
    return (run.currentAttempt ?? 0) + 1;
  }
  return 1;
}

export function currentAgentRun(
  snapshot: PersistedDiscussSnapshot,
  agentName: string,
  provider: string,
  model: string | undefined,
): PersistedDiscussAgentRun {
  const existing = snapshot.runtime.agentRuns[agentName];
  if (existing) {
    return existing;
  }

  return {
    provider,
    model: model ?? '',
  };
}

export function isManualParticipant(snapshot: PersistedDiscussSnapshot, agentName: string): boolean {
  return snapshot.state.agents[agentName]?.participation === 'observer' && !(agentName in snapshot.runtime.agentRuns);
}

export function hasPendingAutoBidders(snapshot: PersistedDiscussSnapshot): boolean {
  return Object.entries(snapshot.state.current_bids).some(
    ([agentName, score]) =>
      score === null && !snapshot.state.agents[agentName]?.banned && !isManualParticipant(snapshot, agentName),
  );
}

export function hasActiveBidWork(snapshot: PersistedDiscussSnapshot): boolean {
  return Object.values(snapshot.runtime.agentRuns).some(
    (run) => run.currentJobId !== undefined && run.currentJobPurpose === PURPOSE_BID,
  );
}

function facilitatorRun(snapshot: PersistedDiscussSnapshot): FacilitatorRun | null {
  for (const [name, agent] of Object.entries(snapshot.state.agents)) {
    if (agent.banned || agent.participation !== 'required') {
      continue;
    }

    const run = snapshot.runtime.agentRuns[name];
    if (run) {
      return {
        agentName: name,
        provider: run.provider,
        model: normalizeModel(run.model),
      };
    }
  }

  return null;
}

export async function recordJobFinished(ctx: DiscussContext, params: RecordJobFinishedParams): Promise<void> {
  const { sessionId, agentName, purpose, jobId, attempt, outcome } = params;

  await appendRuntimeEvents(ctx, sessionId, (current) => {
    const run = current.runtime.agentRuns[agentName];
    if (!run || run.currentJobPurpose !== purpose || run.currentAttempt !== attempt) {
      return [];
    }
    if (run.currentJobId !== jobId) {
      return [];
    }

    return [
      makeEvent(
        current.sessionId,
        ctx.projectRoot,
        current.state.topic,
        current.lastAppliedSeq + 1,
        'agent.job.finished',
        nowIsoString(ctx.runtime.time),
        {
          agent: agentName,
          jobId,
          outcome,
          attempt,
        },
      ),
    ];
  });
}

export async function executeAgentAttempt(
  ctx: DiscussContext,
  params: ExecuteAgentAttemptParams,
): Promise<AttemptResult> {
  const { agentName, sessionId, provider, model, prompt, instruction, cwd, callerCtx, purpose, timeoutMs } = params;

  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot) {
    return {
      ok: false,
      consumedAttempt: false,
      message: `Discuss session not found: ${sessionId}`,
    };
  }

  let activeRun = currentAgentRun(snapshot, agentName, provider, model);
  let attempt = nextAttemptForPurpose(snapshot.runtime.agentRuns[agentName], purpose);
  let activeJobId = activeRun.currentJobPurpose === purpose ? activeRun.currentJobId : undefined;

  while (activeJobId) {
    const status = ctx.jobStatusReader.read(activeJobId);
    if (status === null) {
      await recordJobFinished(ctx, {
        sessionId,
        agentName,
        purpose,
        jobId: activeJobId,
        attempt,
        outcome: 'recovery_missing',
      });
    } else if (status.phase === 'completed') {
      return {
        ok: true,
        attempt,
        jobId: activeJobId,
        content: status.result?.content ?? '',
        continuity: status.continuity ?? null,
      };
    } else if (!isLivePhase(status.phase)) {
      await recordJobFinished(ctx, {
        sessionId,
        agentName,
        purpose,
        jobId: activeJobId,
        attempt,
        outcome: 'recovery_failed',
      });
    } else {
      try {
        const result = await ctx.service.waitStreamOnce(activeJobId, timeoutMs);
        return {
          ok: true,
          attempt,
          jobId: activeJobId,
          content: result.content,
          continuity: result.continuity,
        };
      } catch (error: unknown) {
        const message = errorMessage(error);
        await recordJobFinished(ctx, {
          sessionId,
          agentName,
          purpose,
          jobId: activeJobId,
          attempt,
          outcome: 'execution_error',
        });
        return {
          ok: false,
          attempt,
          consumedAttempt: true,
          message,
        };
      }
    }

    const refreshed = loadAttachedOrPersistedSnapshot(ctx, sessionId);
    if (!refreshed) {
      return {
        ok: false,
        attempt,
        consumedAttempt: true,
        message: `Discuss session not found: ${sessionId}`,
      };
    }

    activeRun = currentAgentRun(refreshed, agentName, provider, model);
    attempt = nextAttemptForPurpose(refreshed.runtime.agentRuns[agentName], purpose);
    activeJobId = activeRun.currentJobPurpose === purpose ? activeRun.currentJobId : undefined;
  }

  const executionSessionId = activeRun.executionSessionId;
  const launch =
    executionSessionId === undefined
      ? await ctx.service.start(
          provider,
          {
            prompt,
            model,
            pool: 'discuss',
            cwd,
            bypassPermissions: true,
            instruction: {
              channel: 'system',
              content: instruction,
            },
          },
          callerCtx,
        )
      : await ctx.service.resume(
          provider,
          {
            sessionId: executionSessionId,
            prompt: `${instruction}\n\n---\n\n${prompt}`,
            model,
            pool: 'discuss',
            cwd,
            bypassPermissions: true,
          },
          callerCtx,
        );

  if (launch.status === 'rejected') {
    return {
      ok: false,
      consumedAttempt: false,
      message: launch.message,
    };
  }

  if (executionSessionId === undefined) {
    await appendRuntimeEvents(ctx, sessionId, (current) => {
      const latestRun = current.runtime.agentRuns[agentName];
      if (latestRun?.executionSessionId === launch.session) {
        return [];
      }
      return [
        makeEvent(
          current.sessionId,
          ctx.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'agent.run.bound',
          nowIsoString(ctx.runtime.time),
          {
            agent: agentName,
            executionSessionId: launch.session,
          },
        ),
      ];
    });
  }

  await appendRuntimeEvents(ctx, sessionId, (current) => {
    const latestRun = current.runtime.agentRuns[agentName];
    if (
      latestRun?.currentJobId === launch.job &&
      latestRun.currentJobPurpose === purpose &&
      latestRun.currentAttempt === attempt
    ) {
      return [];
    }

    return [
      makeEvent(
        current.sessionId,
        ctx.projectRoot,
        current.state.topic,
        current.lastAppliedSeq + 1,
        'agent.job.started',
        nowIsoString(ctx.runtime.time),
        {
          agent: agentName,
          jobId: launch.job,
          purpose,
          attempt,
        },
      ),
    ];
  });

  try {
    const result = await ctx.service.waitStreamOnce(launch.job, timeoutMs);
    return {
      ok: true,
      attempt,
      jobId: launch.job,
      content: result.content,
      continuity: result.continuity,
    };
  } catch (error: unknown) {
    const message = errorMessage(error);
    await recordJobFinished(ctx, {
      sessionId,
      agentName,
      purpose,
      jobId: launch.job,
      attempt,
      outcome: 'execution_error',
    });
    return {
      ok: false,
      attempt,
      consumedAttempt: true,
      message,
    };
  }
}

export async function runPlainTurn(
  ctx: DiscussContext,
  params: RunPlainTurnParams,
): Promise<{ content: string; continuity: JobContinuitySnapshot | null }> {
  const attempt = await executeAgentAttempt(ctx, params);
  if (!isAttemptSuccess(attempt)) {
    throw new Error(attempt.message);
  }

  await recordJobFinished(ctx, {
    sessionId: params.sessionId,
    agentName: params.agentName,
    purpose: params.purpose,
    jobId: attempt.jobId,
    attempt: attempt.attempt,
    outcome: !(attempt.continuity?.resumable ?? true) ? 'non_resumable' : 'completed',
  });

  return {
    content: attempt.content,
    continuity: attempt.continuity,
  };
}

export async function runFacilitatorTurn(
  ctx: DiscussContext,
  params: RunFacilitatorTurnParams,
): Promise<{ content: string; continuity: JobContinuitySnapshot | null }> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, params.sessionId);
  if (!snapshot) {
    throw new Error(`Discuss session not found: ${params.sessionId}`);
  }

  const facilitator = facilitatorRun(snapshot);
  if (!facilitator) {
    throw new Error('No facilitator agent is available');
  }

  return runPlainTurn(ctx, {
    agentName: facilitator.agentName,
    sessionId: params.sessionId,
    provider: facilitator.provider,
    model: facilitator.model,
    prompt: params.prompt,
    instruction: params.instruction,
    cwd: ctx.projectRoot,
    callerCtx: params.callerCtx,
    purpose: params.purpose,
    timeoutMs: params.timeoutMs,
  });
}

type CreateDiscussRuntimeDeps = {
  world: {
    identity: { pluginRoot: string };
    discussRegistry: {
      contexts: Map<string, DiscussContext>;
    };
    progressStore: {
      readStatus(jobId: string): JobStatus | null;
    };
    resolveProjectSource: (projectRoot: string) => string;
    eventBus: {
      emit(
        event: 'discuss:updated',
        payload: { projectRoot: string; sessionId: string; lastSeq: number; status: string },
      ): boolean;
    };
  };
  runtime: Runtime;
  getExecutionService: (ctx: CallerContext) => {
    start(...args: unknown[]): Promise<DiscussLaunchDecision>;
    resumeBySessionId(...args: unknown[]): Promise<DiscussLaunchDecision>;
    waitStreamOnce(...args: unknown[]): Promise<DiscussWaitResult>;
  };
};

export function createDiscussRuntime({
  world,
  runtime,
  getExecutionService,
}: CreateDiscussRuntimeDeps): {
  getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  getDiscussContext: (ctx: CallerContext) => DiscussContext;
  readHelpersDeps: DiscussReadHelpersDeps;
  hooks: {
    onShutdown(mode: 'handoff' | 'hard'): Promise<void>;
    onIdleCheck(): boolean;
    onRecoveryComplete(resumes: RecoveredDiscussResume[]): Promise<void>;
  };
  discussStores: Map<string, DiscussSessionStore>;
} {
  const discussStores = new Map<string, DiscussSessionStore>();

  function getDiscussStoreForSource(source: string): DiscussSessionStore {
    const existing = discussStores.get(source);
    if (existing) return existing;
    const created = new DiscussSessionStore(source, {
      storage: runtime.storage,
      time: runtime.time,
      paths: runtime.paths,
      onCommit: (snapshot) => {
        world.eventBus.emit('discuss:updated', {
          projectRoot: snapshot.projectRoot,
          sessionId: snapshot.sessionId,
          lastSeq: snapshot.lastAppliedSeq,
          status: snapshot.state.status,
        });
      },
    });
    discussStores.set(source, created);
    return created;
  }

  function getDiscussStore(projectRoot: string): DiscussSessionStore {
    return getDiscussStoreForSource(world.resolveProjectSource(projectRoot));
  }

  function getDiscussContext(ctx: CallerContext): DiscussContext {
    const store = getDiscussStore(ctx.projectRoot);
    const executionService = getExecutionService(ctx);
    const jobStatusReader = {
      read: (jobId: string) => world.progressStore.readStatus(jobId),
    };
    const discussService: DiscussService = {
      start: (...args) => executionService.start(...args),
      resume: (...args) => executionService.resumeBySessionId(...args),
      waitStreamOnce: (...args) => executionService.waitStreamOnce(...args),
    };
    return getOrCreateDiscussContext(
      world.discussRegistry,
      ctx.projectRoot,
      discussService,
      store,
      {
        runtime: {
          ids: runtime.ids,
          env: runtime.env,
          time: runtime.time,
        },
        jobStatusReader,
      },
    );
  }

  const readHelpersDeps: DiscussReadHelpersDeps = {
    discussRegistry: world.discussRegistry,
    getDiscussStoreForSource,
    resolveProjectSource: world.resolveProjectSource,
    readDiscussSources: () => readDiscussSourcesWithStorage(runtime.storage, runtime.paths),
  };

  const hooks = {
    onShutdown: async (mode: 'handoff' | 'hard') => {
      const discussSourcesAtShutdown = mode === 'hard' ? [...knownDiscussSources(readHelpersDeps)] : [];

      await clearAllDiscuss(world.discussRegistry, mode, discussOperations.persistAbortEndForShutdown);

      if (mode !== 'hard') {
        return;
      }

      await discussOperations.persistAbortEndForPersistedShutdownCandidates(
        discussSourcesAtShutdown,
        getDiscussStoreForSource,
        (snapshot) =>
          getDiscussContext({
            projectRoot: snapshot.projectRoot,
            pluginRoot: world.identity.pluginRoot,
            coralEnv: {},
          }),
      );
      world.discussRegistry.contexts.clear();
    },
    onIdleCheck: () => hasRunningSessions(world.discussRegistry),
    onRecoveryComplete: async (resumes: RecoveredDiscussResume[]) => {
      for (const recovered of resumes) {
        try {
          discussLoop.resumeLoop(recovered.ctx, recovered.sessionId, recovered.callerCtx);
        } catch (error: unknown) {
          backendLog.warn(`Discuss resume failed for session ${recovered.sessionId}: ${formatError(error)}`);
        }
      }
    },
  };

  return {
    getDiscussStoreForSource,
    getDiscussContext,
    readHelpersDeps,
    hooks,
    discussStores,
  };
}
