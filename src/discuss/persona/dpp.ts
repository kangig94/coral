import type { ControversyAxis } from '../session-types.js';
import { weightedSample } from './rng.js';

export const MAX_POOL_SIZE = 256;
const EPS = 1e-12;

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

export function hammingDistance(a: string[], b: string[]): number {
  const min = Math.min(a.length, b.length);
  let distance = Math.abs(a.length - b.length);
  for (let i = 0; i < min; i += 1) {
    if (a[i] !== b[i]) distance += 1;
  }
  return distance;
}

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
  return Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => (r === c ? 1 : 0)));
}

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

    a[p][p] = cos * cos * app - 2 * sin * cos * apq + sin * sin * aqq;
    a[q][q] = sin * sin * app + 2 * sin * cos * apq + cos * cos * aqq;
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
  const eigenvalues: number[] = [];
  for (const index of order) {
    eigenvalues.push(Math.max(0, rawEigenvalues[index]));
  }
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
  esp[0].fill(1);

  for (let l = 1; l <= k; l += 1) {
    for (let i = 1; i <= n; i += 1) {
      esp[l][i] = esp[l][i - 1] + Math.max(0, eigenvalues[i - 1]) * esp[l - 1][i - 1];
    }
  }
  return esp;
}

function getColumn(matrix: number[][], col: number): number[] {
  const column: number[] = [];
  for (const row of matrix) {
    column.push(row[col]);
  }
  return column;
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
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

export function sampleKDpp(eigenvalues: number[], eigenvectors: number[][], k: number, rng: () => number): number[] {
  if (k <= 0 || eigenvalues.length === 0) return [];

  const n = eigenvalues.length;
  const effectiveK = Math.min(k, n);
  const esp = computeEsp(eigenvalues, effectiveK);

  const selectedEigenvectorIndexes: number[] = [];
  let remaining = effectiveK;
  for (let i = n; i >= 1 && remaining > 0; i -= 1) {
    if (i === remaining) {
      selectedEigenvectorIndexes.push(i - 1);
      remaining -= 1;
      continue;
    }

    const denom = esp[remaining][i];
    const eigenvalue = Math.max(0, eigenvalues[i - 1]);
    const numerator = eigenvalue * esp[remaining - 1][i - 1];
    const probability = denom > EPS ? Math.min(1, Math.max(0, numerator / denom)) : 0;

    if (rng() < probability) {
      selectedEigenvectorIndexes.push(i - 1);
      remaining -= 1;
    }
  }
  if (remaining !== 0) throw new Error('k-DPP eigenvector selection failed');

  let basis: number[][] = [];
  for (const col of selectedEigenvectorIndexes) {
    basis.push(getColumn(eigenvectors, col));
  }
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
        nextCol[r] = col[r] - factor * pivot[r];
      }
      nextCol[chosen] = 0;
      reduced.push(nextCol);
    }

    basis = orthonormalizeColumns(reduced, chosen);
  }
  if (selectedItems.length !== effectiveK) throw new Error('k-DPP sampled item count mismatch');

  return selectedItems;
}
