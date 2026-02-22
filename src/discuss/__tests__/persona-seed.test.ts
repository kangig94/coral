import { describe, it, expect } from 'vitest';
import {
  assignTones,
  cartesianProduct,
  createSeededRng,
  eigendecompose,
  hammingDistance,
  seedPersonas,
  MAX_POOL_SIZE,
} from '../persona-seed.js';

describe('seedPersonas', () => {
  it('is reproducible with the same seed', () => {
    const input = {
      controversy_axes: [
        { axis: 'cost', positions: ['high', 'low'] },
        { axis: 'speed', positions: ['fast', 'slow'] },
        { axis: 'risk', positions: ['high', 'low'] },
      ],
      n: 4,
      seed: 12345,
    };

    const first = seedPersonas(input);
    const second = seedPersonas(input);

    expect(first).toEqual(second);
    expect(first.ok && second.ok && first.value.seed_used === second.value.seed_used).toBe(true);
  });

  it('never returns duplicate position combinations within k selected assignments', () => {
    const axes = [
      { axis: 'a', positions: ['0', '1'] },
      { axis: 'b', positions: ['0', '1'] },
      { axis: 'c', positions: ['0', '1'] },
      { axis: 'd', positions: ['0', '1'] },
    ];

    for (let seed = 1; seed <= 1000; seed += 1) {
      const result = seedPersonas({ controversy_axes: axes, n: 4, seed });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const combos = result.value.assignments.map((a) => JSON.stringify(a.positions));
      expect(new Set(combos).size).toBe(combos.length);
    }
  });

  it('has higher mean pairwise Hamming distance than random sampling expectation', () => {
    const axes = [
      { axis: 'a', positions: ['0', '1'] },
      { axis: 'b', positions: ['0', '1'] },
      { axis: 'c', positions: ['0', '1'] },
      { axis: 'd', positions: ['0', '1'] },
    ];
    const axisNames = axes.map((axis) => axis.axis);
    const trials = 400;
    let totalMean = 0;

    for (let seed = 1; seed <= trials; seed += 1) {
      const result = seedPersonas({ controversy_axes: axes, n: 4, seed });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const tuples = result.value.assignments.map((assignment) =>
        axisNames.map((name) => assignment.positions[name]),
      );
      let pairSum = 0;
      let pairs = 0;
      for (let i = 0; i < tuples.length - 1; i += 1) {
        for (let j = i + 1; j < tuples.length; j += 1) {
          pairSum += hammingDistance(tuples[i], tuples[j]);
          pairs += 1;
        }
      }
      totalMean += pairSum / pairs;
    }

    const dppMean = totalMean / trials;
    const expectedRandom = 4 * ((2 * 8 * 8) / (16 * 15));
    expect(dppMean).toBeGreaterThan(expectedRandom);
  });

  it('reuses assignments with shared_position_with when n > pool_size', () => {
    const result = seedPersonas({
      controversy_axes: [
        { axis: 'a', positions: ['x', 'y'] },
        { axis: 'b', positions: ['m', 'n'] },
      ],
      n: 6,
      seed: 77,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.pool_size).toBe(4);
    expect(result.value.assignments).toHaveLength(6);
    const firstFour = result.value.assignments.slice(0, 4).map((a) => JSON.stringify(a.positions));
    expect(new Set(firstFour).size).toBe(4);

    for (const extra of result.value.assignments.slice(4)) {
      expect(typeof extra.shared_position_with).toBe('number');
      expect(extra.shared_position_with).toBeGreaterThanOrEqual(0);
      expect(extra.shared_position_with).toBeLessThan(4);
      const original = result.value.assignments[extra.shared_position_with!];
      expect(extra.positions).toEqual(original.positions);
    }
  });

  it('supports n = 1', () => {
    const result = seedPersonas({
      controversy_axes: [
        { axis: 'x', positions: ['a', 'b'] },
        { axis: 'y', positions: ['c', 'd'] },
      ],
      n: 1,
      seed: 9,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assignments).toHaveLength(1);
    expect(result.value.assignments[0].shared_position_with).toBeUndefined();
  });

  it('works with a single axis where Hamming distance is only 0 or 1', () => {
    const result = seedPersonas({
      controversy_axes: [{ axis: 'stance', positions: ['pro', 'neutral', 'con'] }],
      n: 2,
      seed: 2026,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const first = [result.value.assignments[0].positions.stance];
    const second = [result.value.assignments[1].positions.stance];
    const distance = hammingDistance(first, second);
    expect(distance === 0 || distance === 1).toBe(true);
    expect(distance).toBe(1);
  });

  it('returns pool_degenerate when pool_size=1 and n>1', () => {
    const result = seedPersonas({
      controversy_axes: [
        { axis: 'a', positions: ['only'] },
        { axis: 'b', positions: ['only'] },
      ],
      n: 2,
      seed: 1,
    });

    expect(result).toEqual({
      ok: false,
      error: 'pool_degenerate',
      detail: {
        pool_size: 1,
        requested_n: 2,
        hint: 'All axes have single position',
      },
    });
  });

  it('subsamples pool when exceeding MAX_POOL_SIZE', () => {
    // 7^3 = 343 > 256, n=1 avoids k-DPP (single random pick)
    const axes = Array.from({ length: 3 }, (_, i) => ({
      axis: `ax${i}`,
      positions: Array.from({ length: 7 }, (__, j) => `p${j}`),
    }));
    const result = seedPersonas({ controversy_axes: axes, n: 1, seed: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subsampled).toBe(true);
    expect(result.value.original_pool_size).toBe(343);
    expect(result.value.pool_size).toBe(MAX_POOL_SIZE);
    expect(result.value.assignments).toHaveLength(1);
  });

  it('does not subsample at exactly MAX_POOL_SIZE', () => {
    // 4^4 = 256 = MAX_POOL_SIZE, n=1 avoids k-DPP
    const axes = Array.from({ length: 4 }, (_, i) => ({
      axis: `ax${i}`,
      positions: Array.from({ length: 4 }, (__, j) => `p${j}`),
    }));
    const result = seedPersonas({ controversy_axes: axes, n: 1, seed: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subsampled).toBeUndefined();
    expect(result.value.original_pool_size).toBeUndefined();
    expect(result.value.pool_size).toBe(256);
  });

  it('subsampled results are reproducible with the same seed', () => {
    // 7^3 = 343 > 256, n=1 avoids k-DPP
    const axes = Array.from({ length: 3 }, (_, i) => ({
      axis: `ax${i}`,
      positions: Array.from({ length: 7 }, (__, j) => `p${j}`),
    }));
    const input = { controversy_axes: axes, n: 1, seed: 99 };
    const first = seedPersonas(input);
    const second = seedPersonas(input);

    expect(first).toEqual(second);
  });

  it('returns pool_too_large for extreme inputs without materializing', () => {
    // 10^10 = 10 billion — would OOM if materialized
    const axes = Array.from({ length: 10 }, (_, i) => ({
      axis: `ax${i}`,
      positions: Array.from({ length: 10 }, (__, j) => `p${j}`),
    }));
    const result = seedPersonas({ controversy_axes: axes, n: 4, seed: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('pool_too_large');
    expect(result.detail?.actual_pool_size).toBe(10_000_000_000);
  });

  it('includes persona_seed integer in each assignment', () => {
    const result = seedPersonas({
      controversy_axes: [
        { axis: 'a', positions: ['1', '2', '3'] },
        { axis: 'b', positions: ['1', '2', '3'] },
      ],
      n: 4,
      seed: 7,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const assignment of result.value.assignments) {
      expect(typeof assignment.persona_seed).toBe('number');
      expect(Number.isInteger(assignment.persona_seed)).toBe(true);
      expect(assignment.persona_seed).toBeGreaterThanOrEqual(0);
      expect(assignment.persona_seed).toBeLessThan(0x1_0000_0000);
    }
    // Seeds should be distinct (extremely unlikely to collide for n=4)
    const seeds = result.value.assignments.map((a) => a.persona_seed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('assigns all 8 unique tone combinations for n=8', () => {
    const rng = createSeededRng(123);
    const tones = assignTones(8, rng);
    const unique = new Set(tones.map((tone) => `${tone.formality}|${tone.evidence}|${tone.pace}`));
    expect(unique.size).toBe(8);
  });

  it('uses sigma = sqrt(axes/2)', () => {
    const result = seedPersonas({
      controversy_axes: [
        { axis: 'a', positions: ['0', '1'] },
        { axis: 'b', positions: ['0', '1'] },
        { axis: 'c', positions: ['0', '1'] },
        { axis: 'd', positions: ['0', '1'] },
      ],
      n: 2,
      seed: 7,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sigma_used).toBeCloseTo(Math.sqrt(2), 10);
  });
});

describe('eigendecompose', () => {
  it('accurately decomposes a known symmetric 2x2 matrix', () => {
    const matrix = [
      [2, 1],
      [1, 2],
    ];
    const { eigenvalues, eigenvectors } = eigendecompose(matrix);

    expect(eigenvalues[0]).toBeCloseTo(3, 8);
    expect(eigenvalues[1]).toBeCloseTo(1, 8);
    expect(eigenvalues[0] + eigenvalues[1]).toBeCloseTo(4, 8);

    const col0 = [eigenvectors[0][0], eigenvectors[1][0]];
    const col1 = [eigenvectors[0][1], eigenvectors[1][1]];
    const dot01 = col0[0] * col1[0] + col0[1] * col1[1];
    const norm0 = Math.hypot(col0[0], col0[1]);
    const norm1 = Math.hypot(col1[0], col1[1]);

    expect(dot01).toBeCloseTo(0, 8);
    expect(norm0).toBeCloseTo(1, 8);
    expect(norm1).toBeCloseTo(1, 8);
  });
});

describe('cartesianProduct', () => {
  it('builds all combinations for 3 axes with sizes 2,3,2', () => {
    const result = cartesianProduct([
      { axis: 'x', positions: ['x1', 'x2'] },
      { axis: 'y', positions: ['y1', 'y2', 'y3'] },
      { axis: 'z', positions: ['z1', 'z2'] },
    ]);

    expect(result).toHaveLength(12);
    expect(result).toContainEqual(['x1', 'y1', 'z1']);
    expect(result).toContainEqual(['x2', 'y3', 'z2']);
  });
});
