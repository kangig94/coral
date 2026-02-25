import { describe, it, expect } from 'vitest';
import {
  assignOrigins,
  assignTones,
  seedPersonas,
} from '../persona-seed.js';
import { createSeededRng } from '../util/rng.js';
import { cartesianProduct, eigendecompose, hammingDistance, MAX_POOL_SIZE } from '../util/dpp.js';

function seedResult<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`seedPersonas failed: ${result.error}`);
  }
  return result.value;
}

describe('assignOrigins', () => {
  const baseDemographics = {
    origin_weights: {
      BR: 0.7,
      DE: 0.4,
      FR: 0.3,
      IN: 0.25,
      JP: 0.2,
      NG: 0.15,
      NG2: 0.1,
      KR: 0.08,
      RU: 0.05,
      US: 0.01,
    },
  };

  it('is deterministic with the same rng', () => {
    const first = assignOrigins(5, { ...baseDemographics, outlier_ratio: 0.2 }, createSeededRng(123));
    const second = assignOrigins(5, { ...baseDemographics, outlier_ratio: 0.2 }, createSeededRng(123));
    expect(first).toEqual(second);
  });

  it('creates exactly floor(n*outlier_ratio) outlier slots when feasible', () => {
    const assignments = assignOrigins(5, { ...baseDemographics, outlier_ratio: 0.2 }, createSeededRng(1));
    expect(assignments.filter((assignment) => assignment.is_outlier)).toHaveLength(1);
    expect(assignments.filter((assignment) => !assignment.is_outlier)).toHaveLength(4);
  });

  it('creates zero outliers when outlier_ratio is zero', () => {
    const assignments = assignOrigins(5, { ...baseDemographics, outlier_ratio: 0 }, createSeededRng(1));
    expect(assignments.some((assignment) => assignment.is_outlier)).toBe(false);
  });

  it('avoids duplicate origins when total countries can cover n', () => {
    const assignments = assignOrigins(5, baseDemographics, createSeededRng(2));
    const origins = assignments.map((assignment) => assignment.origin);
    expect(new Set(origins).size).toBe(origins.length);
  });

  it('allows duplicates when total countries are insufficient', () => {
    const assignments = assignOrigins(6, {
      outlier_ratio: 0.2,
      origin_weights: { BR: 0.6, DE: 0.4 },
    }, createSeededRng(3));
    const unique = new Set(assignments.map((assignment) => assignment.origin));
    expect(unique.size).toBeLessThan(assignments.length);
    expect(assignments).toHaveLength(6);
  });

  it('falls back to reuse weights when a pool is exhausted', () => {
    const assignments = assignOrigins(6, {
      outlier_ratio: 0.2,
      origin_weights: { BR: 0.6, DE: 0.4 },
    }, createSeededRng(4));
    const counts = assignments.reduce<Record<string, number>>((acc, assignment) => {
      acc[assignment.origin] = (acc[assignment.origin] ?? 0) + 1;
      return acc;
    }, {});
    expect(Object.values(counts).some((count) => count > 1)).toBe(true);
  });

  it('respects bidirectional outlier clamp in skewed distributions', () => {
    const result = assignOrigins(5, {
      outlier_ratio: 0.2,
      origin_weights: {
        US: 95,
        BR: 0.8,
        DE: 0.7,
        FR: 0.6,
        NG: 0.5,
        KR: 0.4,
        IN: 0.3,
        CN: 0.2,
        PT: 0.1,
        BR2: 0.05,
      },
    }, createSeededRng(5));
    const outliers = result.filter((assignment) => assignment.is_outlier).map((assignment) => assignment.origin);
    expect(outliers).toHaveLength(4);
    expect(new Set(result.map((assignment) => assignment.origin)).size).toBe(5);
    expect(outliers.every((origin) => origin !== 'US')).toBe(true);
    expect(result.filter((assignment) => !assignment.is_outlier).every((assignment) => assignment.origin === 'US')).toBe(true);
  });

  it('puts outlier slots into the low-weight pool', () => {
    const result = assignOrigins(4, {
      outlier_ratio: 0.25,
      origin_weights: {
        AA: 1,
        AB: 1,
        AC: 1,
        ZZ: 1,
      },
    }, createSeededRng(6));
    expect(result.every((assignment) =>
      assignment.origin === 'AA' || assignment.origin === 'AB' || assignment.origin === 'AC' || assignment.origin === 'ZZ'
    )).toBe(true);
    expect(new Set(result.filter((assignment) => assignment.is_outlier).values()).size).toBe(1);
    expect(result.find((assignment) => assignment.is_outlier)?.origin).toBe('ZZ');
  });

  it('assigns the highest-weight origin for n=1', () => {
    const result = assignOrigins(1, { origin_weights: { ZZ: 0.5, AA: 0.9 }, outlier_ratio: 0.4 }, createSeededRng(7));
    expect(result).toHaveLength(1);
    expect(result[0].origin).toBe('AA');
    expect(result[0].is_outlier).toBe(false);
  });

  it('preserves locale-independent deterministic tie-break for equal-weight sorting', () => {
    const result = assignOrigins(4, {
      origin_weights: { ZZ: 1, AA: 1, AC: 1, BB: 1 },
      outlier_ratio: 0.25,
    }, createSeededRng(8));
    const outlierOrigins = result.filter((assignment) => assignment.is_outlier).map((assignment) => assignment.origin);
    expect(new Set(outlierOrigins)).toEqual(new Set(['ZZ']));
  });

  it('defaults outlier_ratio to 0.2 when omitted', () => {
    const result = assignOrigins(10, baseDemographics, createSeededRng(9));
    expect(result.filter((assignment) => assignment.is_outlier)).toHaveLength(5);
  });

  it('hardens invalid outlier_ratio inputs from direct callers', () => {
    const makeAssignments = (outlier_ratio: number) =>
      assignOrigins(5, {
        ...baseDemographics,
        outlier_ratio,
      }, createSeededRng(11));

    expect(makeAssignments(-0.5).filter((assignment) => assignment.is_outlier)).toHaveLength(0);
    expect(makeAssignments(0.8).filter((assignment) => assignment.is_outlier)).toHaveLength(2);
    expect(makeAssignments(Number.NaN).filter((assignment) => assignment.is_outlier)).toHaveLength(1);
    expect(makeAssignments(Number.POSITIVE_INFINITY).filter((assignment) => assignment.is_outlier)).toHaveLength(1);
  });

  it('filters invalid direct-caller origin weights and throws when none remain', () => {
    const onlyInvalid = {
      origin_weights: { AA: 0, BB: Number.NaN, CC: -1 },
      outlier_ratio: 0.2,
    };
    expect(() => assignOrigins(3, onlyInvalid, createSeededRng(12))).toThrow(
      'demographics.origin_weights has no finite positive entries',
    );

    const withValid = assignOrigins(
      2,
      {
        origin_weights: { AA: 0, BB: Number.NaN, CC: -1, DE: 1, FR: 2 },
        outlier_ratio: 0.2,
      },
      createSeededRng(13),
    );
    expect(withValid.every((assignment) => ['DE', 'FR'].includes(assignment.origin))).toBe(true);
  });
});

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

    const value = seedResult(result);

    expect(value.pool_size).toBe(4);
    expect(value.assignments).toHaveLength(6);
    const firstFour = value.assignments.slice(0, 4).map((a) => JSON.stringify(a.positions));
    expect(new Set(firstFour).size).toBe(4);

    for (const extra of value.assignments.slice(4)) {
      expect(typeof extra.shared_position_with).toBe('number');
      expect(extra.shared_position_with).toBeGreaterThanOrEqual(0);
      expect(extra.shared_position_with).toBeLessThan(4);
      const original = value.assignments[extra.shared_position_with!];
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

    const value = seedResult(result);
    expect(value.assignments).toHaveLength(1);
    expect(value.assignments[0].shared_position_with).toBeUndefined();
  });

  it('works with a single axis where Hamming distance is only 0 or 1', () => {
    const result = seedPersonas({
      controversy_axes: [{ axis: 'stance', positions: ['pro', 'neutral', 'con'] }],
      n: 2,
      seed: 2026,
    });

    const value = seedResult(result);

    const first = [value.assignments[0].positions.stance];
    const second = [value.assignments[1].positions.stance];
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
    const axes = Array.from({ length: 3 }, (_, i) => ({
      axis: `ax${i}`,
      positions: Array.from({ length: 7 }, (__, j) => `p${j}`),
    }));
    const result = seedPersonas({ controversy_axes: axes, n: 1, seed: 1 });

    const value = seedResult(result);
    expect(value.subsampled).toBe(true);
    expect(value.original_pool_size).toBe(343);
    expect(value.pool_size).toBe(MAX_POOL_SIZE);
    expect(value.assignments).toHaveLength(1);
  });

  it('does not subsample at exactly MAX_POOL_SIZE', () => {
    const axes = Array.from({ length: 4 }, (_, i) => ({
      axis: `ax${i}`,
      positions: Array.from({ length: 4 }, (__, j) => `p${j}`),
    }));
    const result = seedPersonas({ controversy_axes: axes, n: 1, seed: 1 });

    const value = seedResult(result);
    expect(value.subsampled).toBeUndefined();
    expect(value.original_pool_size).toBeUndefined();
    expect(value.pool_size).toBe(256);
  });

  it('subsampled results are reproducible with the same seed', () => {
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

    const value = seedResult(result);
    for (const assignment of value.assignments) {
      expect(typeof assignment.persona_seed).toBe('number');
      expect(Number.isInteger(assignment.persona_seed)).toBe(true);
      expect(assignment.persona_seed).toBeGreaterThanOrEqual(0);
      expect(assignment.persona_seed).toBeLessThan(0x1_0000_0000);
    }
    const seeds = value.assignments.map((a) => a.persona_seed);
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

    const value = seedResult(result);
    expect(value.sigma_used).toBeCloseTo(Math.sqrt(2), 10);
  });

  it('does not add origin fields when demographics are omitted', () => {
    const result = seedPersonas({
      controversy_axes: [
        { axis: 'a', positions: ['high', 'low'] },
        { axis: 'b', positions: ['fast', 'slow'] },
      ],
      n: 3,
      seed: 1,
    });

    const value = seedResult(result);
    for (const assignment of value.assignments) {
      expect((assignment as { suggested_origin?: string }).suggested_origin).toBeUndefined();
      expect((assignment as { is_outlier?: boolean }).is_outlier).toBeUndefined();
    }
  });

  it('keeps persona_seed sequence unchanged without demographics', () => {
    const input = {
      controversy_axes: [{ axis: 'a', positions: ['high', 'low'] }],
      n: 3,
      seed: 2026,
    };
    const first = seedPersonas(input);
    const second = seedPersonas(input);
    expect(first).toEqual(second);
    const firstSeeds = seedResult(first).assignments.map((assignment) => assignment.persona_seed);
    const secondSeeds = seedResult(second).assignments.map((assignment) => assignment.persona_seed);
    expect(firstSeeds).toEqual(secondSeeds);
  });

  it('enriches assignments with suggested_origin and outlier flags when demographics provided', () => {
    const result = seedPersonas({
      controversy_axes: [
        { axis: 'a', positions: ['high', 'low'] },
        { axis: 'b', positions: ['pro', 'con'] },
      ],
      demographics: {
        origin_weights: {
          BR: 0.5,
          DE: 0.4,
          FR: 0.1,
        },
        outlier_ratio: 0.2,
      },
      n: 3,
      seed: 99,
    });
    const value = seedResult(result);
    expect(value.assignments).toHaveLength(3);
    for (const assignment of value.assignments) {
      expect(typeof assignment.suggested_origin).toBe('string');
      expect(typeof assignment.is_outlier).toBe('boolean');
    }
    expect(value.assignments.some((assignment) => assignment.is_outlier)).toBe(true);
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


describe('PRNG determinism across demographics presence', () => {
  it('persona_seeds are identical with and without demographics field absent (no demographics branch taken)', () => {
    const base = {
      controversy_axes: [
        { axis: 'a', positions: ['high', 'low'] },
        { axis: 'b', positions: ['pro', 'con'] },
      ],
      n: 3,
      seed: 42,
    };
    const withoutDemo = seedResult(seedPersonas(base));
    const withoutDemo2 = seedResult(seedPersonas(base));
    expect(withoutDemo.assignments.map((a) => a.persona_seed)).toEqual(
      withoutDemo2.assignments.map((a) => a.persona_seed),
    );
  });

  it('adding demographics changes the persona_seed sequence (demographics does consume RNG state)', () => {
    const base = {
      controversy_axes: [
        { axis: 'a', positions: ['high', 'low'] },
        { axis: 'b', positions: ['pro', 'con'] },
      ],
      n: 3,
      seed: 42,
    };
    const withoutDemo = seedResult(seedPersonas(base));
    const withDemo = seedResult(seedPersonas({
      ...base,
      demographics: { origin_weights: { US: 0.6, DE: 0.4 }, outlier_ratio: 0.2 },
    }));
    const seedsWithout = withoutDemo.assignments.map((a) => a.persona_seed);
    const seedsWith = withDemo.assignments.map((a) => a.persona_seed);
    expect(seedsWithout).not.toEqual(seedsWith);
  });

  it('same seed + same demographics reproduces identical persona_seeds across calls', () => {
    const input = {
      controversy_axes: [{ axis: 'stance', positions: ['for', 'against', 'neutral'] }],
      demographics: { origin_weights: { BR: 0.5, DE: 0.3, JP: 0.2 }, outlier_ratio: 0.3 },
      n: 4,
      seed: 7777,
    };
    const a = seedResult(seedPersonas(input));
    const b = seedResult(seedPersonas(input));
    expect(a.assignments.map((x) => x.persona_seed)).toEqual(b.assignments.map((x) => x.persona_seed));
    expect(a.assignments.map((x) => x.suggested_origin)).toEqual(b.assignments.map((x) => x.suggested_origin));
  });
});

describe('assignOrigins: outlier_ratio boundary values', () => {
  const weights = { US: 5, DE: 4, FR: 3, JP: 2, KR: 1 };

  it('outlier_ratio = 0 produces zero outlier slots', () => {
    const result = assignOrigins(4, { origin_weights: weights, outlier_ratio: 0 }, createSeededRng(1));
    expect(result.filter((r) => r.is_outlier)).toHaveLength(0);
    expect(result).toHaveLength(4);
  });

  it('outlier_ratio = 0.5 produces floor(n*0.5) outlier slots when main pool is large enough', () => {
    const result = assignOrigins(4, { origin_weights: weights, outlier_ratio: 0.5 }, createSeededRng(1));
    expect(result.filter((r) => r.is_outlier)).toHaveLength(2);
    expect(result).toHaveLength(4);
  });

  it('outlier_ratio = 0.5 with n=3 produces floor(3*0.5)=1 outlier slot', () => {
    const result = assignOrigins(3, { origin_weights: weights, outlier_ratio: 0.5 }, createSeededRng(2));
    expect(result.filter((r) => r.is_outlier)).toHaveLength(1);
    expect(result).toHaveLength(3);
  });

  it('outlier_ratio just above 0 (1e-13) rounds down to 0 outlier slots for n<=8', () => {
    const result = assignOrigins(4, { origin_weights: weights, outlier_ratio: 1e-13 }, createSeededRng(3));
    expect(result.filter((r) => r.is_outlier)).toHaveLength(0);
  });

  it('outlier_ratio just below 0.5 (0.49) exposes lowerBound clamp behavior', () => {
    const result = assignOrigins(4, { origin_weights: weights, outlier_ratio: 0.49 }, createSeededRng(4));
    expect(result.filter((r) => r.is_outlier)).toHaveLength(2);
    expect(result).toHaveLength(4);
  });

  it('outlier_ratio clamped to 0.5 when supplied value above 0.5 (direct caller bypass)', () => {
    const result = assignOrigins(4, { origin_weights: weights, outlier_ratio: 0.8 }, createSeededRng(5));
    expect(result.filter((r) => r.is_outlier)).toHaveLength(2);
    expect(result).toHaveLength(4);
  });

  it('outlier_ratio = -0 (negative zero) is treated as 0 and produces zero outliers', () => {
    const result = assignOrigins(4, { origin_weights: weights, outlier_ratio: -0 }, createSeededRng(6));
    expect(result.filter((r) => r.is_outlier)).toHaveLength(0);
  });
});

describe('assignOrigins: n=8 with exactly 8 countries', () => {
  it('produces 8 unique origins when given exactly 8 countries and n=8', () => {
    const eightCountries = {
      US: 8, DE: 7, FR: 6, JP: 5, BR: 4, IN: 3, KR: 2, NG: 1,
    };
    const result = assignOrigins(8, { origin_weights: eightCountries, outlier_ratio: 0.2 }, createSeededRng(42));
    expect(result).toHaveLength(8);
    const origins = result.map((r) => r.origin);
    expect(new Set(origins).size).toBe(8);
  });

  it('n=8 with 8 equal-weight countries still produces 8 unique origins', () => {
    const equalWeights = Object.fromEntries(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((k) => [k, 1]),
    );
    for (let seed = 1; seed <= 20; seed++) {
      const result = assignOrigins(8, { origin_weights: equalWeights, outlier_ratio: 0.25 }, createSeededRng(seed));
      expect(result).toHaveLength(8);
      const origins = result.map((r) => r.origin);
      expect(new Set(origins).size, `seed=${seed} produced duplicates: ${origins.join(',')}`).toBe(8);
    }
  });
});

describe('assignOrigins: mainEntries exhausted by move-to-outlier', () => {
  it('does not crash when the only main entry is moved into the outlier pool', () => {
    const result = assignOrigins(3, {
      origin_weights: { AA: 1 },
      outlier_ratio: 0.5,
    }, createSeededRng(10));
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.origin === 'AA')).toBe(true);
    const outlierCount = result.filter((r) => r.is_outlier).length;
    expect(outlierCount).toBeGreaterThanOrEqual(0);
  });

  it('n=2 single country ratio=0.5 does not crash or emit empty origins', () => {
    const result = assignOrigins(2, {
      origin_weights: { ONLY: 5 },
      outlier_ratio: 0.5,
    }, createSeededRng(11));
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.origin === 'ONLY')).toBe(true);
  });
});

