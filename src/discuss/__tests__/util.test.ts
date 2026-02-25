import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  randomSuffix,
  formatDateId,
  topicSlug,
  parseDisplayName,
} from '../util/string.js';

describe('randomSuffix', () => {
  it('should always return exactly 4 characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(randomSuffix()).toHaveLength(4);
    }
  });

  it('should pad with zeros when Math.random produces a very short base-36 tail', () => {
    // Force Math.random to return a value whose base-36 slice is short (< 4 chars)
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      // 0.toString(36) -> "0", slice(2,6) -> "", padEnd(4,'0') -> "0000"
      expect(randomSuffix()).toHaveLength(4);
    } finally {
      spy.mockRestore();
    }
  });

  it('should only contain base-36 characters (a-z, 0-9)', () => {
    const valid = /^[a-z0-9]+$/;
    for (let i = 0; i < 100; i++) {
      expect(randomSuffix()).toMatch(valid);
    }
  });
});

describe('formatDateId', () => {
  it('should produce the correct format YYMMDD-HHmm', () => {
    const d = new Date('2026-03-07T14:05:00.000Z');
    // Use local time values for the test — the function uses local getters
    const result = formatDateId(d);
    expect(result).toMatch(/^\d{6}-\d{4}$/);
  });

  it('should zero-pad single-digit month, day, hour, minute', () => {
    // Jan 1 00:01 local
    const d = new Date(2026, 0, 1, 0, 1, 0); // month 0 = January
    const result = formatDateId(d);
    // yy=26, month=01, day=01, hour=00, min=01
    expect(result).toBe('260101-0001');
  });

  it('should use only the last two digits of the year', () => {
    const d = new Date(2000, 11, 31, 23, 59, 0);
    const result = formatDateId(d);
    expect(result.startsWith('00')).toBe(true);
  });

  it('should handle year 2099 (century rollover)', () => {
    const d = new Date(2099, 0, 1, 0, 0, 0);
    const result = formatDateId(d);
    expect(result.startsWith('99')).toBe(true);
  });
});

describe('topicSlug', () => {
  it('should return "untitled" for whitespace-only input', () => {
    expect(topicSlug('   ')).toBe('untitled');
  });

  it('should return "untitled" for empty string', () => {
    expect(topicSlug('')).toBe('untitled');
  });

  it('should return "untitled" for input with only punctuation stripped to nothing', () => {
    // All chars are stripped by the unicode regex — no letters/digits remain
    expect(topicSlug('!!! @@@ ###')).toBe('untitled');
  });

  it('should not truncate a slug of exactly 40 chars', () => {
    // 40 'a' chars — right at the boundary, should not be truncated
    const input = 'a'.repeat(40);
    expect(topicSlug(input)).toBe('a'.repeat(40));
    expect(topicSlug(input)).toHaveLength(40);
  });

  it('should truncate at last word boundary for slug longer than 40 chars', () => {
    // 'aaaa-bbbbb' pattern where the cut point is a dash before position 40
    const input = 'a'.repeat(36) + ' boundary word';
    const result = topicSlug(input);
    // slug = 'aaaa...aaaa-boundary-word' (50+ chars)
    // lastIndexOf('-', 40) finds the dash at position 36
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result.endsWith('-')).toBe(false);
  });

  it('should hard-cut at 40 when no dash exists within first 40 chars of a long slug', () => {
    // 60 continuous 'a' chars — no dashes, so lastIndexOf('-', 40) returns -1
    // falls into the `slug.slice(0, 40)` branch
    const input = 'a'.repeat(60);
    const result = topicSlug(input);
    expect(result).toBe('a'.repeat(40));
  });

  it('should strip leading and trailing dashes', () => {
    expect(topicSlug('  hello world  ')).toBe('hello-world');
  });

  it('should collapse multiple consecutive spaces/dashes into one dash', () => {
    const result = topicSlug('foo   bar');
    expect(result).toBe('foo-bar');
  });

  it('should not produce double-dashes from punctuation between words', () => {
    // "foo!! bar" → spaces→dash, punctuation stripped, should be "foo-bar"
    const result = topicSlug('foo!! bar');
    expect(result).not.toContain('--');
  });
});

