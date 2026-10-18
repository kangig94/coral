import type { TimePort } from '../infra/port-types.js';

export interface RecoveryObservation {
  record(source: string, counts: { subjects?: number; reads?: number }): void;
}

export interface RecoveryPhaseObservation extends RecoveryObservation {
  finish(outcome?: 'complete' | 'failed'): void;
}

/** Reporting must not change recovery effects or turn a logging failure into a startup failure. */
export function startRecoveryPhase(options: {
  time: Pick<TimePort, 'monotonicNow'>;
  log(message: string): void;
  bootId: string;
  phase: string;
  kind?: 'startup' | 'background';
  attempts?: number;
  completed?: (result: PhaseResult) => void;
}): RecoveryPhaseObservation {
  const started = options.time.monotonicNow();
  const sources: Record<string, { subjects: number; reads: number }> = {};
  const prefix = `recovery-phase boot=${options.bootId} kind=${options.kind ?? 'startup'} phase=${options.phase}`;
  let finished = false;
  const report = (message: string): void => {
    try {
      options.log(`${message}\n`);
    } catch {
      // Observability cannot select a recovery disposition.
    }
  };
  if (options.kind === 'background') report(`${prefix} event=start subjects=0 reads=0 sources={}`);
  return {
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
      const durationMs = Number(options.time.monotonicNow() - started);
      if (options.completed !== undefined) {
        options.completed({ durationMs, sources, outcome, attempts: options.attempts ?? 0 });
        return;
      }
      const totals = Object.values(sources).reduce(
        (total, source) => ({ subjects: total.subjects + source.subjects, reads: total.reads + source.reads }),
        { subjects: 0, reads: 0 },
      );
      report(
        `${prefix} event=finish outcome=${outcome} duration_ms=${durationMs.toFixed(3)}` +
          ` subjects=${totals.subjects} reads=${totals.reads} sources=${JSON.stringify(sources)}`,
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
