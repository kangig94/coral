import type { TimePort } from '../infra/port-types.js';

/** Reads count returned recovery input records, including repeated reads, never SQLite pages examined. */
export interface RecoveryObservation {
  record(source: string, counts: { subjects?: number; reads?: number }): void;
}

/** Completion is idempotent so an error path cannot duplicate a phase report. */
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
      const durationMs = Number(options.time.monotonicNow() - started) / 1_000_000;
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
