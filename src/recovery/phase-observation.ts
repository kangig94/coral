import type { TimePort, TimerHandle } from '../infra/port-types.js';

type ReportedRecoveryState = string | null | ((previous: string | null) => string | null);

export interface RecoveryObservation {
  record(source: string, counts: { subjects?: number; reads?: number }): void;
  reportState?(state: ReportedRecoveryState): void;
}

export interface RecoveryPhaseObservation extends RecoveryObservation {
  reportState(state: ReportedRecoveryState): void;
  finish(outcome?: 'complete' | 'failed' | 'cancelled'): void;
}

const BACKGROUND_SLOW_MS = 5_000;

type RecoveryPhaseOptions = {
  log(message: string): void;
  bootId: string;
  phase: string;
  attempts?: number;
  completed?: (result: PhaseResult) => void;
} & (
  | {
      kind: 'background';
      time: Pick<TimePort, 'monotonicNow' | 'setTimeout' | 'clearTimeout'>;
      signal?: AbortSignal;
      reportedState?: { value: string | null };
    }
  | { kind?: 'startup'; time: Pick<TimePort, 'monotonicNow'> }
);

export function createBackgroundPhaseObserver(options: {
  time: Pick<TimePort, 'monotonicNow' | 'setTimeout' | 'clearTimeout'>;
  log(message: string): void;
  bootId: string;
  phase: string;
}): (signal?: AbortSignal) => RecoveryPhaseObservation {
  const reportedState = { value: null as string | null };
  return (signal) => startRecoveryPhase({ ...options, kind: 'background', reportedState, signal });
}

type RecoveryHold = { identity: string; reason: string };

function recoveryHolds(state: string | null, phase: string): Map<string, string[]> {
  const holds: readonly RecoveryHold[] =
    state === null ? [] : state.startsWith('[') ? JSON.parse(state) : [{ identity: phase, reason: state }];
  const reasons = new Map<string, Set<string>>();
  for (const hold of holds) {
    const current = reasons.get(hold.identity) ?? new Set<string>();
    current.add(hold.reason);
    reasons.set(hold.identity, current);
  }
  return new Map(
    [...reasons]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([identity, values]) => [identity, [...values].sort()]),
  );
}

function recoveryStateDiff(before: ReadonlyMap<string, string[]>, after: ReadonlyMap<string, string[]>) {
  const counts = { added: 0, changed: 0, cleared: 0 };
  const changes: {
    kind: 'added' | 'changed' | 'cleared';
    identity: string;
    reason: string[];
    previousReason?: string[];
  }[] = [];
  for (const [identity, reason] of after) {
    const previousReason = before.get(identity);
    if (JSON.stringify(previousReason) === JSON.stringify(reason)) continue;
    const kind = previousReason === undefined ? 'added' : 'changed';
    counts[kind]++;
    if (changes.length < 10)
      changes.push({ kind, identity, reason, ...(previousReason === undefined ? {} : { previousReason }) });
  }
  for (const [identity, reason] of before) {
    if (after.has(identity)) continue;
    counts.cleared++;
    if (changes.length < 10) changes.push({ kind: 'cleared', identity, reason });
  }
  return { counts, changes };
}

