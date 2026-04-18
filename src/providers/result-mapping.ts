import type { ProviderTurnResult } from '../shared/types.js';

/**
 * Raw execution result shape common to both Codex and Claude executors.
 * Not all fields are used by mapProviderTurnResultBase — provider-specific fields
 * (exitCode, warnings, costUsd) are applied by each adapter.
 */
export interface RawExecResult {
  response: string;
  model: string;
  durationMs: number;
  aborted?: boolean;
}

/**
 * Map the common fields shared across all provider result constructions.
 * Session policy (conversationRef, nonResumable) and provider-specific fields
 * (exitCode/warnings vs usage) remain in each adapter.
 */
export function mapProviderTurnResultBase(
  raw: RawExecResult,
): Pick<ProviderTurnResult, 'content' | 'model' | 'durationMs' | 'outcome'> {
  return {
    content: raw.response,
    model: raw.model,
    durationMs: raw.durationMs,
    outcome: raw.aborted ? { kind: 'aborted', reason: 'signal_abort' } : { kind: 'completed' },
  };
}
