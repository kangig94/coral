import { describe, expect, it } from 'vitest';

// prettier-ignore
// @ts-expect-error — the gate's report reader is plain Node ESM (.mjs) with no type surface.
import { casesWithoutHeadroom, collectDurations, formatDurations, headroomRatio } from '../../../scripts/test-report.mjs';

type CaseDuration = { durationMs: number; timeoutMs: number | undefined; file: string; fullName: string };
type FileDuration = { durationMs: number; file: string };
type Durations = { cases: CaseDuration[]; files: FileDuration[] };
type Verdict = { withoutHeadroom: CaseDuration[]; unjudged: CaseDuration[]; unbounded: CaseDuration[] };

const ROOT = '/repo';

function fileResult(
  name: string,
  times: { startTime?: number; endTime?: number },
  cases: Array<{ fullName?: string; title?: string; duration: number | null; timeout?: number }>,
): Record<string, unknown> {
  return {
    name,
    ...times,
    status: 'passed',
    assertionResults: cases.map(({ timeout, ...entry }) => ({
      ...entry,
      status: 'passed',
      ...(timeout === undefined ? {} : { meta: { timeout } }),
    })),
  };
}

function durationsOf(testResults: Array<Record<string, unknown>>): Durations {
  return collectDurations({ testResults }, ROOT) as Durations;
}

function judged(cases: CaseDuration[], ratio: number): Verdict {
  return casesWithoutHeadroom(cases, { ratio }) as Verdict;
}

function caseOf(durationMs: number, timeoutMs: number | undefined, fullName: string): CaseDuration {
  return { durationMs, timeoutMs, file: 'tests/unit/a.test.ts', fullName };
}

