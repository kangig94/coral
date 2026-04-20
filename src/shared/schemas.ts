import { z } from 'zod';
import type { EffortLevel } from '../providers/protocol.js';

export type { EffortLevel } from '../providers/protocol.js';

const VALID_EFFORT_LEVELS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);
export const ABSTRACT_MODEL_TIERS: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3 };

/**
 * Validate an effort string. Returns undefined when the input is undefined.
 * Throws with a user-friendly label when the string is non-empty but invalid.
 */
export function parseEffortLevel(value: string | undefined, label: string): EffortLevel | undefined {
  if (value === undefined) return undefined;
  if (!VALID_EFFORT_LEVELS.has(value)) {
    throw new Error(`Invalid ${label}="${value}". Valid values: low, medium, high, xhigh, max`);
  }
  return value as EffortLevel;
}

/**
 * Validate the effort level supplied directly on a request. Returns undefined
 * when the caller did not specify one — each provider adapter then applies
 * its own env-aware fallback chain at the boundary.
 */
export function resolveEffort(requestEffort: string | undefined): EffortLevel | undefined {
  return parseEffortLevel(requestEffort, 'effort');
}

export function resolveProviderEffort(
  request: { effort?: EffortLevel | undefined },
  providerEnvKey: string,
  env: Record<string, string>,
): EffortLevel | undefined {
  return (
    request.effort
    ?? parseEffortLevel(env[providerEnvKey], providerEnvKey)
    ?? parseEffortLevel(env.CORAL_EFFORT, 'CORAL_EFFORT')
  );
}

/** Resolve abstract model tiers. Returns undefined for abstract tiers (provider decides). */
export function resolveModelTier(model: string | undefined, cap?: string): string | undefined {
  if (model === undefined) return undefined;
  const modelRank = ABSTRACT_MODEL_TIERS[model];
  if (modelRank === undefined) return model;
  if (cap !== undefined) {
    const capRank = ABSTRACT_MODEL_TIERS[cap];
    if (capRank !== undefined && modelRank > capRank) return cap;
  }
  return undefined;
}

/** Maximum serialized emitted CallToolResult body length for optional content embedding. */
export const MAX_INLINE = 10_000;

/**
 * Wait tool input schema — accepts a list of jobIds to monitor.
 */
export const waitInputSchema = z
  .object({
    jobs: z.array(z.string()).min(1, 'At least one job required'),
    timeout_seconds: z.number().min(1).max(1200).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type WaitInput = z.infer<typeof waitInputSchema>;

/**
 * Abort tool input schema — accepts a list of jobIds to abort.
 */
export const abortInputSchema = z.object({
  jobs: z.array(z.string().min(1)).min(1, 'At least one job required'),
});

export type AbortInput = z.infer<typeof abortInputSchema>;
