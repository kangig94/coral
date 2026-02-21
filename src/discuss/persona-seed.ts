/**
 * k-DPP based persona seed assignment — pure functions (auto-seed uses Math.random when seed=null), zero I/O.
 * Algorithm: Kulesza & Taskar (2012), "Determinantal Point Processes for Machine Learning"
 */

import type {
  ControversyAxis,
  ToneAssignment,
  PersonaAssignment,
  PersonaSeedInput,
  PersonaSeedOutput,
  Result,
} from './types.js';

export const MAX_POOL_SIZE = 256;

const EPS = 1e-12;
const UINT32_SIZE = 0x1_0000_0000;

// ── Seeded RNG ────────────────────────────────────────────────────────────────
// mulberry32 PRNG — deterministic, uniform [0, 1)
export function createSeededRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / UINT32_SIZE;
  };
}

// ── Cartesian product ─────────────────────────────────────────────────────────
// Each element: [pos0, pos1, ..., posN] in axis order
export function cartesianProduct(axes: ControversyAxis[]): string[][] {
  if (axes.length === 0) return [[]];

  let product: string[][] = [[]];
  for (const axis of axes) {
    const next: string[][] = [];
    for (const prefix of product) {
      for (const position of axis.positions) {
        next.push([...prefix, position]);
      }
    }
    product = next;
  }
  return product;
}

// ── Hamming distance ──────────────────────────────────────────────────────────
export function hammingDistance(a: string[], b: string[]): number {
  const min = Math.min(a.length, b.length);
  let distance = Math.abs(a.length - b.length);
  for (let i = 0; i < min; i += 1) {
    if (a[i] !== b[i]) distance += 1;
  }
  return distance;
}

// ── Gaussian RBF kernel ───────────────────────────────────────────────────────
// L[i][j] = exp(-hamming(i,j)² / (2σ²)), σ = √(dims/2)
export function buildKernel(pool: string[][], sigma: number): number[][] {
  const size = pool.length;
  const kernel = Array.from({ length: size }, () => Array<number>(size).fill(0));
  const denom = 2 * sigma * sigma;

  for (let i = 0; i < size; i += 1) {
    kernel[i][i] = 1;
    for (let j = i + 1; j < size; j += 1) {
      const distance = hammingDistance(pool[i], pool[j]);
      let value: number;
      if (denom > 0) {
        value = Math.exp(-(distance * distance) / denom);
      } else {
        value = distance === 0 ? 1 : 0;
      }
      kernel[i][j] = value;
      kernel[j][i] = value;
    }
  }
  return kernel;
}

function identityMatrix(size: number): number[][] {
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => (r === c ? 1 : 0)),
  );
}

// ── Jacobi rotation eigendecomposition ───────────────────────────────────────
// Returns eigenvalues + eigenvectors (column vectors) of symmetric matrix
// Verification: sum(eigenvalues) = trace(matrix), V^T * V = I
export function eigendecompose(matrix: number[][]): { eigenvalues: number[]; eigenvectors: number[][] } {
  const n = matrix.length;
  if (n === 0) return { eigenvalues: [], eigenvectors: [] };

  const a = matrix.map((row) => row.slice());
  const v = identityMatrix(n);
  const maxIterations = Math.max(1, n * n * 8);

  for (let iter = 0; iter < maxIterations; iter += 1) {
    let p = 0;
    let q = 1;
    let maxOffDiag = 0;

    for (let i = 0; i < n - 1; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const absValue = Math.abs(a[i][j]);
        if (absValue > maxOffDiag) {
          maxOffDiag = absValue;
          p = i;
          q = j;
        }
      }
    }

    if (maxOffDiag < EPS) break;

    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);

    for (let i = 0; i < n; i += 1) {
      if (i === p || i === q) continue;
      const aip = a[i][p];
      const aiq = a[i][q];
      a[i][p] = cos * aip - sin * aiq;
      a[p][i] = a[i][p];
      a[i][q] = sin * aip + cos * aiq;
      a[q][i] = a[i][q];
    }

    a[p][p] = (cos * cos * app) - (2 * sin * cos * apq) + (sin * sin * aqq);
    a[q][q] = (sin * sin * app) + (2 * sin * cos * apq) + (cos * cos * aqq);
    a[p][q] = 0;
    a[q][p] = 0;

    for (let i = 0; i < n; i += 1) {
      const vip = v[i][p];
      const viq = v[i][q];
      v[i][p] = cos * vip - sin * viq;
      v[i][q] = sin * vip + cos * viq;
    }
  }

  const rawEigenvalues = Array.from({ length: n }, (_, i) => a[i][i]);
  const order = Array.from({ length: n }, (_, i) => i).sort((lhs, rhs) => rawEigenvalues[rhs] - rawEigenvalues[lhs]);
  const eigenvalues = order.map((i) => Math.max(0, rawEigenvalues[i]));
  const eigenvectors = Array.from({ length: n }, () => Array<number>(n).fill(0));

  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      eigenvectors[row][col] = v[row][order[col]];
    }
  }

  return { eigenvalues, eigenvectors };
}