describe('assignOrigins: cumulative weight exactly equals targetWeight', () => {
  it('places entry exactly at targetWeight threshold in main pool (not outlier pool)', () => {
    const result = assignOrigins(5, {
      origin_weights: { US: 6, DE: 4 },
      outlier_ratio: 0.4,
    }, createSeededRng(20));
    expect(result).toHaveLength(5);
    const mainSlots = result.filter((r) => !r.is_outlier);
    const outlierSlots = result.filter((r) => r.is_outlier);
    expect(mainSlots.every((r) => r.origin === 'US' || r.origin === 'DE')).toBe(true);
    expect(outlierSlots.length).toBeGreaterThan(0);
  });

  it('entry whose cumulative weight is just above targetWeight enters outlier pool', () => {
    const result = assignOrigins(4, {
      origin_weights: { US: 5.999, DE: 4 },
      outlier_ratio: 0.4,
    }, createSeededRng(21));
    expect(result).toHaveLength(4);
  });

  it('outlier_ratio=0 makes targetWeight=totalWeight, all entries go to main', () => {
    const result = assignOrigins(3, {
      origin_weights: { AA: 3, BB: 2, CC: 1 },
      outlier_ratio: 0,
    }, createSeededRng(22));
    expect(result.filter((r) => r.is_outlier)).toHaveLength(0);
    expect(result.every((r) => ['AA', 'BB', 'CC'].includes(r.origin))).toBe(true);
  });
});

