import type { EffortLevel } from './contract.js';
import { backendLog } from '../infra/backend-log.js';

const VALID_EFFORT_LEVELS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const EFFORT_VALUES_HINT = 'low, medium, high, xhigh, max, ultra';
export const ABSTRACT_MODEL_TIERS: Readonly<Record<string, number>> = Object.freeze({
  haiku: 1,
  sonnet: 2,
  opus: 3,
  fable: 4,
});

/**
 * Validate an effort string supplied directly on a request (a contract input).
 * Throws on a non-empty invalid value so the caller error surfaces at
 * ingress/launch rather than mid-job.
 */
function parseEffortLevel(value: string | undefined, label: string): EffortLevel | undefined {
  if (value === undefined) return undefined;
  if (!VALID_EFFORT_LEVELS.has(value)) {
    throw new Error(`Invalid ${label}="${value}". Valid values: ${EFFORT_VALUES_HINT}`);
  }
  return value as EffortLevel;
}

/**
 * Validate an effort string read from forwarded CORAL_* env. Unlike the
 * request-body path, a typo in a provider-specific effort override in a caller's
 * settings must not fail the provider turn — the value now travels per request,
 * so a mistake would otherwise kill every job. Warn once and ignore it so the
 * fallback chain reaches the provider default.
 */
function parseEnvEffortLevel(value: string | undefined, label: string): EffortLevel | undefined {
  if (value === undefined) return undefined;
  if (!VALID_EFFORT_LEVELS.has(value)) {
    backendLog.warn(`Ignoring invalid ${label}="${value}" (valid: ${EFFORT_VALUES_HINT}); using default effort.`);
    return undefined;
  }
  return value as EffortLevel;
}

/** Each provider adapter then applies its own env-aware fallback chain at the boundary. */
export function resolveEffort(requestEffort: string | undefined): EffortLevel | undefined {
  return parseEffortLevel(requestEffort, 'effort');
}

export function resolveProviderEffort(
  request: { effort?: EffortLevel | undefined },
  providerEnvKey: string,
  env: Record<string, string>,
): EffortLevel | undefined {
  return (
    request.effort ??
    parseEnvEffortLevel(env[providerEnvKey], providerEnvKey) ??
    parseEnvEffortLevel(env.CORAL_EFFORT, 'CORAL_EFFORT')
  );
}

/**
 * Resolve a requested model against an optional tier cap. An abstract tier is kept as requested
 * unless it ranks above the cap, in which case the cap replaces it; any other name is a concrete
 * model id and passes through uncapped.
 */
export function resolveModelTier(model: string | undefined, cap?: string): string | undefined {
  if (model === undefined) return undefined;
  const modelRank = ABSTRACT_MODEL_TIERS[model];
  if (modelRank === undefined) return model;
  if (cap !== undefined) {
    const capRank = ABSTRACT_MODEL_TIERS[cap];
    if (capRank !== undefined && modelRank > capRank) return cap;
  }
  return model;
}