/** Reporting must not change recovery effects or turn a logging failure into a startup failure. */
export function startRecoveryPhase(options: RecoveryPhaseOptions): RecoveryPhaseObservation {
  const started = options.time.monotonicNow();
  const sources: Record<string, { subjects: number; reads: number }> = {};
  const prefix = `recovery-phase boot=${options.bootId} kind=${options.kind ?? 'startup'} phase=${options.phase}`;
  let finished = false;
  let stateUpdate: ReportedRecoveryState | undefined;
  const report = (message: string): void => {
    try {
      options.log(`${message}\n`);
    } catch {
      // Observability cannot select a recovery disposition.
    }
  };
  let watchdog: TimerHandle | null = null;
  const stopWatchdog = (): void => {
    if (options.kind === 'background') options.time.clearTimeout(watchdog);
  };
  if (options.kind === 'background') {
    watchdog = options.time.setTimeout(() => {
      if (!finished && !options.signal?.aborted) report(`${prefix} event=still-running after_ms=${BACKGROUND_SLOW_MS}`);
    }, BACKGROUND_SLOW_MS);
    watchdog.unref?.();
    if (options.signal?.aborted) stopWatchdog();
    else options.signal?.addEventListener('abort', stopWatchdog, { once: true });
  } else {
    report(`${prefix} event=start subjects=0 reads=0 sources={}`);
  }
  return {
    reportState(state): void {
      if (!finished) stateUpdate = state;
    },
    record(source, counts): void {
      if (finished) return;
      const current = sources[source] ?? { subjects: 0, reads: 0 };
      current.subjects += counts.subjects ?? 0;
      current.reads += counts.reads ?? 0;
      sources[source] = current;
    },
    finish(outcome = 'complete'): void {
      if (finished) return;
      finished = true;
      stopWatchdog();
      if (options.kind === 'background') options.signal?.removeEventListener('abort', stopWatchdog);
      if (outcome === 'cancelled' || (options.kind === 'background' && options.signal?.aborted)) return;
      let stateChange = '';
      let unchangedFailedHold = false;
      if (options.kind === 'background' && options.reportedState !== undefined && stateUpdate !== undefined) {
        try {
          const updatedState =
            typeof stateUpdate === 'function' ? stateUpdate(options.reportedState.value) : stateUpdate;
          const previousHolds = recoveryHolds(options.reportedState.value, options.phase);
          const observedHolds = recoveryHolds(updatedState, options.phase);
          let observedState = observedHolds.size === 0 ? null : updatedState;
          if (outcome === 'failed' && observedState !== null) {
            for (const [identity, reasons] of previousHolds) {
              if (!observedHolds.has(identity)) observedHolds.set(identity, reasons);
            }
            observedState = JSON.stringify(
              [...observedHolds]
                .sort(([left], [right]) => left.localeCompare(right))
                .flatMap(([identity, reasons]) => reasons.map((reason) => ({ identity, reason }))),
            );
          }
          if (outcome === 'complete' || observedState !== null) {
            const diff = recoveryStateDiff(previousHolds, observedHolds);
            options.reportedState.value = observedState;
            if (diff.counts.added + diff.counts.changed + diff.counts.cleared > 0) {
              const counts = sources['reported-state'] ?? { subjects: 0, reads: 0 };
              sources['reported-state'] = { ...counts, subjects: counts.subjects + 1 };
              stateChange = ` state=${observedState === null ? 'cleared' : 'held'} detail=${JSON.stringify(diff)}`;
            } else {
              unchangedFailedHold = outcome === 'failed';
            }
          }
        } catch {
          // Diagnostic state must not change recovery effects.
        }
      }
      const durationMs = Number(options.time.monotonicNow() - started);
      if (options.completed !== undefined) {
        options.completed({ durationMs, sources, outcome, attempts: options.attempts ?? 0 });
        return;
      }
      const totals = Object.values(sources).reduce(
        (total, source) => ({ subjects: total.subjects + source.subjects, reads: total.reads + source.reads }),
        { subjects: 0, reads: 0 },
      );
      if (
        options.kind === 'background' &&
        (outcome === 'complete' || unchangedFailedHold) &&
        totals.subjects === 0 &&
        durationMs < BACKGROUND_SLOW_MS
      )
        return;
      report(
        `${prefix} event=finish outcome=${outcome} duration_ms=${durationMs.toFixed(3)}` +
          ` subjects=${totals.subjects} reads=${totals.reads} sources=${JSON.stringify(sources)}${stateChange}`,
      );
    },
  };
}

/** The original result or failure must pass through the observation boundary unchanged. */
export async function observeRecoveryPhase<T>(
  options: Parameters<typeof startRecoveryPhase>[0],
  run: (observation: RecoveryObservation) => Promise<T>,
): Promise<T> {
  const observation = startRecoveryPhase(options);
  try {
    const result = await run(observation);
    observation.finish();
    return result;
  } catch (error: unknown) {
    observation.finish('failed');
    throw error;
  }
}

type PhaseResult = {
  durationMs: number;
  attempts: number;
  sources: Record<string, { subjects: number; reads: number }>;
  outcome: 'complete' | 'failed';
};

export type StartupPhaseObserver = {
  options(phase: string): Parameters<typeof startRecoveryPhase>[0];
  finish(): void;
};

/** A boot reports each startup phase once, however many recovery attempts contribute to it. */
export function createStartupPhaseObserver(options: {
  time: Pick<TimePort, 'monotonicNow'>;
  log(message: string): void;
  bootId: string;
}): StartupPhaseObserver {
  const phases = new Map<string, PhaseResult>();
  let finished = false;
  return {
    options(phase: string): Parameters<typeof startRecoveryPhase>[0] {
      return {
        ...options,
        phase,
        attempts: phase === 'store-open' ? 1 : 0,
        completed(result) {
          if (finished) return;
          const total = phases.get(phase) ?? { durationMs: 0, attempts: 0, sources: {}, outcome: result.outcome };
          total.durationMs += result.durationMs;
          total.attempts += result.attempts;
          total.outcome = result.outcome;
          for (const [source, counts] of Object.entries(result.sources)) {
            const current = total.sources[source] ?? { subjects: 0, reads: 0 };
            current.subjects += counts.subjects;
            current.reads += counts.reads;
            total.sources[source] = current;
          }
          phases.set(phase, total);
        },
      };
    },
    finish(): void {
      if (finished) return;
      finished = true;
      for (const [phase, result] of phases) {
        const totals = Object.values(result.sources).reduce(
          (total, source) => ({ subjects: total.subjects + source.subjects, reads: total.reads + source.reads }),
          { subjects: 0, reads: 0 },
        );
        try {
          options.log(
            `recovery-phase boot=${options.bootId} kind=startup phase=${phase} event=finish outcome=${result.outcome}` +
              ` duration_ms=${result.durationMs.toFixed(3)}` +
              (phase === 'store-open'
                ? ` attempts=${result.attempts}\n`
                : ` subjects=${totals.subjects} reads=${totals.reads} sources=${JSON.stringify(result.sources)}\n`),
          );
        } catch {
          // Observability cannot select a recovery disposition.
        }
      }
    },
  };
}