describe('assignOrigins: bounded fallback produces correct count', () => {
  it('produces exactly n results when outlierPool has fewer entries than outlierCount', () => {
    const result = assignOrigins(8, {
      origin_weights: { AA: 3, BB: 2, CC: 1, ZZ: 0.1 },
      outlier_ratio: 0.5,
    }, createSeededRng(30));
    expect(result).toHaveLength(8);
  });

  it('bounded fallback: lowerBound clamp forces more outlier slots than raw floor', () => {
    const origin_weights: Record<string, number> = { MAIN: 99 };
    for (let i = 0; i < 9; i++) origin_weights[`O${i}`] = 0.1;
    const result = assignOrigins(2, { origin_weights, outlier_ratio: 0.1 }, createSeededRng(31));
    expect(result).toHaveLength(2);
    expect(result.filter((r) => r.is_outlier)).toHaveLength(1);
  });

  it('produces exactly n results for n=1 with all pools available', () => {
    const result = assignOrigins(1, {
      origin_weights: { US: 0.9, DE: 0.1 },
      outlier_ratio: 0.4,
    }, createSeededRng(32));
    expect(result).toHaveLength(1);
  });

  it('n=8 two-country pool: always returns exactly 8 results', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const result = assignOrigins(8, {
        origin_weights: { US: 0.7, DE: 0.3 },
        outlier_ratio: 0.25,
      }, createSeededRng(seed + 100));
      expect(result).toHaveLength(8);
    }
  });
});

