import type { InvocationContext } from '../runtime/invocation-context.js';
import type { CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import type { TimePort } from '../infra/port-types.js';
import type { WaitCursor, WaitStreamEvent } from '../jobs/wait.js';
import { phaseForOutcome } from '../jobs/outcome.js';
import {
  buildStepDetailsForAtoms,
  createWorkflowExecutionError,
  type LaunchedAtom,
  type StepDetail,
  type WaitFailure,
  type WaitInternalState,
  type WorkflowExecutionPort,
} from './execution-contract.js';
import { describeTerminalFailure } from './command.js';

// Atom-progress formatters live next to the wait loop that consumes them.
// Originally split into `workflow/internal/format.ts` alongside two unused
// exports (`atomTagName`, `atomDiagnosticLabel`); both dead-on-arrival, both
// removed. `stale-recovery.ts` is the only sibling consumer.
function stripElapsedPrefix(message: string): string {
  if (!message.startsWith('[')) return message;
  const closeBracket = message.indexOf('] ');
  if (closeBracket < 0) return message;
  return message.slice(closeBracket + 2);
}

export function formatAtomProgress(atom: LaunchedAtom, message: string): string {
  return `${atom.stepIndex}-${atom.agent.slice(0, 3)} ${message}`;
}

export type WaitForAtomsOptions = {
  time: Pick<TimePort, 'now'>;
  signal?: AbortSignal;
  staleTimeoutMs: number;
  staleCheckIntervalMs: number;
  drainDeadlineMs: number;
  workDir?: CanonicalWorkDir;
  onProgress: (message: string) => void;
  completedStepDetails?: StepDetail[];
  workflowJobId?: string;
  initialState?: Partial<WaitInternalState>;
  onAtomTerminal?: (state: WaitInternalState) => void;
  onStaleSwap?: (state: WaitInternalState) => void;
  onFailureDrain?: (state: WaitInternalState, failure: WaitFailure) => void;
  recoverStaleAtom?: WaitStaleRecoveryHandler;
  /**
   * Timeout (ms) for the abort-and-wait phase of stale recovery. Resolved at
   * the executor entry-point via `resolveStaleAbortTimeoutMs(env)`; required
   * by callers that opt into stale recovery via `recoverStaleAtom`.
   */
  staleAbortTimeoutMs: number;
};

export type WaitStaleRecoveryHandler = (
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  options: {
    time: Pick<TimePort, 'now'>;
    signal?: AbortSignal;
    staleTimeoutMs: number;
    staleAbortTimeoutMs: number;
    workDir?: CanonicalWorkDir;
    workflowJobId?: string;
    onProgress: (message: string) => void;
    buildPartialStepDetails: () => StepDetail[];
  },
) => Promise<boolean>;

export type AwaitStepState = {
  pending: Map<string, LaunchedAtom>;
  results: Map<string, string>;
  cursor: WaitCursor;
  lastActivityAt: Map<string, number>;
  staleRetries: Map<string, number>;
  expectedStaleAborts: Set<string>;
  failureDrain: {
    firstFailure: WaitFailure;
    drainDeadline: number;
  } | null;
};

function waitTimeoutSeconds(staleTimeoutMs: number, staleCheckIntervalMs: number): number {
  const timeoutMs = staleTimeoutMs > 0 ? Math.min(staleTimeoutMs, staleCheckIntervalMs) : staleCheckIntervalMs;
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function cloneCursor(cursor?: WaitCursor): WaitCursor {
  return { afterSeq: cursor?.afterSeq ?? 0 };
}

function cloneMap<K, V>(value?: Map<K, V>): Map<K, V> {
  return value ? new Map(value) : new Map();
}

function cloneSet<T>(value?: Set<T>): Set<T> {
  return value ? new Set(value) : new Set();
}

function createAwaitStepState(
  atoms: LaunchedAtom[],
  initialState: Partial<WaitInternalState> = {},
  time: Pick<TimePort, 'now'>,
): AwaitStepState {
  const pending = new Map<string, LaunchedAtom>();
  const results = cloneMap(initialState.completedOutputs);
  const lastActivityAt = cloneMap(initialState.lastActivityAt);
  const staleRetries = cloneMap(initialState.staleRetries);
  const startedAt = time.now();

  for (const atom of atoms) {
    if (results.has(atom.atomKey)) continue;
    pending.set(atom.jobId, atom);
    if (!lastActivityAt.has(atom.atomKey)) {
      lastActivityAt.set(atom.atomKey, startedAt);
    }
    if (!staleRetries.has(atom.atomKey)) {
      staleRetries.set(atom.atomKey, 0);
    }
  }

  return {
    pending,
    results,
    cursor: cloneCursor(initialState.cursor),
    lastActivityAt,
    staleRetries,
    expectedStaleAborts: cloneSet(initialState.expectedStaleAborts),
    failureDrain:
      initialState.failureDrain === undefined
        ? null
        : {
            firstFailure: initialState.failureDrain.firstFailure,
            drainDeadline: initialState.failureDrain.drainDeadline,
          },
  };
}

function snapshotWaitState(state: AwaitStepState): WaitInternalState {
  return {
    atoms: [...state.pending.values()],
    completedOutputs: new Map(state.results),
    cursor: cloneCursor(state.cursor),
    lastActivityAt: new Map(state.lastActivityAt),
    staleRetries: new Map(state.staleRetries),
    expectedStaleAborts: new Set(state.expectedStaleAborts),
    failureDrain:
      state.failureDrain === null
        ? undefined
        : {
            firstFailure: state.failureDrain.firstFailure,
            abortRequested: true,
            drainDeadline: state.failureDrain.drainDeadline,
          },
  };
}

function enterFailureDrain(
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  failure: WaitFailure,
  options: Pick<WaitForAtomsOptions, 'onFailureDrain' | 'time' | 'drainDeadlineMs'>,
): void {
  if (state.failureDrain !== null) return;
  state.failureDrain = {
    firstFailure: failure,
    drainDeadline: options.time.now() + options.drainDeadlineMs,
  };
  options.onFailureDrain?.(snapshotWaitState(state), failure);
  executionSvc.abort([...state.pending.keys()]);
}

function handleWaitEvent(
  event: WaitStreamEvent,
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  options: Pick<WaitForAtomsOptions, 'onProgress' | 'onAtomTerminal' | 'onFailureDrain' | 'time' | 'drainDeadlineMs'>,
): 'handled' | 'check-stale' {
  switch (event.type) {
    case 'queued': {
      const atom = state.pending.get(event.jobId);
      if (!atom) return 'handled';
      state.lastActivityAt.set(atom.atomKey, options.time.now());
      options.onProgress(formatAtomProgress(atom, `queued (position ${event.queuePosition})`));
      return 'handled';
    }

    case 'progress': {
      state.cursor.afterSeq = Math.max(state.cursor.afterSeq, event.seq);
      const atom = state.pending.get(event.jobId);
      if (!atom) return 'handled';
      state.lastActivityAt.set(atom.atomKey, options.time.now());
      options.onProgress(formatAtomProgress(atom, stripElapsedPrefix(event.message)));
      return 'handled';
    }

    case 'terminal': {
      const atom = state.pending.get(event.jobId);
      if (!atom) return 'handled';

      state.cursor.afterSeq = Math.max(state.cursor.afterSeq, event.seq);
      state.pending.delete(event.jobId);

      const outcomePhase = phaseForOutcome(event.result.outcome);
      const terminalState = outcomePhase === 'completed' ? 'done' : 'error';
      options.onProgress(formatAtomProgress(atom, terminalState));

      if (state.expectedStaleAborts.has(event.jobId)) {
        // We requested a stale-recovery abort for this job. If it terminated as
        // aborted (expected), swallow it. But if it actually completed in the race
        // before the abort landed, fall through to record the real result rather
        // than discarding it (B4-a).
        state.expectedStaleAborts.delete(event.jobId);
        if (outcomePhase !== 'completed') {
          return 'handled';
        }
      }

      if (outcomePhase !== 'completed') {
        enterFailureDrain(
          state,
          executionSvc,
          {
            aborted: event.result.outcome.kind === 'aborted',
            message: `Step ${atom.stepIndex}, atom '${atom.agent}' failed: ${describeTerminalFailure(event.result)}`,
            failedStep: atom.stepIndex,
            failedAtom: atom.agent,
            failedJobId: event.jobId,
            failedSlotId: atom.slotId,
            causeRef: event.result.outcome.kind === 'failed' ? event.result.outcome.causeRef : undefined,
            terminalOutcome: event.result.outcome,
          },
          options,
        );
        return 'handled';
      }

      state.results.set(atom.atomKey, event.result.content);
      options.onAtomTerminal?.(snapshotWaitState(state));
      return 'handled';
    }

    case 'interrupted':
      // An internal wait completes only on a durable terminal or session release. Observational absence is
      // not either one, so this drains no atom and fails no step — treating it as terminal here would end a
      // workflow branch on a derived reading that the journal may still contradict.
      return 'handled';
    case 'waiting':
      return 'check-stale';
  }
}

async function awaitWaitCycle(
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  options: WaitForAtomsOptions,
  buildPartialStepDetailsForCycle: () => StepDetail[],
): Promise<'stream-ended' | 'stale-recovered'> {
  const timeoutSeconds = waitTimeoutSeconds(options.staleTimeoutMs, options.staleCheckIntervalMs);

  for await (const event of executionSvc.waitStream({
    jobIds: [...state.pending.keys()],
    timeoutSeconds,
    cursor: state.cursor,
  })) {
    const eventOutcome = handleWaitEvent(event, state, executionSvc, options);
    if (eventOutcome !== 'check-stale') continue;
    if (state.failureDrain !== null || options.staleTimeoutMs <= 0 || !options.recoverStaleAtom) continue;

    const recovered = await options.recoverStaleAtom(state, executionSvc, ctx, {
      signal: options.signal,
      staleTimeoutMs: options.staleTimeoutMs,
      staleAbortTimeoutMs: options.staleAbortTimeoutMs,
      workDir: options.workDir,
      workflowJobId: options.workflowJobId,
      onProgress: options.onProgress,
      time: options.time,
      buildPartialStepDetails: buildPartialStepDetailsForCycle,
    });
    if (!recovered) continue;

    options.onStaleSwap?.(snapshotWaitState(state));
    return 'stale-recovered';
  }

  return 'stream-ended';
}

async function awaitStepCompletion(
  atoms: LaunchedAtom[],
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  options: WaitForAtomsOptions,
): Promise<void> {
  const completedStepDetails = options.completedStepDetails ?? [];
  const buildPartialStepDetailsForCycle = (): StepDetail[] => [
    ...completedStepDetails,
    ...buildStepDetailsForAtoms(atoms, state.results),
  ];

  while (state.pending.size > 0) {
    if (options.signal?.aborted && state.failureDrain === null) {
      enterFailureDrain(
        state,
        executionSvc,
        {
          aborted: true,
          message: 'Pipeline aborted (launched atoms may continue)',
        },
        options,
      );
    }

    const cycleOutcome = await awaitWaitCycle(state, executionSvc, ctx, options, buildPartialStepDetailsForCycle);

    if (
      state.failureDrain !== null &&
      (state.pending.size === 0 || options.time.now() >= state.failureDrain.drainDeadline)
    ) {
      throw createWorkflowExecutionError(
        state.failureDrain.firstFailure.message,
        state.failureDrain.firstFailure.aborted,
        buildPartialStepDetailsForCycle(),
        state.failureDrain.firstFailure,
      );
    }

    if (cycleOutcome === 'stale-recovered') continue;
  }
}

export async function waitForAtoms(
  atoms: LaunchedAtom[],
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  options: WaitForAtomsOptions,
): Promise<Map<string, string>> {
  const state = createAwaitStepState(atoms, options.initialState, options.time);
  await awaitStepCompletion(atoms, state, executionSvc, ctx, options);
  return state.results;
}