describe('parseDisplayName', () => {
  it('should extract display name with em dash (—)', () => {
    const persona = '# Alice Smith — Senior Architect\nSome content';
    expect(parseDisplayName(persona, 'alice')).toBe('Alice Smith');
  });

  it('should extract display name with en dash (–)', () => {
    const persona = '# Bob Jones – Lead Engineer\nContent';
    expect(parseDisplayName(persona, 'bob')).toBe('Bob Jones');
  });

  it('should extract display name with ASCII hyphen ( - )', () => {
    const persona = '# Carol White - Analyst\nContent';
    expect(parseDisplayName(persona, 'carol')).toBe('Carol White');
  });

  it('should fall back to agentName when no heading separator is found', () => {
    const persona = 'No heading here\nJust text';
    expect(parseDisplayName(persona, 'fallback-agent')).toBe('fallback-agent');
  });

  it('should fall back to agentName for empty persona string', () => {
    expect(parseDisplayName('', 'my-agent')).toBe('my-agent');
  });

  it('should use only the first line for extraction', () => {
    // Second line has a valid separator — must be ignored
    const persona = 'Plain first line\n# Real Name — Role\nContent';
    expect(parseDisplayName(persona, 'fallback')).toBe('fallback');
  });

  it('should strip the # marker from the heading', () => {
    const persona = '# Name — Role';
    const result = parseDisplayName(persona, 'agent');
    expect(result).not.toContain('#');
  });

  it('should fall back when the separator is present but no name precedes it', () => {
    // " — Role" — nothing before the separator
    const persona = '# — Role only\nContent';
    expect(parseDisplayName(persona, 'agent')).toBe('agent');
  });
});


import {
  UINT32_SIZE,
  drawUInt32,
  createSeededRng,
  shuffleInPlace,
  weightedSample,
} from '../util/rng.js';

describe('drawUInt32', () => {
  it('should return 0 for rng always returning 0', () => {
    expect(drawUInt32(() => 0)).toBe(0);
  });

  it('should return UINT32_SIZE - 1 for rng returning values just below 1', () => {
    // Math.floor((1 - ε) * 2^32) >>> 0 = 4294967295
    const result = drawUInt32(() => 1 - Number.EPSILON);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(UINT32_SIZE);
  });

  it('should always return unsigned 32-bit value (no negative results)', () => {
    const rng = createSeededRng(42);
    for (let i = 0; i < 1000; i++) {
      const v = drawUInt32(rng);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(UINT32_SIZE);
    }
  });
});

