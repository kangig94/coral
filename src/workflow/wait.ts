import { setImmediate } from 'node:timers/promises';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import type { TimePort } from '../infra/port-types.js';
import { type WaitCursor, type WaitStreamEvent } from '../jobs/wait/contract.js';
import { waitCursorForJobs } from '../jobs/wait/cursor.js';
import { advanceWaitRenderCursor } from '../jobs/wait/stream-event.js';
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
  time: Pick<TimePort, 'now' | 'monotonicNow' | 'sleep'>;
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
  cursor: WaitCursor | undefined;
  lastActivityAt: Map<string, number>;
  staleRetries: Map<string, number>;
  expectedStaleAborts: Set<string>;
  observedIdleMs: Map<string, number>;
  lastObservedAtMonotonicMs: bigint;
  observedDrainMs: number;
  failureDrain: {
    firstFailure: WaitFailure;
    drainDeadline: number;
  } | null;
  /** Pending children the current cycle's wait refused: no terminal of theirs can arrive through it. */
  unobservable: Set<string>;
  /** Children the failure abort answered as absent, so none of them is left to drain. */
  abortAbsent: Set<string>;
};

function waitTimeoutSeconds(staleTimeoutMs: number, staleCheckIntervalMs: number): number {
  const timeoutMs = staleTimeoutMs > 0 ? Math.min(staleTimeoutMs, staleCheckIntervalMs) : staleCheckIntervalMs;
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function cloneCursor(cursor?: WaitCursor): WaitCursor | undefined {
  return cursor === undefined ? undefined : structuredClone(cursor);
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
  time: Pick<TimePort, 'now' | 'monotonicNow'>,
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
    observedIdleMs: new Map([...pending.values()].map((atom) => [atom.atomKey, 0])),
    lastObservedAtMonotonicMs: time.monotonicNow(),
    observedDrainMs: 0,
    unobservable: new Set(),
    abortAbsent: new Set(),
    failureDrain:
      initialState.failureDrain === undefined
        ? null
        : {
            firstFailure: initialState.failureDrain.firstFailure,
            drainDeadline: initialState.failureDrain.drainDeadline,
          },
  };
}

function advanceObservedWaitTime(state: AwaitStepState, observedAtMonotonicMs: bigint, cadenceMs: number): void {
  const observedGapMs = observedAtMonotonicMs - state.lastObservedAtMonotonicMs;
  state.lastObservedAtMonotonicMs = observedAtMonotonicMs;
  if (observedGapMs <= 0n) return;
  const contributionMs = Math.min(Number(observedGapMs), cadenceMs);
  for (const atom of state.pending.values()) {
    state.observedIdleMs.set(atom.atomKey, (state.observedIdleMs.get(atom.atomKey) ?? 0) + contributionMs);
  }
  if (state.failureDrain !== null) state.observedDrainMs += contributionMs;
}