describe('test-report', () => {
  describe('collectDurations', () => {
    it('should report cases and files slowest first, relative to the root', () => {
      const durations = durationsOf([
        fileResult('/repo/tests/unit/a.test.ts', { startTime: 1_000, endTime: 3_000 }, [
          { fullName: 'a > quick', duration: 40, timeout: 15_000 },
          { fullName: 'a > slow', duration: 1_500, timeout: 15_000 },
        ]),
        fileResult('/repo/tests/invariants/b.test.ts', { startTime: 1_000, endTime: 12_000 }, [
          { fullName: 'b > slower', duration: 11_000, timeout: 60_000 },
        ]),
      ]);

      expect(durations.cases).toEqual([
        { durationMs: 11_000, timeoutMs: 60_000, file: 'tests/invariants/b.test.ts', fullName: 'b > slower' },
        { durationMs: 1_500, timeoutMs: 15_000, file: 'tests/unit/a.test.ts', fullName: 'a > slow' },
        { durationMs: 40, timeoutMs: 15_000, file: 'tests/unit/a.test.ts', fullName: 'a > quick' },
      ]);
      expect(durations.files).toEqual([
        { durationMs: 11_000, file: 'tests/invariants/b.test.ts' },
        { durationMs: 2_000, file: 'tests/unit/a.test.ts' },
      ]);
    });

    it('should omit a case or file the report left unmeasured', () => {
      const durations = durationsOf([
        fileResult('/repo/tests/unit/a.test.ts', { startTime: 1_000 }, [
          { fullName: 'a > skipped', duration: null, timeout: 15_000 },
          { fullName: 'a > ran', duration: 7, timeout: 15_000 },
        ]),
      ]);

      expect(durations.cases).toEqual([
        { durationMs: 7, timeoutMs: 15_000, file: 'tests/unit/a.test.ts', fullName: 'a > ran' },
      ]);
      expect(durations.files).toEqual([]);
    });

    it('should leave a case whose report carried no budget without one', () => {
      const durations = durationsOf([
        fileResult('/repo/tests/unit/a.test.ts', { startTime: 0, endTime: 1 }, [{ fullName: 'a > ran', duration: 7 }]),
      ]);

      expect(durations.cases).toEqual([
        { durationMs: 7, timeoutMs: undefined, file: 'tests/unit/a.test.ts', fullName: 'a > ran' },
      ]);
    });

    it('should fall back to a case title when the report carries no full name', () => {
      const durations = durationsOf([
        fileResult('/repo/tests/unit/a.test.ts', { startTime: 0, endTime: 1 }, [
          { title: 'bare', duration: 3, timeout: 15_000 },
        ]),
      ]);

      expect(durations.cases).toEqual([
        { durationMs: 3, timeoutMs: 15_000, file: 'tests/unit/a.test.ts', fullName: 'bare' },
      ]);
    });

    it('should tolerate a report with no results at all', () => {
      expect(collectDurations({}, ROOT)).toEqual({ cases: [], files: [] });
    });
  });

  describe('formatDurations', () => {
    it('should print each case as duration over budget, file and full name, capped at the limit', () => {
      const durations = durationsOf([
        fileResult('/repo/tests/unit/a.test.ts', { startTime: 0, endTime: 500 }, [
          { fullName: 'a > third', duration: 30, timeout: 15_000 },
          { fullName: 'a > first', duration: 300, timeout: 45_000 },
          { fullName: 'a > second', duration: 200 },
        ]),
      ]);

      expect(formatDurations(durations, 2)).toBe(
        [
          'slowest cases (2 of 3):',
          '  300/45000 tests/unit/a.test.ts :: a > first',
          '  200/? tests/unit/a.test.ts :: a > second',
          'slowest files (1 of 1):',
          '  500 tests/unit/a.test.ts',
        ].join('\n'),
      );
    });

    it('should default to the ten slowest cases', () => {
      const durations = durationsOf([
        fileResult(
          '/repo/tests/unit/a.test.ts',
          { startTime: 0, endTime: 1 },
          Array.from({ length: 12 }, (_unused, index) => ({
            fullName: `a > case ${index}`,
            duration: index,
            timeout: 15_000,
          })),
        ),
      ]);

      const lines = (formatDurations(durations) as string).split('\n');

      expect(lines[0]).toBe('slowest cases (10 of 12):');
      expect(lines.slice(1, 11).map((line) => line.trim().split('/')[0])).toEqual([
        '11',
        '10',
        '9',
        '8',
        '7',
        '6',
        '5',
        '4',
        '3',
        '2',
      ]);
    });
  });

  describe('casesWithoutHeadroom', () => {
    it('should flag a case against its own budget rather than any shared limit', () => {
      const verdict = judged(
        [
          caseOf(11_000, 15_000, 'a > close to a short budget'),
          caseOf(11_000, 60_000, 'a > far from a long budget'),
          caseOf(41_000, 60_000, 'a > close to a long budget'),
        ],
        1.5,
      );

      expect(verdict.withoutHeadroom.map((entry) => entry.fullName)).toEqual([
        'a > close to a short budget',
        'a > close to a long budget',
      ]);
      expect(verdict.unjudged).toEqual([]);
      expect(verdict.unbounded).toEqual([]);
    });

    it('should pass a case that lands exactly on its margin', () => {
      const verdict = judged(
        [caseOf(10_000, 15_000, 'a > exactly at the margin'), caseOf(10_001, 15_000, 'a > over')],
        1.5,
      );

      expect(verdict.withoutHeadroom.map((entry) => entry.fullName)).toEqual(['a > over']);
    });

    it('should report a case with no budget as unjudged rather than as passing', () => {
      const verdict = judged([caseOf(7, undefined, 'a > unjudged'), caseOf(7, 15_000, 'a > judged')], 1.5);

      expect(verdict.unjudged.map((entry) => entry.fullName)).toEqual(['a > unjudged']);
      expect(verdict.withoutHeadroom).toEqual([]);
    });

    it.each([
      ['a zero budget', 0],
      ['an infinite budget', Number.POSITIVE_INFINITY],
      ['a budget that is not a number at all', Number.NaN],
    ])('should report %s as unbounded rather than as judged either way', (label, timeoutMs) => {
      const verdict = judged([caseOf(11_000, timeoutMs, `a > ${label}`), caseOf(7, 15_000, 'a > judged')], 1.5);

      expect(verdict.unbounded.map((entry) => entry.fullName)).toEqual([`a > ${label}`]);
      expect(verdict.withoutHeadroom).toEqual([]);
      expect(verdict.unjudged).toEqual([]);
    });

    it('should judge nothing when the run measured no cases', () => {
      expect(judged([], 1.5)).toEqual({ withoutHeadroom: [], unjudged: [], unbounded: [] });
    });

    it('should widen and narrow with the ratio it is given', () => {
      const cases = [caseOf(11_000, 15_000, 'a > inside a 1.2x margin, outside a 2x one')];

      expect(judged(cases, 1.2).withoutHeadroom).toEqual([]);
      expect(judged(cases, 2).withoutHeadroom.map((entry) => entry.fullName)).toEqual([
        'a > inside a 1.2x margin, outside a 2x one',
      ]);
    });
  });

  describe('headroomRatio', () => {
    it('should default to one and a half when nothing is set', () => {
      expect(headroomRatio(undefined)).toBe(1.5);
      expect(headroomRatio('')).toBe(1.5);
    });

    it('should take a finite override of at least one', () => {
      expect(headroomRatio('2.5')).toBe(2.5);
      expect(headroomRatio('1')).toBe(1);
    });

    it.each(['0.9', '-2', 'soon', 'Infinity'])('should refuse %s rather than fall back', (raw) => {
      expect(() => headroomRatio(raw)).toThrow('CORAL_HEADROOM_RATIO must be a finite number at least 1');
    });
  });
});