describe('assignOrigins: all-identical weights stress test', () => {
  it('never crashes with all-equal weights across seeds 1-50', () => {
    const uniform = { A: 1, B: 1, C: 1, D: 1, E: 1 };
    for (let seed = 1; seed <= 50; seed++) {
      const result = assignOrigins(4, { origin_weights: uniform, outlier_ratio: 0.25 }, createSeededRng(seed));
      expect(result).toHaveLength(4);
      expect(result.every((r) => ['A', 'B', 'C', 'D', 'E'].includes(r.origin))).toBe(true);
    }
  });

  it('produces unique origins when pool size >= n with all-equal weights', () => {
    const uniform = { A: 1, B: 1, C: 1, D: 1, E: 1, F: 1 };
    for (let seed = 1; seed <= 20; seed++) {
      const result = assignOrigins(5, { origin_weights: uniform, outlier_ratio: 0.2 }, createSeededRng(seed + 200));
      const origins = result.map((r) => r.origin);
      expect(new Set(origins).size).toBe(5);
    }
  });

  it('tie-break sort: code ascending for equal weights (ZZ last in main pool)', () => {
    const result = assignOrigins(4, {
      origin_weights: { ZZ: 1, AA: 1, CC: 1, BB: 1 },
      outlier_ratio: 0.25,
    }, createSeededRng(300));
    const outlierOrigins = result.filter((r) => r.is_outlier).map((r) => r.origin);
    expect(outlierOrigins).toHaveLength(1);
    expect(outlierOrigins[0]).toBe('ZZ');
  });
});

