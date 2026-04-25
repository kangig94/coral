import { z } from 'zod';

import { assertNever } from '../infra/error-format.js';
import { causeRefSchema, type CauseRef } from '../causality/cause-ref.js';
import type { JobPhase } from './phase.js';

export type AbortReason = 'signal_abort' | 'user_abort' | 'queue_shutdown';

export interface ExternalError {
  message: string;
  stack?: string;
}

export type JobLifecycleFault =
  | { kind: 'ghost_launch' }
  | { kind: 'wrapper_lost' }
  | { kind: 'wrapper_crashed'; cause: ExternalError };

export type JobLaunchRejected = {
  reason: 'busy';
  message: string;
  provider: string;
  globalActive: number;
  globalLimit: number;
};

export type JobProgressFault =
  | { kind: 'missing_launch_record' }
  | { kind: 'recovery_parse_failed'; cause: ExternalError };

export type JobDomainProgress = {
  kind: 'domain';
  stage: string;
  message: string;
  detail?: unknown;
  ts?: string;
};

export type TerminalOutcome =
  | { kind: 'completed' }
  | { kind: 'aborted'; reason: AbortReason }
  | { kind: 'provider_exit'; code: number; note?: string }
  | { kind: 'failed'; causeRef: CauseRef }
  | { kind: 'job_fault'; fault: JobLifecycleFault };

export const abortReasonSchema = z.enum(['signal_abort', 'user_abort', 'queue_shutdown']);

export const externalErrorSchema = z
  .object({
    message: z.string(),
    stack: z.string().optional(),
  })
  .strict();

export const jobLifecycleFaultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ghost_launch') }).strict(),
  z.object({ kind: z.literal('wrapper_lost') }).strict(),
  z.object({ kind: z.literal('wrapper_crashed'), cause: externalErrorSchema }).strict(),
]);

export const jobLaunchRejectedSchema = z
  .object({
    reason: z.literal('busy'),
    message: z.string(),
    provider: z.string(),
    globalActive: z.number(),
    globalLimit: z.number(),
  })
  .strict();

export const jobProgressFaultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing_launch_record') }).strict(),
  z.object({ kind: z.literal('recovery_parse_failed'), cause: externalErrorSchema }).strict(),
]);

export const jobDomainProgressSchema = z
  .object({
    kind: z.literal('domain'),
    stage: z.string(),
    message: z.string(),
    detail: z.unknown().optional(),
    ts: z.string().optional(),
  })
  .strict();

export const terminalOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed') }).strict(),
  z.object({ kind: z.literal('aborted'), reason: abortReasonSchema }).strict(),
  z.object({ kind: z.literal('provider_exit'), code: z.number(), note: z.string().optional() }).strict(),
  z.object({ kind: z.literal('failed'), causeRef: causeRefSchema }).strict(),
  z.object({ kind: z.literal('job_fault'), fault: jobLifecycleFaultSchema }).strict(),
]);

export function phaseForOutcome(outcome: TerminalOutcome): Extract<JobPhase, 'completed' | 'error' | 'aborted'> {
  switch (outcome.kind) {
    case 'completed':
      return 'completed';
    case 'provider_exit':
      return outcome.code === 0 ? 'completed' : 'error';
    case 'aborted':
      return 'aborted';
    case 'failed':
    case 'job_fault':
      return 'error';
    default:
      return assertNever(outcome);
  }
}

function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function renderCauseRefFallback(ref: CauseRef): string {
  return `${ref.stream.kind}/${ref.stream.id}#${ref.seq}`;
}

export function describeLaunchRejected(rejected: JobLaunchRejected): string {
  return `Launch rejected (${rejected.provider} busy: ${rejected.globalActive}/${rejected.globalLimit}).`;
}

export function describeJobProgressFault(fault: JobProgressFault): string {
  switch (fault.kind) {
    case 'missing_launch_record':
      return 'Job status record is missing its launch record; dropping.';
    case 'recovery_parse_failed':
      return `Provider recovery could not parse resumed state: ${fault.cause.message}.`;
    default:
      return assertNever(fault);
  }
}

export function describeJobDomainProgress(progress: JobDomainProgress): string {
  return progress.message;
}

export function describeTerminalOutcome(
  outcome: TerminalOutcome,
  options: { describeCauseRef?: (ref: CauseRef) => string } = {},
): string {
  switch (outcome.kind) {
    case 'completed':
      return 'Completed.';
    case 'aborted':
      return `Aborted: ${outcome.reason}.`;
    case 'provider_exit': {
      const base = `Provider exited ${outcome.code}.`;
      return outcome.note === undefined ? base : `Provider exited ${outcome.code}: ${ensureSentence(outcome.note)}`;
    }
    case 'failed': {
      const rendered = options.describeCauseRef?.(outcome.causeRef) ?? renderCauseRefFallback(outcome.causeRef);
      return `Failed: ${rendered}`;
    }
    case 'job_fault':
      switch (outcome.fault.kind) {
        case 'ghost_launch':
          return 'Launch recorded but no provider process was observed.';
        case 'wrapper_lost':
          return 'Provider wrapper exited without reporting an outcome.';
        case 'wrapper_crashed':
          return `Provider wrapper crashed: ${outcome.fault.cause.message}.`;
        default:
          return assertNever(outcome.fault);
      }
    default:
      return assertNever(outcome);
  }
}
