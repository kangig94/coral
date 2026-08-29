import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Database } from '../../src/store/db.js';

export type TestTier = 'unit' | 'integration' | 'simulation' | 'e2e';

const TEST_TIERS = new Set<TestTier>(['unit', 'integration', 'simulation', 'e2e']);
const ENFORCED_TEST_LOCATION_POLICY = Symbol.for('coral.testing.enforced-test-location-policy');

type EnforcedTestLocationPolicy = Readonly<{ tier: string | undefined; tempRoot: string }>;

type TestLocationPolicyGlobal = typeof globalThis & {
  [ENFORCED_TEST_LOCATION_POLICY]?: EnforcedTestLocationPolicy;
};

export type TestDatabaseLocationDisposition =
  | Readonly<{ kind: 'allowed' }>
  | Readonly<{ kind: 'unrecognized-tier' }>
  | Readonly<{ kind: 'file-forbidden'; tier: 'unit' | 'simulation'; location: string }>
  | Readonly<{ kind: 'outside-temp-root'; tier: 'integration' | 'e2e'; location: string; tempRoot: string }>;

function isTestTier(tier: string | undefined): tier is TestTier {
  return TEST_TIERS.has(tier as TestTier);
}

function enforcedLocationPolicy(): EnforcedTestLocationPolicy {
  const policyGlobal = globalThis as TestLocationPolicyGlobal;
  const frozenPolicy = policyGlobal[ENFORCED_TEST_LOCATION_POLICY];
  if (frozenPolicy !== undefined) return frozenPolicy;

  const policy = Object.freeze({
    tier: process.env.CORAL_TEST_TIER,
    tempRoot: resolve(process.env.TMPDIR ?? tmpdir()),
  });
  policyGlobal[ENFORCED_TEST_LOCATION_POLICY] = policy;
  return policy;
}

function realPathWhenPresent(path: string): string {
  const resolvedPath = resolve(path);
  return existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolvedPath;
}

export function classifyTestDatabaseLocation(
  tier: string | undefined,
  tempRoot: string,
  location: string | null,
): TestDatabaseLocationDisposition {
  if (!isTestTier(tier)) {
    return { kind: 'unrecognized-tier' };
  }

  if (tier === 'unit' || tier === 'simulation') {
    return location === null ? { kind: 'allowed' } : { kind: 'file-forbidden', tier, location };
  }

  if (location === null) return { kind: 'allowed' };

  const resolvedTempRoot = realPathWhenPresent(tempRoot);
  const resolvedLocation = realPathWhenPresent(location);
  const pathFromTempRoot = relative(resolvedTempRoot, resolvedLocation);
  if (
    pathFromTempRoot === '' ||
    pathFromTempRoot === '..' ||
    pathFromTempRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromTempRoot)
  ) {
    return { kind: 'outside-temp-root', tier, location: resolvedLocation, tempRoot: resolvedTempRoot };
  }

  return { kind: 'allowed' };
}

/**
 * Decides from the opened handle, not from the argument that opened it: `location()` returns `null` for
 * `':memory:'` and the file otherwise, so an alias, a variable, or a wrapper cannot present a file as memory.
 * An unrecognized tier is refused rather than treated as the permissive one.
 */
export function assertTestDatabaseLocation(db: Database): void {
  const policy = enforcedLocationPolicy();
  const location = db.location();
  const disposition = classifyTestDatabaseLocation(policy.tier, policy.tempRoot, location);

  if (disposition.kind === 'unrecognized-tier') {
    db.close();
    throw new Error(
      `Test database opened with CORAL_TEST_TIER=${policy.tier ?? '<unset>'}; set it through testEnv(tier) or the standalone simulation entry point before opening ${location ?? ':memory:'}`,
    );
  }

  if (disposition.kind === 'file-forbidden') {
    db.close();
    throw new Error(
      `${disposition.tier} test database resolved to ${disposition.location}; use ':memory:' or move the case to tests/integration`,
    );
  }

  if (disposition.kind === 'outside-temp-root') {
    db.close();
    throw new Error(
      `${disposition.tier} test database resolved to ${disposition.location}; use ':memory:' or a path under the test temp root ${disposition.tempRoot}`,
    );
  }
}
