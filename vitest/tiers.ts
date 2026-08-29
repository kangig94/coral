import { testTempEnv } from './temp-root.js';

export const UNIT_TIER_ROOTS = ['tests/unit', 'tests/invariants'] as const;
export const UNIT_TIER_INCLUDES = UNIT_TIER_ROOTS.map((root) => `${root}/**/*.test.ts`);

export type TestTier = 'unit' | 'integration' | 'simulation' | 'e2e';

export function testEnv(tier: TestTier): Readonly<Record<string, string>> {
  return { ...testTempEnv(), CORAL_TEST_TIER: tier };
}