function computeEsp(eigenvalues: number[], k: number): number[][] {
  const n = eigenvalues.length;
  const esp = Array.from({ length: k + 1 }, () => Array<number>(n + 1).fill(0));
  for (let i = 0; i <= n; i += 1) esp[0][i] = 1;

  for (let l = 1; l <= k; l += 1) {
    for (let i = 1; i <= n; i += 1) {
      esp[l][i] = esp[l][i - 1] + (Math.max(0, eigenvalues[i - 1]) * esp[l - 1][i - 1]);
    }
  }
  return esp;
}

function getColumn(matrix: number[][], col: number): number[] {
  return matrix.map((row) => row[col]);
}

function dot(a: number[], b: number[]): number {
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) acc += a[i] * b[i];
  return acc;
}

function normSquared(vec: number[]): number {
  return dot(vec, vec);
}

function orthonormalizeColumns(columns: number[][], forceZeroRow: number): number[][] {
  const basis: number[][] = [];

  for (const column of columns) {
    const v = column.slice();
    v[forceZeroRow] = 0;

    for (const b of basis) {
      const proj = dot(v, b);
      for (let i = 0; i < v.length; i += 1) {
        v[i] -= proj * b[i];
      }
    }

    const lenSq = normSquared(v);
    if (lenSq > EPS) {
      const len = Math.sqrt(lenSq);
      for (let i = 0; i < v.length; i += 1) v[i] /= len;
      v[forceZeroRow] = 0;
      basis.push(v);
    }
  }

  return basis;
}

function weightedSample(weights: number[], rng: () => number): number {
  let total = 0;
  for (const weight of weights) total += weight;

  if (total <= EPS) {
    return weights.findIndex((weight) => weight > 0);
  }

  let threshold = rng() * total;
  for (let i = 0; i < weights.length; i += 1) {
    threshold -= weights[i];
    if (threshold <= 0) return i;
  }

  for (let i = weights.length - 1; i >= 0; i -= 1) {
    if (weights[i] > 0) return i;
  }
  return -1;
}

// ── Exact k-DPP sampling ─────────────────────────────────────────────────────
// Phase A: ESP-based backward sampling to select k eigenvectors
// Phase B: Sequential sampling from selected eigenvector subspace with Gram-Schmidt
export function sampleKDpp(
  eigenvalues: number[],
  eigenvectors: number[][],
  k: number,
  rng: () => number,
): number[] {
  if (k <= 0 || eigenvalues.length === 0) return [];

  const n = eigenvalues.length;
  const effectiveK = Math.min(k, n);
  const esp = computeEsp(eigenvalues, effectiveK);

  const selectedEigenvectors: number[] = [];
  let remaining = effectiveK;
  for (let i = n; i >= 1 && remaining > 0; i -= 1) {
    if (i === remaining) {
      selectedEigenvectors.push(i - 1);
      remaining -= 1;
      continue;
    }

    const denom = esp[remaining][i];
    const numerator = Math.max(0, eigenvalues[i - 1]) * esp[remaining - 1][i - 1];
    const probability = denom > EPS ? Math.min(1, Math.max(0, numerator / denom)) : 0;

    if (rng() < probability) {
      selectedEigenvectors.push(i - 1);
      remaining -= 1;
    }
  }
  if (remaining !== 0) throw new Error('k-DPP eigenvector selection failed');

  let basis = selectedEigenvectors.map((col) => getColumn(eigenvectors, col));
  const selectedItems: number[] = [];
  const selectedItemSet = new Set<number>();

  while (basis.length > 0 && selectedItems.length < effectiveK) {
    const probabilities = Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      if (selectedItemSet.has(i)) continue;
      let projectionNorm = 0;
      for (const col of basis) projectionNorm += col[i] * col[i];
      probabilities[i] = Math.max(0, projectionNorm);
    }

    const chosen = weightedSample(probabilities, rng);
    if (chosen < 0) throw new Error('k-DPP item sampling failed');

    selectedItems.push(chosen);
    selectedItemSet.add(chosen);

    const pivotIndex = basis.findIndex((col) => Math.abs(col[chosen]) > EPS);
    if (pivotIndex < 0) throw new Error('k-DPP Gram-Schmidt pivot not found');

    const pivot = basis[pivotIndex];
    const reduced: number[][] = [];
    for (let i = 0; i < basis.length; i += 1) {
      if (i === pivotIndex) continue;
      const col = basis[i];
      const factor = col[chosen] / pivot[chosen];
      const nextCol = new Array<number>(n);
      for (let r = 0; r < n; r += 1) {
        nextCol[r] = col[r] - (factor * pivot[r]);
      }
      nextCol[chosen] = 0;
      reduced.push(nextCol);
    }

    basis = orthonormalizeColumns(reduced, chosen);
  }
  if (selectedItems.length !== effectiveK) throw new Error('k-DPP sampled item count mismatch');

  return selectedItems;
}

