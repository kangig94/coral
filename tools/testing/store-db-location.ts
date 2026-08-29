import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Database } from '../../src/store/db.js';

export type TestTier = 'unit' | 'integration' | 'simulation' | 'e2e';

const TEST_TIERS = new Set<TestTier>(['unit', 'integration', 'simulation', 'e2e']);

/**
 * Decides from the opened handle, not from the argument that opened it: `location()` returns `null` for
 * `':memory:'` and the file otherwise, so an alias, a variable, or a wrapper cannot present a file as memory.
 * An unrecognized tier is refused rather than treated as the permissive one.
 */
export function assertTestDatabaseLocation(db: Database): void {
  const tier = process.env.CORAL_TEST_TIER;
  const location = db.location();

  if (!TEST_TIERS.has(tier as TestTier)) {
    db.close();
    throw new Error(
      `Test database opened with CORAL_TEST_TIER=${tier ?? '<unset>'}; set it through testEnv(tier) before opening ${location ?? ':memory:'}`,
    );
  }

  if (tier === 'unit' || tier === 'simulation') {
    if (location !== null) {
      db.close();
      throw new Error(
        `${tier} test database resolved to ${location}; use ':memory:' or move the case to tests/integration`,
      );
    }
    return;
  }

  if (location === null) return;

  const tempRoot = resolve(process.env.TMPDIR ?? tmpdir());
  const resolvedLocation = resolve(location);
  const pathFromTempRoot = relative(tempRoot, resolvedLocation);
  if (pathFromTempRoot === '' || pathFromTempRoot.startsWith('..') || isAbsolute(pathFromTempRoot)) {
    db.close();
    throw new Error(
      `${tier} test database resolved to ${resolvedLocation}; use ':memory:' or a path under the test temp root ${tempRoot}`,
    );
  }
}
