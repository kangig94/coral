import { z } from 'zod';

/** The phases a job occupies while it can still make progress. SQL predicates bind these rather than restating them. */
export const LIVE_JOB_PHASES = ['queued', 'launching', 'running'] as const;
export const TERMINAL_JOB_PHASES = ['completed', 'error', 'aborted'] as const;

const JOB_PHASES = [...LIVE_JOB_PHASES, ...TERMINAL_JOB_PHASES] as const;
export const jobPhaseSchema = z.enum(JOB_PHASES);

export type JobPhase = (typeof JOB_PHASES)[number];
export type TerminalJobPhase = (typeof TERMINAL_JOB_PHASES)[number];

export function isLivePhase(phase: JobPhase | string): phase is (typeof LIVE_JOB_PHASES)[number] {
  return (LIVE_JOB_PHASES as readonly string[]).includes(phase);
}

export function isTerminalPhase(phase: JobPhase | string): phase is TerminalJobPhase {
  return (TERMINAL_JOB_PHASES as readonly string[]).includes(phase);
}
