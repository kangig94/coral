/**
 * k-DPP based persona seed assignment - pure functions, zero I/O.
 * Algorithm: Kulesza & Taskar (2012), "Determinantal Point Processes for Machine Learning"
 */

import type {
  ControversyAxis,
  DemographicsInput,
  ToneAssignment,
  PersonaAssignment,
  PersonaSeedInput,
  PersonaSeedOutput,
  Result,
} from '../session-types.js';
import { createSeededRng, drawUInt32, shuffleInPlace, weightedSample } from './rng.js';
import { cartesianProduct, hammingDistance, buildKernel, eigendecompose, sampleKDpp, MAX_POOL_SIZE } from './dpp.js';

export const TONE_AXES = {
  formality: ['formal', 'conversational'] as const,
  evidence: ['data-driven', 'narrative'] as const,
  pace: ['concise', 'detailed'] as const,
} as const;

export function assignTones(n: number, rng: () => number): ToneAssignment[] {
  const toneCombinations: ToneAssignment[] = [];

  for (const formality of TONE_AXES.formality) {
    for (const evidence of TONE_AXES.evidence) {
      for (const pace of TONE_AXES.pace) {
        toneCombinations.push({ formality, evidence, pace });
      }
    }
  }

  const shuffled = shuffleInPlace(toneCombinations, rng);
  return Array.from({ length: n }, (_, i) => shuffled[i % shuffled.length]);
}

function buildPositionRecord(axes: ControversyAxis[], tuple: string[]): Record<string, string> {
  const positions: Record<string, string> = {};
  for (let i = 0; i < axes.length; i += 1) {
    const axis = axes[i];
    positions[axis.axis] = tuple[i];
  }
  return positions;
}

type OriginWeight = [string, number];
type OriginPool = {
  entries: OriginWeight[];
  weights: number[];
  originalWeights: number[];
  dedupEnabled: boolean;
};

function createOriginPool(entries: OriginWeight[]): OriginPool {
  const weights = entries.map(([, weight]) => weight);
  return {
    entries,
    weights: [...weights],
    originalWeights: [...weights],
    dedupEnabled: true,
  };
}

function sortOriginWeights(entries: OriginWeight[]): OriginWeight[] {
  return [...entries].sort(compareOriginWeights);
}

function compareOriginWeights(lhs: OriginWeight, rhs: OriginWeight): number {
  const weightDelta = rhs[1] - lhs[1];
  if (weightDelta !== 0) {
    return weightDelta;
  }

  if (lhs[0] < rhs[0]) {
    return -1;
  }
  return lhs[0] > rhs[0] ? 1 : 0;
}

function allFinitePositiveEntries(originWeights: Record<string, number>): OriginWeight[] {
  return Object.entries(originWeights).filter(([, weight]) => Number.isFinite(weight) && weight > 0);
}

function pickSlots(outlierCount: number, total: number, rng: () => number): Set<number> {
  const slots = Array.from({ length: total }, (_, i) => i);
  shuffleInPlace(slots, rng);
  return new Set(slots.slice(0, outlierCount));
}

function sampleOriginFromPool(pool: OriginPool, assignedOrigins: Set<string>, rng: () => number): string {
  if (pool.entries.length === 0) return '';

  const MAX_SAMPLE_ATTEMPTS = 100;
  for (let attempt = 0; attempt < MAX_SAMPLE_ATTEMPTS; attempt++) {
    if (pool.dedupEnabled && pool.entries.every(([origin]) => assignedOrigins.has(origin))) {
      pool.dedupEnabled = false;
      pool.weights = [...pool.originalWeights];
    }

    const activeWeights = pool.dedupEnabled ? pool.weights : pool.originalWeights;
    const index = weightedSample(activeWeights, rng);
    if (index < 0) {
      pool.dedupEnabled = false;
      pool.weights = [...pool.originalWeights];
      continue;
    }

    const [origin] = pool.entries[index];
    if (!pool.dedupEnabled || !assignedOrigins.has(origin)) {
      if (pool.dedupEnabled) {
        pool.weights[index] = 0;
      }
      return origin;
    }

    pool.weights[index] = 0;
    if (pool.dedupEnabled && pool.weights.every((weight) => weight <= 0)) {
      pool.dedupEnabled = false;
      pool.weights = [...pool.originalWeights];
    }
  }

  // Deterministic default if weighted sampling fails to converge.
  return pool.entries[0][0];
}