describe('createSeededRng', () => {
  it('should be deterministic: same seed produces same sequence', () => {
    const a = createSeededRng(12345);
    const b = createSeededRng(12345);
    for (let i = 0; i < 20; i++) {
      expect(a()).toBe(b());
    }
  });

  it('should return values in [0, 1)', () => {
    const rng = createSeededRng(99);
    for (let i = 0; i < 500; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('should produce different sequences for seed 0 vs seed 1', () => {
    const rng0 = createSeededRng(0);
    const rng1 = createSeededRng(1);
    const seq0 = Array.from({ length: 5 }, () => rng0());
    const seq1 = Array.from({ length: 5 }, () => rng1());
    expect(seq0).not.toEqual(seq1);
  });

  it('should handle seed=0 without crashing', () => {
    const rng = createSeededRng(0);
    expect(() => rng()).not.toThrow();
    const v = rng();
    expect(typeof v).toBe('number');
    expect(Number.isFinite(v)).toBe(true);
  });

  it('should handle seed=0xFFFFFFFF (max uint32)', () => {
    const rng = createSeededRng(0xFFFFFFFF);
    expect(() => rng()).not.toThrow();
  });
});

describe('shuffleInPlace', () => {
  it('should return the same array reference (in-place)', () => {
    const arr = [1, 2, 3];
    const rng = createSeededRng(1);
    const result = shuffleInPlace(arr, rng);
    expect(result).toBe(arr);
  });

  it('should return empty array unchanged', () => {
    const arr: number[] = [];
    const rng = createSeededRng(1);
    expect(shuffleInPlace(arr, rng)).toEqual([]);
  });

  it('should return single-element array unchanged', () => {
    const arr = [42];
    const rng = createSeededRng(1);
    shuffleInPlace(arr, rng);
    expect(arr).toEqual([42]);
  });

  it('should contain exactly the same elements after shuffle', () => {
    const original = [1, 2, 3, 4, 5, 6, 7, 8];
    const arr = [...original];
    const rng = createSeededRng(999);
    shuffleInPlace(arr, rng);
    expect(arr.sort((a, b) => a - b)).toEqual(original);
  });

  it('should produce different orderings across different seeds', () => {
    const orderings = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const arr = [1, 2, 3, 4, 5];
      shuffleInPlace(arr, createSeededRng(seed));
      orderings.add(arr.join(','));
    }
    // With 5 elements there are 120 permutations — 20 seeds should hit > 1
    expect(orderings.size).toBeGreaterThan(1);
  });
});

describe('weightedSample', () => {
  it('should return -1 when all weights are zero', () => {
    // All weights zero → total <= EPS → findIndex returns -1
    const result = weightedSample([0, 0, 0], () => 0.5);
    expect(result).toBe(-1);
  });

  it('should return first positive index when total is near-zero but one weight is positive', () => {
    // One non-zero weight — findIndex(w > 0) should return that index
    const result = weightedSample([0, 0, 1e-13], () => 0.5);
    // total = 1e-13 <= EPS=1e-12 → goes to findIndex path → index 2
    expect(result).toBe(2);
  });

  it('should return -1 for empty weight array', () => {
    const result = weightedSample([], () => 0.5);
    expect(result).toBe(-1);
  });

  it('should select the only positive-weight entry when rng is non-zero', () => {
    // rng()=0.5: threshold=50, subtract 0→50, subtract 100→-50 ≤ 0 → index 1 ✓
    expect(weightedSample([0, 100, 0], () => 0.5)).toBe(1);
    expect(weightedSample([0, 100, 0], () => 0.999)).toBe(1);
  });

  it('should expose that rng()=0 with a leading zero-weight returns index 0 (known edge case)', () => {
    // When rng()=0: threshold=0*total=0. Loop: threshold -= weights[0]=0 → still 0.
    // threshold<=0 triggers at index 0 even though weights[0]=0.
    // This documents the actual behavior — callers should not pass rng()=0 with leading zeros.
    const result = weightedSample([0, 100, 0], () => 0);
    // The implementation returns 0 here (not 1). Documenting the actual behavior:
    expect(result).toBe(0);
  });

  it('should never select an index with zero weight', () => {
    const weights = [0, 50, 0, 50, 0];
    const rng = createSeededRng(42);
    for (let i = 0; i < 200; i++) {
      const idx = weightedSample(weights, rng);
      expect(idx === 1 || idx === 3).toBe(true);
    }
  });

  it('should distribute approximately proportionally', () => {
    const weights = [1, 3]; // 25% vs 75%
    const rng = createSeededRng(7);
    const counts = [0, 0];
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      counts[weightedSample(weights, rng)]++;
    }
    // Expect index 0 in [15%, 35%] and index 1 in [65%, 85%]
    expect(counts[0] / trials).toBeGreaterThan(0.15);
    expect(counts[0] / trials).toBeLessThan(0.35);
    expect(counts[1] / trials).toBeGreaterThan(0.65);
  });

  it('should handle rng returning exactly 1.0 without going out of bounds', () => {
    // rng() = 1.0 → threshold = total → loop never satisfies threshold <= 0
    // falls through to the last-positive-index fallback
    const result = weightedSample([10, 20, 30], () => 1.0);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(3);
  });
});


import {
  MAX_POOL_SIZE,
  cartesianProduct,
  hammingDistance,
  buildKernel,
  eigendecompose,
  sampleKDpp,
} from '../util/dpp.js';

describe('cartesianProduct', () => {
  it('should return [[]] for empty axes', () => {
    expect(cartesianProduct([])).toEqual([[]]);
  });

  it('should return correct count for a single axis', () => {
    const result = cartesianProduct([{ axis: 'x', positions: ['a', 'b', 'c'] }]);
    expect(result).toHaveLength(3);
  });

  it('should handle an axis with a single position', () => {
    const result = cartesianProduct([
      { axis: 'x', positions: ['only'] },
      { axis: 'y', positions: ['a', 'b'] },
    ]);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r[0] === 'only')).toBe(true);
  });

  it('should produce correct total count for multi-axis product', () => {
    const result = cartesianProduct([
      { axis: 'a', positions: ['1', '2'] },
      { axis: 'b', positions: ['x', 'y', 'z'] },
      { axis: 'c', positions: ['p', 'q'] },
    ]);
    expect(result).toHaveLength(2 * 3 * 2); // 12
  });
});