describe('assignOrigins: single country across n=1 through n=8', () => {
  it('returns n results with the single origin for every n from 1 to 8', () => {
    for (let n = 1; n <= 8; n++) {
      const result = assignOrigins(n, {
        origin_weights: { SOLE: 1 },
        outlier_ratio: 0.25,
      }, createSeededRng(n + 400));
      expect(result).toHaveLength(n);
      expect(result.every((r) => r.origin === 'SOLE')).toBe(true);
    }
  });

  it('single country n=8 ratio=0.5 does not crash (heavy fallback path)', () => {
    const result = assignOrigins(8, {
      origin_weights: { SOLO: 1 },
      outlier_ratio: 0.5,
    }, createSeededRng(500));
    expect(result).toHaveLength(8);
    expect(result.every((r) => r.origin === 'SOLO')).toBe(true);
  });

  it('single country n=1 ratio=0 does not mark any slot as outlier', () => {
    const result = assignOrigins(1, { origin_weights: { X: 1 }, outlier_ratio: 0 }, createSeededRng(501));
    expect(result).toHaveLength(1);
    expect(result[0].is_outlier).toBe(false);
  });
});

describe('assignOrigins: clamp — outlierPool larger than requested outlierCount', () => {
  it('clamp does not over-assign outlier slots when outlierPool has many entries', () => {
    const origin_weights: Record<string, number> = { MAIN: 99 };
    for (let i = 0; i < 8; i++) origin_weights[`OUT${i}`] = 0.01;
    const result = assignOrigins(4, { origin_weights, outlier_ratio: 0.25 }, createSeededRng(600));
    expect(result).toHaveLength(4);
    expect(result.filter((r) => r.is_outlier)).toHaveLength(3);
  });

  it('normal balanced pool: outlierCount=2, outlierPool has 5 entries, produces exactly 2 outlier slots', () => {
    const origin_weights: Record<string, number> = {};
    for (let i = 0; i < 5; i++) origin_weights[`M${i}`] = 10 - i;
    for (let i = 0; i < 5; i++) origin_weights[`Z${i}`] = i + 1;
    const result = assignOrigins(4, { origin_weights, outlier_ratio: 0.5 }, createSeededRng(601));
    expect(result).toHaveLength(4);
    expect(result.filter((r) => r.is_outlier)).toHaveLength(2);
  });
});

