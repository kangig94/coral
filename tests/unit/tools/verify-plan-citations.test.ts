import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — the executable .mjs tool has no declaration file in this task's exact manifest.
import { verifyPlanCitations } from '../../../tools/verify-plan-citations.mjs';

const workspace = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

type VerificationResult = {
  checkedCount: number;
  rejections: Array<{ citation: string; rejectionClass: string }>;
};

function verifyFixture(planText: string): VerificationResult {
  return verifyPlanCitations(planText, { workspace });
}

describe('verify-plan-citations', () => {
  it('should accept workspace-relative, allowlisted root, and absolute citations', () => {
    const planText = [
      '`package.json:1`',
      '[coordinator path](src/infra/path/coordinator.ts:28-35)',
      `[absolute package](${join(workspace, 'package.json')}:1)`,
    ].join('\n');

    expect(verifyFixture(planText)).toEqual({ checkedCount: 3, rejections: [] });
  });

  it('should ignore a future owner path without a line suffix', () => {
    expect(verifyFixture('Future owner: `src/future-owner.ts`.')).toEqual({ checkedCount: 0, rejections: [] });
  });

  it.each([
    ['a shorthand anchor', '`ensure.ts:274`', 'ensure.ts:274', 'shorthand-anchor'],
    ['traversal', '`src/../package.json:1`', 'src/../package.json:1', 'traversal'],
    ['an unapproved root', '`README.md:1`', 'README.md:1', 'unapproved-root'],
    ['a missing path', '`src/does-not-exist.ts:1`', 'src/does-not-exist.ts:1', 'missing-path'],
    ['a zero line', '`package.json:0`', 'package.json:0', 'zero-line'],
    [
      'a reversed range',
      '`src/infra/path/coordinator.ts:35-28`',
      'src/infra/path/coordinator.ts:35-28',
      'reversed-range',
    ],
    ['an out-of-range line', '`package.json:999999`', 'package.json:999999', 'out-of-range-line'],
    ['an absolute target outside the workspace', '[outside](/etc/passwd:1)', '/etc/passwd:1', 'outside-workspace'],
  ])('should reject %s', (_name, planText, citation, rejectionClass) => {
    expect(verifyFixture(planText)).toEqual({
      checkedCount: 1,
      rejections: [{ citation, rejectionClass }],
    });
  });
});