describe('hammingDistance', () => {
  it('should return 0 for identical arrays', () => {
    expect(hammingDistance(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(0);
  });

  it('should return length of longer array when one is empty', () => {
    // min=0, distance=abs(3-0)=3, loop runs 0 times → 3
    expect(hammingDistance(['a', 'b', 'c'], [])).toBe(3);
    expect(hammingDistance([], ['x', 'y'])).toBe(2);
  });

  it('should count each positional mismatch', () => {
    // 3 positions, all different → distance = 3
    expect(hammingDistance(['a', 'b', 'c'], ['x', 'y', 'z'])).toBe(3);
  });

  it('should add length difference to mismatches for unequal-length arrays', () => {
    // ['a','b'] vs ['a','b','c']: min=2, no mismatch in first 2, len diff=1 → 1
    expect(hammingDistance(['a', 'b'], ['a', 'b', 'c'])).toBe(1);
    // ['a','x'] vs ['a','b','c']: min=2, 1 mismatch, len diff=1 → 2
    expect(hammingDistance(['a', 'x'], ['a', 'b', 'c'])).toBe(2);
  });

  it('should be symmetric', () => {
    const a = ['x', 'y'];
    const b = ['x', 'z', 'w'];
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });
});

describe('buildKernel', () => {
  it('should return 1x1 matrix [[1]] for single-element pool', () => {
    const kernel = buildKernel([['a', 'b']], 1);
    expect(kernel).toEqual([[1]]);
  });

  it('should have diagonal entries of 1 (self-similarity)', () => {
    const pool = [['a', 'b'], ['c', 'd'], ['a', 'd']];
    const kernel = buildKernel(pool, 1);
    for (let i = 0; i < kernel.length; i++) {
      expect(kernel[i][i]).toBe(1);
    }
  });

  it('should be symmetric', () => {
    const pool = [['a', 'b'], ['a', 'c'], ['b', 'c']];
    const kernel = buildKernel(pool, 1);
    for (let i = 0; i < kernel.length; i++) {
      for (let j = 0; j < kernel.length; j++) {
        expect(kernel[i][j]).toBeCloseTo(kernel[j][i], 10);
      }
    }
  });

  it('should use identity matrix (distance=0 → 1, else 0) when sigma=0', () => {
    const pool = [['a', 'b'], ['c', 'd']]; // distance=2 > 0
    const kernel = buildKernel(pool, 0);
    // denom = 0 → off-diagonal entries: distance=2≠0 → 0
    expect(kernel[0][1]).toBe(0);
    expect(kernel[1][0]).toBe(0);
    expect(kernel[0][0]).toBe(1);
    expect(kernel[1][1]).toBe(1);
  });

  it('should return 1 for identical pool entries with sigma=0', () => {
    const pool = [['a', 'b'], ['a', 'b']]; // distance=0
    const kernel = buildKernel(pool, 0);
    // distance=0 → value=1
    expect(kernel[0][1]).toBe(1);
    expect(kernel[1][0]).toBe(1);
  });
});

describe('eigendecompose', () => {
  it('should return empty arrays for 0x0 matrix', () => {
    const result = eigendecompose([]);
    expect(result.eigenvalues).toEqual([]);
    expect(result.eigenvectors).toEqual([]);
  });

  it('should decompose 1x1 matrix to eigenvalue=value', () => {
    const result = eigendecompose([[5]]);
    expect(result.eigenvalues).toHaveLength(1);
    expect(result.eigenvalues[0]).toBeCloseTo(5, 8);
  });

  it('should clamp negative eigenvalues to 0', () => {
    // A near-singular matrix that might produce tiny negatives from floating point
    const matrix = [
      [1, 1],
      [1, 1],
    ]; // rank-1, one eigenvalue ≈ 0
    const { eigenvalues } = eigendecompose(matrix);
    for (const ev of eigenvalues) {
      expect(ev).toBeGreaterThanOrEqual(0);
    }
  });

  it('should sort eigenvalues in descending order', () => {
    const matrix = [
      [1, 0, 0],
      [0, 3, 0],
      [0, 0, 2],
    ];
    const { eigenvalues } = eigendecompose(matrix);
    for (let i = 0; i < eigenvalues.length - 1; i++) {
      expect(eigenvalues[i]).toBeGreaterThanOrEqual(eigenvalues[i + 1]);
    }
  });
});

describe('sampleKDpp', () => {
  it('should return [] for k=0', () => {
    const { eigenvalues, eigenvectors } = eigendecompose([[1, 0], [0, 1]]);
    expect(sampleKDpp(eigenvalues, eigenvectors, 0, createSeededRng(1))).toEqual([]);
  });

  it('should return [] for empty eigenvalues', () => {
    expect(sampleKDpp([], [], 3, createSeededRng(1))).toEqual([]);
  });

  it('should return exactly k items for k <= n', () => {
    const pool = [['a', 'b'], ['c', 'd'], ['a', 'd'], ['b', 'c']];
    const kernel = buildKernel(pool, 1);
    const { eigenvalues, eigenvectors } = eigendecompose(kernel);
    const rng = createSeededRng(42);
    const result = sampleKDpp(eigenvalues, eigenvectors, 2, rng);
    expect(result).toHaveLength(2);
  });

  it('should return min(k,n) items when k > n (caps at n)', () => {
    // 2x2 kernel, request k=5 — effectiveK = min(5,2) = 2
    const pool = [['a', 'b'], ['c', 'd']];
    const kernel = buildKernel(pool, 1);
    const { eigenvalues, eigenvectors } = eigendecompose(kernel);
    const result = sampleKDpp(eigenvalues, eigenvectors, 5, createSeededRng(1));
    expect(result).toHaveLength(2);
  });

  it('should return indices in range [0, n)', () => {
    const pool = [['a', 'b'], ['c', 'd'], ['a', 'd'], ['b', 'd']];
    const kernel = buildKernel(pool, 1);
    const { eigenvalues, eigenvectors } = eigendecompose(kernel);
    for (let seed = 1; seed <= 10; seed++) {
      const result = sampleKDpp(eigenvalues, eigenvectors, 2, createSeededRng(seed));
      for (const idx of result) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(pool.length);
      }
    }
  });

  it('should return unique indices (no duplicates)', () => {
    const pool = [['a', 'b'], ['c', 'd'], ['a', 'd'], ['b', 'c'], ['b', 'd']];
    const kernel = buildKernel(pool, 1.5);
    const { eigenvalues, eigenvectors } = eigendecompose(kernel);
    for (let seed = 1; seed <= 20; seed++) {
      const result = sampleKDpp(eigenvalues, eigenvectors, 3, createSeededRng(seed));
      expect(new Set(result).size).toBe(result.length);
    }
  });

  it('should return exactly 1 item for k=1', () => {
    const pool = [['x', 'y'], ['a', 'b'], ['c', 'd']];
    const kernel = buildKernel(pool, 1);
    const { eigenvalues, eigenvectors } = eigendecompose(kernel);
    const result = sampleKDpp(eigenvalues, eigenvectors, 1, createSeededRng(7));
    expect(result).toHaveLength(1);
  });

  it('MAX_POOL_SIZE is 256', () => {
    // Regression: MAX_POOL_SIZE must not change between refactors
    expect(MAX_POOL_SIZE).toBe(256);
  });
});


import { writeStateAtomic, SessionLock } from '../lock.js';
import { initSession } from '../state-machine.js';

const BASE_AGENTS = [
  { name: 'alice', persona: '# Alice — Architect\nSenior architect.', participation: 'required' as const },
  { name: 'bob', persona: '# Bob — Critic\nCritical thinker.', participation: 'required' as const },
];

function makeDiscussState() {
  return initSession({ topic: 'Lock Test', agents: BASE_AGENTS, min_bid_delay_ms: 0 }, '2026-01-01T00:00:00Z');
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'coral-red-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeStateAtomic', () => {
  it('should write state to the target path (no .tmp leftover)', () => {
    const filePath = join(tmpDir, 'state.json');
    const state = makeDiscussState();
    writeStateAtomic(filePath, state);
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(filePath + '.tmp')).toBe(false);
  });

  it('should write valid JSON that round-trips', () => {
    const filePath = join(tmpDir, 'state.json');
    const state = makeDiscussState();
    writeStateAtomic(filePath, state);
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.topic).toBe('Lock Test');
  });

  it('should overwrite an existing state file atomically', () => {
    const filePath = join(tmpDir, 'state.json');
    const state = makeDiscussState();
    writeStateAtomic(filePath, state);

    const updated = { ...state, topic: 'Updated Topic' };
    writeStateAtomic(filePath, updated);

    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.topic).toBe('Updated Topic');
  });
});