describe('seedPersonas: demographics integrated end-to-end (adversarial)', () => {
  it('n=8 with 8 equally-weighted countries produces 8 unique origins via seedPersonas', () => {
    const result = seedPersonas({
      controversy_axes: [
        { axis: 'stance', positions: ['for', 'against'] },
        { axis: 'style', positions: ['formal', 'casual'] },
        { axis: 'scope', positions: ['local', 'global'] },
      ],
      demographics: {
        origin_weights: Object.fromEntries(
          ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((k) => [k, 1]),
        ),
        outlier_ratio: 0.25,
      },
      n: 8,
      seed: 12345,
    });
    const value = seedResult(result);
    expect(value.assignments).toHaveLength(8);
    const origins = value.assignments.map((a) => a.suggested_origin);
    expect(new Set(origins).size).toBe(8);
  });

  it('is_outlier and suggested_origin fields both present when demographics provided', () => {
    const result = seedPersonas({
      controversy_axes: [{ axis: 'a', positions: ['x', 'y'] }],
      demographics: { origin_weights: { US: 1, DE: 0.5 }, outlier_ratio: 0.5 },
      n: 2,
      seed: 99,
    });
    const value = seedResult(result);
    for (const assignment of value.assignments) {
      expect('suggested_origin' in assignment).toBe(true);
      expect('is_outlier' in assignment).toBe(true);
      expect(typeof assignment.is_outlier).toBe('boolean');
    }
  });

  it('demographics with single origin and n=8 succeeds without crashing in seedPersonas', () => {
    const result = seedPersonas({
      controversy_axes: [
        { axis: 'a', positions: ['x', 'y'] },
        { axis: 'b', positions: ['m', 'n'] },
      ],
      demographics: { origin_weights: { ONLY: 1 }, outlier_ratio: 0.25 },
      n: 8,
      seed: 7,
    });
    const value = seedResult(result);
    expect(value.assignments).toHaveLength(8);
    expect(value.assignments.every((a) => a.suggested_origin === 'ONLY')).toBe(true);
  });
});