function snapshotWaitState(state: AwaitStepState): WaitInternalState {
  return {
    atoms: [...state.pending.values()],
    completedOutputs: new Map(state.results),
    cursor: cloneCursor(waitCursorForJobs(state.cursor, [...state.pending.keys()])),
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
  state.observedDrainMs = 0;
  options.onFailureDrain?.(snapshotWaitState(state), failure);
  state.abortAbsent = new Set(executionSvc.abort([...state.pending.keys()]).notFound);
  for (const jobId of state.unobservable) releaseAbsent(state, jobId);
}

/** A refused child leaves the drain only once the abort answered that no such job exists. */
function releaseAbsent(state: AwaitStepState, jobId: string): void {
  const atom = state.pending.get(jobId);
  if (!atom || !state.abortAbsent.has(jobId)) return;
  state.pending.delete(jobId);
  state.observedIdleMs.delete(atom.atomKey);
}

function recordWaitActivity(
  state: AwaitStepState,
  atom: LaunchedAtom,
  message: string,
  options: Pick<WaitForAtomsOptions, 'onProgress' | 'time'>,
): void {
  state.lastActivityAt.set(atom.atomKey, options.time.now());
  state.observedIdleMs.set(atom.atomKey, 0);
  options.onProgress(formatAtomProgress(atom, message));
}

function handleWaitEvent(
  event: WaitStreamEvent,
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  options: Pick<WaitForAtomsOptions, 'onProgress' | 'onAtomTerminal' | 'onFailureDrain' | 'time' | 'drainDeadlineMs'>,
): 'handled' | 'check-stale' {
  switch (event.type) {
    case 'cursor':
      state.cursor = advanceWaitRenderCursor(state.cursor, event).cursor;
      return 'handled';
    case 'notice':
    case 'artifact':
      return 'handled';
    case 'disposition': {
      if (event.disposition === 'discovery-unknown') return 'handled';
      const atom = state.pending.get(event.jobId);
      if (!atom) return 'handled';
      // The refused child stays pending, so the abort includes it and its drain obligation outlives this refusal.
      state.unobservable.add(event.jobId);
      releaseAbsent(state, event.jobId);
      enterFailureDrain(
        state,
        executionSvc,
        {
          aborted: false,
          message: `Step ${atom.stepIndex}, atom '${atom.agent}' could not be read: ${event.disposition}`,
          failedStep: atom.stepIndex,
          failedAtom: atom.agent,
          failedJobId: event.jobId,
          failedSlotId: atom.slotId,
        },
        options,
      );
      return 'handled';
    }
    case 'queued': {
      const atom = state.pending.get(event.jobId);
      if (!atom) return 'handled';
      recordWaitActivity(state, atom, `queued (position ${event.queuePosition})`, options);
      return 'handled';
    }

    case 'progress': {
      const advanced = advanceWaitRenderCursor(state.cursor, event);
      state.cursor = advanced.cursor;
      if (!advanced.shouldRender) return 'handled';
      const atom = state.pending.get(event.jobId);
      if (!atom) return 'handled';
      recordWaitActivity(state, atom, stripElapsedPrefix(event.message), options);
      return 'handled';
    }

    case 'terminal': {
      const atom = state.pending.get(event.jobId);
      if (!atom) return 'handled';

      // A render decision may advance the cursor but may not withhold a pending atom's terminal.
      state.cursor = advanceWaitRenderCursor(state.cursor, event).cursor;
      state.pending.delete(event.jobId);
      state.cursor = waitCursorForJobs(state.cursor, [...state.pending.keys()]);
      state.observedIdleMs.delete(atom.atomKey);

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

type DrainingState = AwaitStepState & { failureDrain: NonNullable<AwaitStepState['failureDrain']> };

function failureDrainEnded(state: AwaitStepState, drainDeadlineMs: number): state is DrainingState {
  return state.failureDrain !== null && (state.pending.size === 0 || state.observedDrainMs >= drainDeadlineMs);
}

async function awaitWaitCycle(
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  options: WaitForAtomsOptions,
  buildPartialStepDetailsForCycle: () => StepDetail[],
): Promise<'stream-ended' | 'stream-empty' | 'stale-recovered' | 'drain-ended'> {
  const timeoutSeconds = waitTimeoutSeconds(options.staleTimeoutMs, options.staleCheckIntervalMs);
  const observedCadenceMs = timeoutSeconds * 1_000;
  let events = 0;
  state.unobservable.clear();

  // The pipeline abort signal is not this wait's: after an abort the wait is what drains the aborted atoms.
  for await (const event of executionSvc.waitStream({
    jobIds: [...state.pending.keys()],
    timeoutSeconds,
    cursor: waitCursorForJobs(state.cursor, [...state.pending.keys()]),
  })) {
    events++;
    advanceObservedWaitTime(state, options.time.monotonicNow(), observedCadenceMs);
    const eventOutcome = handleWaitEvent(event, state, executionSvc, options);
    // A refused live child can replenish the internal reader's backlog forever, so the drain bound holds per event,
    // never only once the stream ends; leaving the loop closes the stream.
    if (failureDrainEnded(state, options.drainDeadlineMs)) return 'drain-ended';
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

  return events === 0 ? 'stream-empty' : 'stream-ended';
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
    const cadenceMs = waitTimeoutSeconds(options.staleTimeoutMs, options.staleCheckIntervalMs) * 1_000;
    // A cycle that observed nothing may not be followed by another in the same macrotask, or timers starve.
    if (cycleOutcome === 'stream-empty') await setImmediate();
    // A wait that refuses every pending child returns at once, so the drain then waits out its cadence instead.
    if (
      state.failureDrain !== null &&
      state.pending.size > 0 &&
      [...state.pending.keys()].every((jobId) => state.unobservable.has(jobId))
    )
      await options.time.sleep(Math.max(0, Math.min(cadenceMs, options.drainDeadlineMs - state.observedDrainMs)));
    advanceObservedWaitTime(state, options.time.monotonicNow(), cadenceMs);

    if (failureDrainEnded(state, options.drainDeadlineMs)) {
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