export function assignOrigins(
  n: number,
  demographics: DemographicsInput,
  rng: () => number,
): { origin: string; is_outlier: boolean }[] {
  const raw = demographics.outlier_ratio ?? 0.2;
  const outlierRatio = Number.isFinite(raw) ? Math.max(0, Math.min(0.5, raw)) : 0.2;
  const validEntries = sortOriginWeights(allFinitePositiveEntries(demographics.origin_weights));
  if (validEntries.length === 0) {
    throw new Error('demographics.origin_weights has no finite positive entries');
  }

  const outlierCount = Math.floor(n * outlierRatio);
  const totalWeight = validEntries.reduce((acc, [, weight]) => acc + weight, 0);
  const targetWeight = (1 - outlierRatio) * totalWeight;

  let splitIndex = 0;
  let runningWeight = 0;
  while (splitIndex < validEntries.length && runningWeight < targetWeight) {
    runningWeight += validEntries[splitIndex][1];
    splitIndex += 1;
  }

  const mainEntries = validEntries.slice(0, splitIndex);
  const outlierEntries = validEntries.slice(splitIndex);

  if (outlierCount > 0 && outlierEntries.length === 0 && mainEntries.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by mainEntries.length > 0
    outlierEntries.push(mainEntries.pop()!);
  }

  const upperBound = Math.min(outlierEntries.length, n - 1);
  const lowerBound = mainEntries.length > 0 ? Math.max(0, n - mainEntries.length) : 0;
  const effectiveOutlierCount = Math.min(Math.max(outlierCount, lowerBound), upperBound);
  const outlierSlots = pickSlots(effectiveOutlierCount, n, rng);

  const mainPool = createOriginPool(mainEntries);
  const outlierPool = createOriginPool(outlierEntries);
  const assignedOrigins = new Set<string>();
  const assigned: { origin: string; is_outlier: boolean }[] = [];

  for (let i = 0; i < n; i += 1) {
    const isOutlierSlot = outlierSlots.has(i);
    const primaryPool = isOutlierSlot ? outlierPool : mainPool;
    const fallbackPool = isOutlierSlot ? mainPool : outlierPool;
    const chosen = sampleOriginFromPool(
      primaryPool.entries.length > 0 ? primaryPool : fallbackPool,
      assignedOrigins,
      rng,
    );

    if (chosen !== '') {
      assignedOrigins.add(chosen);
    }

    assigned.push({ origin: chosen, is_outlier: isOutlierSlot });
  }

  return assigned;
}

function rankReuseSlots(selectedPoolIndexes: number[], pool: string[][]): number[] {
  if (selectedPoolIndexes.length <= 1) return [0];

  const scores = selectedPoolIndexes.map((poolIndex, slotIndex) => {
    let score = 0;
    for (const otherPoolIndex of selectedPoolIndexes) {
      if (otherPoolIndex === poolIndex) continue;
      score += hammingDistance(pool[poolIndex], pool[otherPoolIndex]);
    }
    return { slotIndex, score };
  });

  scores.sort((lhs, rhs) => rhs.score - lhs.score || lhs.slotIndex - rhs.slotIndex);
  return scores.map((entry) => entry.slotIndex);
}

export function seedPersonas(input: PersonaSeedInput): Result<PersonaSeedOutput> {
  const seedUsed = input.seed >>> 0;
  const rng = createSeededRng(seedUsed);
  const requestedCount = input.n;

  const estimatedPoolSize = input.controversy_axes.reduce((acc, a) => acc * a.positions.length, 1);
  if (estimatedPoolSize > 100_000) {
    return {
      ok: false,
      error: 'pool_too_large',
      detail: {
        actual_pool_size: estimatedPoolSize,
        max_pool_size: 100_000,
        hint: 'Reduce axes or positions — cartesian product is too large to materialize',
      },
    };
  }

  let pool = cartesianProduct(input.controversy_axes);
  const originalPoolSize = pool.length;

  if (pool.length > MAX_POOL_SIZE) {
    pool = shuffleInPlace([...pool], rng).slice(0, MAX_POOL_SIZE);
  }

  if (pool.length === 1 && requestedCount > 1) {
    return {
      ok: false,
      error: 'pool_degenerate',
      detail: {
        pool_size: 1,
        requested_n: input.n,
        hint: 'All axes have single position',
      },
    };
  }

  const sigma = Math.sqrt(input.controversy_axes.length / 2);

  const uniqueCount = Math.min(requestedCount, pool.length);
  let selectedPoolIndexes: number[];

  switch (uniqueCount) {
    case 0:
      selectedPoolIndexes = [];
      break;
    case 1:
      selectedPoolIndexes = [Math.floor(rng() * pool.length)];
      break;
    case pool.length:
      selectedPoolIndexes = Array.from({ length: pool.length }, (_, i) => i);
      break;
    default: {
      const kernel = buildKernel(pool, sigma);
      const { eigenvalues, eigenvectors } = eigendecompose(kernel);
      selectedPoolIndexes = sampleKDpp(eigenvalues, eigenvectors, uniqueCount, rng);
      break;
    }
  }
  if (selectedPoolIndexes.length !== uniqueCount) throw new Error('k-DPP sample size mismatch');

  const reuseOrder = rankReuseSlots(selectedPoolIndexes, pool);
  const tones = assignTones(requestedCount, rng);
  const origins = input.demographics ? assignOrigins(requestedCount, input.demographics, rng) : null;
  const assignments: PersonaAssignment[] = [];

  for (let i = 0; i < uniqueCount; i += 1) {
    assignments.push({
      positions: buildPositionRecord(input.controversy_axes, pool[selectedPoolIndexes[i]]),
      tone: tones[i],
      persona_seed: drawUInt32(rng),
      ...(origins ? { suggested_origin: origins[i].origin, is_outlier: origins[i].is_outlier } : {}),
    });
  }

  for (let i = uniqueCount; i < requestedCount; i += 1) {
    const sourceSlot = reuseOrder[(i - uniqueCount) % reuseOrder.length];
    assignments.push({
      positions: buildPositionRecord(input.controversy_axes, pool[selectedPoolIndexes[sourceSlot]]),
      tone: tones[i],
      persona_seed: drawUInt32(rng),
      shared_position_with: sourceSlot,
      ...(origins ? { suggested_origin: origins[i].origin, is_outlier: origins[i].is_outlier } : {}),
    });
  }

  return {
    ok: true,
    value: {
      seed_used: seedUsed,
      sigma_used: sigma,
      pool_size: pool.length,
      ...(originalPoolSize > MAX_POOL_SIZE && {
        subsampled: true,
        original_pool_size: originalPoolSize,
      }),
      assignments,
    },
  };
}
