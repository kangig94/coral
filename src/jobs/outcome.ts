import { z } from 'zod';

import { assertNever } from '../infra/error-format.js';
import { ensureSentence } from '../infra/text.js';
import {
  causeRefSchema,
  renderCauseRefFallback,
  type CauseRef,
  type ResolvableCauseRef,
} from '../causality/cause-ref.js';
import type { JobPhase } from './phase.js';
import { providerBindingFailureReasonSchema } from '../providers/contracts/binding.js';

const abortReasonSchema = z.enum(['signal_abort', 'user_abort', 'queue_shutdown']);
export type AbortReason = z.infer<typeof abortReasonSchema>;

export const externalErrorSchema = z
  .object({
    message: z.string(),
    stack: z.string().optional(),
  })
  .strict();

const jobLifecycleFaultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ghost_launch') }).strict(),
  z.object({ kind: z.literal('wrapper_lost') }).strict(),
  z.object({ kind: z.literal('wrapper_crashed'), cause: externalErrorSchema }).strict(),
  z
    .object({
      kind: z.literal('provider_binding'),
      provider: z.string(),
      reason: providerBindingFailureReasonSchema,
      message: z.string(),
    })
    .strict(),
]);
export type JobLifecycleFault = z.infer<typeof jobLifecycleFaultSchema>;

export const jobLaunchRejectedSchema = z
  .object({
    reason: z.literal('busy'),
    message: z.string(),
    provider: z.string(),
    globalActive: z.number(),
    globalLimit: z.number(),
  })
  .strict();
export type JobLaunchRejected = z.infer<typeof jobLaunchRejectedSchema>;

export const jobProgressFaultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing_launch_record') }).strict(),
  z.object({ kind: z.literal('recovery_parse_failed'), cause: externalErrorSchema }).strict(),
]);
export type JobProgressFault = z.infer<typeof jobProgressFaultSchema>;

export const jobDomainProgressSchema = z
  .object({
    kind: z.literal('domain'),
    stage: z.string(),
    message: z.string(),
    detail: z.unknown().optional(),
  })
  .strict();

export const terminalOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed') }).strict(),
  z.object({ kind: z.literal('aborted'), reason: abortReasonSchema }).strict(),
  z.object({ kind: z.literal('provider_exit'), code: z.number(), note: z.string().optional() }).strict(),
  z.object({ kind: z.literal('failed'), causeRef: causeRefSchema }).strict(),
  z.object({ kind: z.literal('job_fault'), fault: jobLifecycleFaultSchema }).strict(),
]);
export type TerminalOutcome = z.infer<typeof terminalOutcomeSchema>;

// Input variant carries the unresolved `ResolvableCauseRef<Scope>` generic
// rather than the resolved `CauseRef` shape — kept as an explicit type
// because the resolvable form is a typed-graph builder, not a runtime
// schema target.
export type TerminalOutcomeInput<Scope = never> =
  | { kind: 'completed' }
  | { kind: 'aborted'; reason: AbortReason }
  | { kind: 'provider_exit'; code: number; note?: string }
  | { kind: 'failed'; causeRef: ResolvableCauseRef<Scope> }
  | { kind: 'job_fault'; fault: JobLifecycleFault };

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

export function describeLaunchRejected(rejected: JobLaunchRejected): string {
  return `Launch rejected (${rejected.provider} busy: ${rejected.globalActive}/${rejected.globalLimit}).`;
}

export function describeJobProgressFault(fault: JobProgressFault): string {
  switch (fault.kind) {
    case 'missing_launch_record':
      return 'Job status record is missing its launch record; dropping.';
    case 'recovery_parse_failed':
      return appendCauseStack(
        `Provider recovery could not resolve resumed state: ${fault.cause.message}.`,
        fault.cause.stack,
      );
    default:
      return assertNever(fault);
  }
}

/** Append a stack trace to a one-line fault description when present.
 * Causal-chain output stays single-line for the common case; fault paths
 * deliberately surface multi-line stack so production debugging has the
 * trace without needing a separate raw-event query. */
function appendCauseStack(base: string, stack: string | undefined): string {
  return stack ? `${base}\n${stack}` : base;
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
          return appendCauseStack(
            `Provider wrapper crashed: ${outcome.fault.cause.message}.`,
            outcome.fault.cause.stack,
          );
        case 'provider_binding':
          return `Provider binding ${outcome.fault.reason}: ${ensureSentence(outcome.fault.message)}`;
        default:
          return assertNever(outcome.fault);
      }
    default:
      return assertNever(outcome);
  }
}

export const jobAbortedBodySchema = z
  .object({
    reason: abortReasonSchema,
  })
  .strict();

export type JobAbortedBody = z.infer<typeof jobAbortedBodySchema>;