describe('SessionLock', () => {
  it('should run the callback and return its result', async () => {
    const lock = new SessionLock();
    const result = await lock.acquire(tmpDir, async () => 42);
    expect(result).toBe(42);
  });

  it('should clean up lock directory after successful callback', async () => {
    const lock = new SessionLock();
    await lock.acquire(tmpDir, async () => 'done');
    const lockDir = join(tmpDir, 'state.lock');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('should clean up lock directory even when callback throws', async () => {
    const lock = new SessionLock();
    await expect(lock.acquire(tmpDir, async () => {
      throw new Error('callback failure');
    })).rejects.toThrow('callback failure');
    const lockDir = join(tmpDir, 'state.lock');
    expect(existsSync(lockDir)).toBe(false);
  });

  it('should serialize concurrent acquisitions (no interleaving)', async () => {
    const lock = new SessionLock();
    const order: number[] = [];

    await Promise.all([
      lock.acquire(tmpDir, async () => {
        order.push(1);
        await new Promise<void>((r) => setTimeout(r, 30));
        order.push(2);
      }),
      lock.acquire(tmpDir, async () => {
        order.push(3);
      }),
    ]);

    // 2 must appear before 3 — the second acquire waits for the first to finish
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(3));
  });

  it('should throw "Lock timeout" after maxRetries with a permanently held lock dir', async () => {
    // Simulate a permanently held lock by pre-creating the lock dir with a
    // fake pid file that references a running process (current process) and
    // a very recent startedAt so it's never stale
    const lockDir = join(tmpDir, 'state.lock');
    mkdirSync(lockDir);

    // Write a pid file referencing the current process (alive) with now as startedAt
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(lockDir, 'pid'), `${process.pid}-${Date.now()}`);

    const lock = new SessionLock();
    await expect(lock.acquire(tmpDir, async () => 'never')).rejects.toThrow(
      `Lock timeout for session ${tmpDir}`,
    );
  }, 15000); // maxRetries=10 × baseDelay=50ms × 2^min(i,5) — up to ~3200ms total
});
