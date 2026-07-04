import { USAGE_TOKEN_FIELDS, type UsageSummary } from '../../providers/contract.js';

const TOKEN_BUCKET_LABELS = {
  inputTokens: 'input',
  cacheReadTokens: 'cache-read',
  cacheWriteTokens: 'cache-write',
  outputTokens: 'output',
} as const satisfies Record<(typeof USAGE_TOKEN_FIELDS)[number], string>;

const TOKEN_BUCKETS = USAGE_TOKEN_FIELDS.map((field) => [TOKEN_BUCKET_LABELS[field], field] as const);

export type UsageSegmentOptions = {
  verbose?: boolean;
  cacheReadAnnotation?: 'cached' | 'full';
};

function missingCostCount(usage: UsageSummary): number {
  return usage.jobsWithoutCostData ?? 0;
}

export function formatCost(costUsd: number | undefined): string | undefined {
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) {
    return undefined;
  }

  if (costUsd > 0 && costUsd < 0.01) {
    return '<$0.01';
  }

  return `$${costUsd.toFixed(2)}`;
}

function formatCostSegment(usage: UsageSummary): string | undefined {
  const cost = formatCost(usage.costUsd);
  if (cost === undefined) {
    return undefined;
  }

  return missingCostCount(usage) > 0 ? `${cost}+` : cost;
}

function formatMissingCostNote(usage: UsageSummary): string | undefined {
  const count = missingCostCount(usage);
  return count > 0 ? `(+${count} ${count === 1 ? 'job' : 'jobs'} without cost data)` : undefined;
}

export function formatTokens(tokens: number): string {
  const roundedTokens = Math.max(0, Math.round(tokens));
  if (roundedTokens < 1_000) {
    return String(roundedTokens);
  }

  if (roundedTokens < 1_000_000) {
    return `${(roundedTokens / 1_000).toFixed(1)}K`;
  }

  return `${(roundedTokens / 1_000_000).toFixed(1)}M`;
}

export function totalUsageTokens(usage: UsageSummary): number {
  return TOKEN_BUCKETS.reduce((total, [, field]) => total + (usage[field] ?? 0), 0);
}

export function cachedPercent(usage: UsageSummary): number | undefined {
  const totalTokens = totalUsageTokens(usage);
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  if (totalTokens <= 0 || cacheReadTokens <= 0) {
    return undefined;
  }

  const ratio = cacheReadTokens / totalTokens;
  if (ratio < 0.5) {
    return undefined;
  }

  return Math.min(100, Math.round(ratio * 100));
}

function cacheReadAnnotation(usage: UsageSummary, mode: UsageSegmentOptions['cacheReadAnnotation']): string {
  const percent = cachedPercent(usage);
  if (percent === undefined) {
    return '';
  }

  return mode === 'full' ? ` (${percent}%, billed ~0.1×)` : ` (${percent}% cached)`;
}

function hasTokenUsage(usage: UsageSummary): boolean {
  return totalUsageTokens(usage) > 0;
}

function formatLightUsageSegment(usage: UsageSummary): string | undefined {
  const totalTokens = totalUsageTokens(usage);
  const costSegment = formatCostSegment(usage);
  if (totalTokens <= 0 && costSegment === undefined) {
    return undefined;
  }

  return [
    costSegment,
    totalTokens <= 0 ? undefined : `${formatTokens(totalTokens)} tokens${cacheReadAnnotation(usage, undefined)}`,
    formatMissingCostNote(usage),
  ]
    .filter((segment): segment is string => segment !== undefined)
    .join(' · ');
}

function formatVerboseUsageSegment(usage: UsageSummary, options: UsageSegmentOptions = {}): string | undefined {
  const costSegment = formatCostSegment(usage);
  if (!hasTokenUsage(usage) && costSegment === undefined) {
    return undefined;
  }

  const tokenSegments = TOKEN_BUCKETS.flatMap(([label, field]) => {
    const tokens = usage[field];
    if (tokens === undefined) {
      return [];
    }

    const annotation = field === 'cacheReadTokens' ? cacheReadAnnotation(usage, options.cacheReadAnnotation) : '';
    return [`${label} ${formatTokens(tokens)}${annotation}`];
  });

  return [costSegment, ...tokenSegments, formatMissingCostNote(usage)]
    .filter((segment): segment is string => segment !== undefined)
    .join(' · ');
}

export function formatUsageSegment(
  usage: UsageSummary | undefined,
  options: UsageSegmentOptions = {},
): string | undefined {
  if (usage === undefined) {
    return undefined;
  }

  return options.verbose === true ? formatVerboseUsageSegment(usage, options) : formatLightUsageSegment(usage);
}
