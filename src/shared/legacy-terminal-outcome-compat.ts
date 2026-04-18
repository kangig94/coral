import { z } from 'zod';

import { assertNever } from './utils.js';

export type LegacyAbortReason = 'signal_abort' | 'user_abort' | 'queue_shutdown';
export type LegacyProviderName = 'claude' | 'codex';
type LegacyAppServerTrigger = 'restart' | 'handoff';
type LegacyAppServerContinuity =
  | 'verified'
  | 'missing'
  | 'unavailable'
  | 'pre_checkpoint_empty'
  | 'pre_checkpoint_preserved';

export interface LegacyExternalError {
  message: string;
  stack?: string;
}

export type LegacyCoralFault =
  | { kind: 'stale_status_schema' }
  | { kind: 'ghost_launch' }
  | { kind: 'wrapper_lost' }
  | { kind: 'wrapper_crashed'; cause: LegacyExternalError }
  | { kind: 'recovery_parse_failed'; cause: LegacyExternalError }
  | {
      kind: 'launch_rejected';
      reason: 'busy';
      message: string;
      provider: string;
      globalActive: number;
      globalLimit: number;
    }
  | {
      kind: 'app_server_interrupted';
      trigger: LegacyAppServerTrigger;
      continuity: LegacyAppServerContinuity;
    }
  | {
      kind: 'workflow_atom_failed';
      step?: number;
      atom?: string;
      cause: LegacyExternalError;
    }
  | { kind: 'workflow_aborted' }
  | {
      kind: 'adapter_output_unparseable';
      provider: LegacyProviderName;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      parseError: string;
    }
  | {
      kind: 'provider_session_unavailable';
      provider: LegacyProviderName;
      note: string;
    }
  | {
      kind: 'provider_request_failed';
      provider: LegacyProviderName;
      message: string;
    };

// Retires in Phase 6 when providers emit domain events directly.
export type LegacyTerminalOutcome =
  | { kind: 'completed' }
  | { kind: 'aborted'; reason: LegacyAbortReason }
  | { kind: 'provider_exit'; code: number; note?: string }
  | { kind: 'legacy_fault'; fault: LegacyCoralFault };

export type RecoveryFaultCompat = LegacyCoralFault;
export type ProviderTurnOutcomeCompat = LegacyTerminalOutcome;

export const legacyAbortReasonSchema = z.enum(['signal_abort', 'user_abort', 'queue_shutdown']);
export const legacyProviderNameSchema = z.enum(['claude', 'codex']);

export const legacyExternalErrorSchema = z
  .object({
    message: z.string(),
    stack: z.string().optional(),
  })
  .strict();

export const legacyCoralFaultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stale_status_schema') }).strict(),
  z.object({ kind: z.literal('ghost_launch') }).strict(),
  z.object({ kind: z.literal('wrapper_lost') }).strict(),
  z.object({ kind: z.literal('wrapper_crashed'), cause: legacyExternalErrorSchema }).strict(),
  z.object({ kind: z.literal('recovery_parse_failed'), cause: legacyExternalErrorSchema }).strict(),
  z
    .object({
      kind: z.literal('launch_rejected'),
      reason: z.literal('busy'),
      message: z.string(),
      provider: z.string(),
      globalActive: z.number(),
      globalLimit: z.number(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('app_server_interrupted'),
      trigger: z.enum(['restart', 'handoff']),
      continuity: z.enum([
        'verified',
        'missing',
        'unavailable',
        'pre_checkpoint_empty',
        'pre_checkpoint_preserved',
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('workflow_atom_failed'),
      step: z.number().optional(),
      atom: z.string().optional(),
      cause: legacyExternalErrorSchema,
    })
    .strict(),
  z.object({ kind: z.literal('workflow_aborted') }).strict(),
  z
    .object({
      kind: z.literal('adapter_output_unparseable'),
      provider: legacyProviderNameSchema,
      exitCode: z.number().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      parseError: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('provider_session_unavailable'),
      provider: legacyProviderNameSchema,
      note: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('provider_request_failed'),
      provider: legacyProviderNameSchema,
      message: z.string(),
    })
    .strict(),
]);

export const legacyTerminalOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed') }).strict(),
  z.object({ kind: z.literal('aborted'), reason: legacyAbortReasonSchema }).strict(),
  z.object({ kind: z.literal('provider_exit'), code: z.number(), note: z.string().optional() }).strict(),
  z.object({ kind: z.literal('legacy_fault'), fault: legacyCoralFaultSchema }).strict(),
]);

export function legacyWrapperCrashedFault(message: string): LegacyCoralFault {
  return {
    kind: 'wrapper_crashed',
    cause: { message },
  };
}

function providerDisplayName(provider: LegacyProviderName): string {
  switch (provider) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    default:
      return assertNever(provider);
  }
}

function continuitySentenceFragment(continuity: LegacyAppServerContinuity): string {
  switch (continuity) {
    case 'verified':
      return 'continuity verified';
    case 'missing':
      return 'continuity missing';
    case 'unavailable':
      return 'continuity unavailable';
    case 'pre_checkpoint_empty':
      return 'no resumable conversation was available';
    case 'pre_checkpoint_preserved':
      return 'existing conversation reference was preserved';
    default:
      return assertNever(continuity);
  }
}

function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function describeLegacyCoralFault(fault: LegacyCoralFault): string {
  switch (fault.kind) {
    case 'stale_status_schema':
      return 'Job status record uses an incompatible schema; dropping.';
    case 'ghost_launch':
      return 'Launch recorded but no provider process was observed.';
    case 'wrapper_lost':
      return 'Provider wrapper exited without reporting an outcome.';
    case 'wrapper_crashed':
      return `Provider wrapper crashed: ${fault.cause.message}.`;
    case 'recovery_parse_failed':
      return `Provider recovery could not parse resumed state: ${fault.cause.message}.`;
    case 'launch_rejected':
      return `Launch rejected (${fault.provider} busy: ${fault.globalActive}/${fault.globalLimit}).`;
    case 'app_server_interrupted': {
      const triggerText =
        fault.trigger === 'restart'
          ? 'App-server restarted during the turn'
          : 'App-server handoff occurred during the turn';
      return `${triggerText}; ${continuitySentenceFragment(fault.continuity)}.`;
    }
    case 'workflow_atom_failed':
      if (fault.step !== undefined && fault.atom !== undefined) {
        return `Workflow step ${fault.step} atom '${fault.atom}' failed: ${fault.cause.message}.`;
      }
      return `Workflow failed: ${fault.cause.message}.`;
    case 'workflow_aborted':
      return 'Workflow aborted.';
    case 'adapter_output_unparseable': {
      const provider = providerDisplayName(fault.provider);
      const exit = fault.exitCode === null ? 'unknown' : String(fault.exitCode);
      return `${provider} produced unparseable output (exit ${exit}): ${fault.parseError}.`;
    }
    case 'provider_session_unavailable':
      return `${providerDisplayName(fault.provider)} session unavailable: ${ensureSentence(fault.note)}`;
    case 'provider_request_failed': {
      const provider = providerDisplayName(fault.provider);
      const message = fault.message.trim();
      if (!message) {
        return `${provider} turn failed.`;
      }
      if (message.toLowerCase().startsWith(provider.toLowerCase())) {
        return ensureSentence(message);
      }
      return `${provider} turn failed: ${ensureSentence(message)}`;
    }
    default:
      return assertNever(fault);
  }
}
