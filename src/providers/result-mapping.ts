import type { ProviderResult } from '../shared/types.js';

/**
 * Raw execution result shape common to both Codex and Claude executors.
 * Not all fields are used by mapProviderResultBase — provider-specific fields
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
export function mapProviderResultBase(
  raw: RawExecResult,
): Pick<ProviderResult, 'content' | 'model' | 'durationMs' | 'outcome'> {
  return {
    content: raw.response,
    model: raw.model,
    durationMs: raw.durationMs,
    outcome: raw.aborted ? { kind: 'aborted', reason: 'signal_abort' } : { kind: 'completed' },
  };
}