// ── Tone assignment ───────────────────────────────────────────────────────────
export const TONE_AXES = {
  formality: ['formal', 'conversational'] as const,
  evidence: ['data-driven', 'narrative'] as const,
  pace: ['concise', 'detailed'] as const,
} as const;

function shuffleInPlace<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// Returns n tone assignments via seeded shuffle (cycles if n > 8)
export function assignTones(n: number, rng: () => number): ToneAssignment[] {
  const allCombinations: ToneAssignment[] = [];

  for (const formality of TONE_AXES.formality) {
    for (const evidence of TONE_AXES.evidence) {
      for (const pace of TONE_AXES.pace) {
        allCombinations.push({ formality, evidence, pace });
      }
    }
  }

  const shuffled = shuffleInPlace(allCombinations, rng);
  return Array.from({ length: n }, (_, i) => shuffled[i % shuffled.length]);
}

function buildPositionRecord(axes: ControversyAxis[], tuple: string[]): Record<string, string> {
  const positions: Record<string, string> = {};
  for (let i = 0; i < axes.length; i += 1) {
    positions[axes[i].axis] = tuple[i];
  }
  return positions;
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

// ── Main function ─────────────────────────────────────────────────────────────
export function seedPersonas(input: PersonaSeedInput): Result<PersonaSeedOutput> {
  const seedUsed = input.seed == null
    ? Math.floor(Math.random() * UINT32_SIZE) >>> 0
    : (input.seed >>> 0);
  const rng = createSeededRng(seedUsed);
  const pool = cartesianProduct(input.controversy_axes);

  if (pool.length > MAX_POOL_SIZE) {
    return {
      ok: false,
      error: 'pool_too_large',
      detail: {
        actual_pool_size: pool.length,
        max_pool_size: MAX_POOL_SIZE,
        hint: 'Reduce axes or positions',
      },
    };
  }

  if (pool.length === 1 && input.n > 1) {
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

  const uniqueCount = Math.min(input.n, pool.length);
  let selectedPoolIndexes: number[];

  if (uniqueCount === 0) {
    selectedPoolIndexes = [];
  } else if (uniqueCount === 1) {
    selectedPoolIndexes = [Math.floor(rng() * pool.length)];
  } else if (uniqueCount === pool.length) {
    selectedPoolIndexes = Array.from({ length: pool.length }, (_, i) => i);
  } else {
    const kernel = buildKernel(pool, sigma);
    const { eigenvalues, eigenvectors } = eigendecompose(kernel);
    selectedPoolIndexes = sampleKDpp(eigenvalues, eigenvectors, uniqueCount, rng);
  }
  if (selectedPoolIndexes.length !== uniqueCount) throw new Error('k-DPP sample size mismatch');

  // Reuse: when n > pool_size, pick extras by largest hamming distance from selected set
  const reuseOrder = rankReuseSlots(selectedPoolIndexes, pool);
  const tones = assignTones(input.n, rng);
  const assignments: PersonaAssignment[] = [];

  for (let i = 0; i < uniqueCount; i += 1) {
    assignments.push({
      positions: buildPositionRecord(input.controversy_axes, pool[selectedPoolIndexes[i]]),
      tone: tones[i],
    });
  }

  for (let i = uniqueCount; i < input.n; i += 1) {
    const sourceSlot = reuseOrder[(i - uniqueCount) % reuseOrder.length];
    assignments.push({
      positions: buildPositionRecord(input.controversy_axes, pool[selectedPoolIndexes[sourceSlot]]),
      tone: tones[i],
      shared_position_with: sourceSlot,
    });
  }

  return {
    ok: true,
    value: {
      seed_used: seedUsed,
      sigma_used: sigma,
      pool_size: pool.length,
      assignments,
    },
  };
}
