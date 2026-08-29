import { testTempEnv } from './temp-root.js';
import type { TestTier } from '../tools/testing/store-db-location.js';

export const UNIT_TIER_ROOTS = ['tests/unit', 'tests/invariants'] as const;
export const UNIT_TIER_INCLUDES = UNIT_TIER_ROOTS.map((root) => `${root}/**/*.test.ts`);

export function testEnv(tier: TestTier): Readonly<Record<string, string>> {
  return { ...testTempEnv(), CORAL_TEST_TIER: tier };
}
