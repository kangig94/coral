import type { CallerContext } from '../infra/request-context.js';
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
} from './command.js';
import { describeTerminalFailure } from './command.js';
import { formatAtomProgress, stripElapsedPrefix } from './internal/format.js';

export type WaitForAtomsOptions = {
  signal?: AbortSignal;
  staleTimeoutMs: number;
  pollIntervalMs: number;
  workDir?: string;
  onProgress: (message: string) => void;
  completedStepDetails?: StepDetail[];
  initialState?: Partial<WaitInternalState>;
  onAtomTerminal?: (state: WaitInternalState) => void;
  onStaleSwap?: (state: WaitInternalState) => void;
  onFailureDrain?: (state: WaitInternalState, failure: WaitFailure) => void;
  recoverStaleAtom?: WaitStaleRecoveryHandler;
};

export type WaitStaleRecoveryHandler = (
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  options: {
    signal?: AbortSignal;
    staleTimeoutMs: number;
    workDir?: string;
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

export function waitTimeoutSeconds(staleTimeoutMs: number, pollIntervalMs: number): number {
  const timeoutMs = staleTimeoutMs > 0 ? Math.min(staleTimeoutMs, pollIntervalMs) : pollIntervalMs;
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function cloneCursor(cursor?: WaitCursor): WaitCursor {
  return { jobs: { ...(cursor?.jobs ?? {}) } };
}

function cloneMap<K, V>(value?: Map<K, V>): Map<K, V> {
  return value ? new Map(value) : new Map();
}

function cloneSet<T>(value?: Set<T>): Set<T> {
  return value ? new Set(value) : new Set();
}

export function createAwaitStepState(
  atoms: LaunchedAtom[],
  initialState: Partial<WaitInternalState> = {},
): AwaitStepState {
  const pending = new Map<string, LaunchedAtom>();
  const results = cloneMap(initialState.completedOutputs);
  const lastActivityAt = cloneMap(initialState.lastActivityAt);
  const staleRetries = cloneMap(initialState.staleRetries);
  const startedAt = Date.now();

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

export function snapshotWaitState(state: AwaitStepState): WaitInternalState {
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
  options: Pick<WaitForAtomsOptions, 'onFailureDrain'>,
): void {
  if (state.failureDrain !== null) return;
  state.failureDrain = {
    firstFailure: failure,
    drainDeadline: Date.now() + 15_000,
  };
  options.onFailureDrain?.(snapshotWaitState(state), failure);
  executionSvc.abort([...state.pending.keys()]);
}

export function handleWaitEvent(
  event: WaitStreamEvent,
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  options: Pick<WaitForAtomsOptions, 'onProgress' | 'onAtomTerminal' | 'onFailureDrain'>,
): 'handled' | 'check-stale' {
  switch (event.type) {
    case 'queued': {
      const atom = state.pending.get(event.jobId);
      if (!atom) return 'handled';
      state.lastActivityAt.set(atom.atomKey, Date.now());
      options.onProgress(formatAtomProgress(atom, `queued (position ${event.queuePosition})`));
      return 'handled';
    }

    case 'progress': {
      state.cursor.jobs[event.jobId] = event.eventId;
      const atom = state.pending.get(event.jobId);
      if (!atom) return 'handled';
      state.lastActivityAt.set(atom.atomKey, Date.now());
      options.onProgress(formatAtomProgress(atom, stripElapsedPrefix(event.message)));
      return 'handled';
    }

    case 'terminal': {
      const atom = state.pending.get(event.jobId);
      if (!atom) return 'handled';

      state.pending.delete(event.jobId);
      delete state.cursor.jobs[event.jobId];

      const terminalState = phaseForOutcome(event.result.outcome) === 'completed' ? 'done' : 'error';
      options.onProgress(formatAtomProgress(atom, terminalState));

      if (state.expectedStaleAborts.has(event.jobId)) {
        state.expectedStaleAborts.delete(event.jobId);
        return 'handled';
      }

      if (phaseForOutcome(event.result.outcome) !== 'completed') {
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

    case 'waiting':
      return 'check-stale';
  }
}

export async function awaitWaitCycle(
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  options: WaitForAtomsOptions,
  buildPartialStepDetailsForCycle: () => StepDetail[],
): Promise<'stream-ended' | 'stale-recovered'> {
  const timeoutSeconds = waitTimeoutSeconds(options.staleTimeoutMs, options.pollIntervalMs);

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
      workDir: options.workDir,
      onProgress: options.onProgress,
      buildPartialStepDetails: buildPartialStepDetailsForCycle,
    });
    if (!recovered) continue;

    options.onStaleSwap?.(snapshotWaitState(state));
    return 'stale-recovered';
  }

  return 'stream-ended';
}

export async function awaitStepCompletion(
  atoms: LaunchedAtom[],
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
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

    if (state.failureDrain !== null && (state.pending.size === 0 || Date.now() >= state.failureDrain.drainDeadline)) {
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
  ctx: CallerContext,
  options: WaitForAtomsOptions,
): Promise<Map<string, string>> {
  const state = createAwaitStepState(atoms, options.initialState);
  await awaitStepCompletion(atoms, state, executionSvc, ctx, options);
  return state.results;
}
