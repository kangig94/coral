import { z } from 'zod';

export const JOB_PHASES = ['queued', 'launching', 'running', 'completed', 'error', 'aborted'] as const;
export const jobPhaseSchema = z.enum(JOB_PHASES);

export type JobPhase = (typeof JOB_PHASES)[number];

export function isLivePhase(phase: JobPhase | string): phase is Extract<JobPhase, 'queued' | 'launching' | 'running'> {
  return phase === 'queued' || phase === 'launching' || phase === 'running';
}

export function isTerminalPhase(
  phase: JobPhase | string,
): phase is Extract<JobPhase, 'completed' | 'error' | 'aborted'> {
  return phase === 'completed' || phase === 'error' || phase === 'aborted';
}
