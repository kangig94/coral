import { z } from 'zod';

const JOB_PHASES = ['queued', 'launching', 'running', 'completed', 'error', 'aborted'] as const;
export const jobPhaseSchema = z.enum(JOB_PHASES);

export type JobPhase = (typeof JOB_PHASES)[number];

/** The phases a job occupies while it can still make progress. SQL predicates bind these rather than restating them. */
export const LIVE_JOB_PHASES = ['queued', 'launching', 'running'] as const satisfies readonly JobPhase[];

export function isLivePhase(phase: JobPhase | string): phase is (typeof LIVE_JOB_PHASES)[number] {
  return (LIVE_JOB_PHASES as readonly string[]).includes(phase);
}

export function isTerminalPhase(
  phase: JobPhase | string,
): phase is Extract<JobPhase, 'completed' | 'error' | 'aborted'> {
  return phase === 'completed' || phase === 'error' || phase === 'aborted';
}
