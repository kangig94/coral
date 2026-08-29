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
  | Readonly<{ kind: 'outside-temp-root'; tier: 'integration' | 'e2e'; location: string; tempRoot: string }>
  | Readonly<{
      kind: 'resolution-failed';
      tier: 'integration' | 'e2e';
      location: string;
      tempRoot: string;
      path: string;
      cause: unknown;
    }>;

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

type PathResolution =
  | Readonly<{ kind: 'resolved'; path: string }>
  | Readonly<{ kind: 'failed'; path: string; cause: unknown }>;

function realPathWhenPresent(path: string): PathResolution {
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath)) return { kind: 'resolved', path: resolvedPath };
  try {
    return { kind: 'resolved', path: realpathSync(resolvedPath) };
  } catch (cause: unknown) {
    return { kind: 'failed', path: resolvedPath, cause };
  }
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

  const tempRootResolution = realPathWhenPresent(tempRoot);
  if (tempRootResolution.kind === 'failed') {
    return {
      kind: 'resolution-failed',
      tier,
      location,
      tempRoot,
      path: tempRootResolution.path,
      cause: tempRootResolution.cause,
    };
  }
  const locationResolution = realPathWhenPresent(location);
  if (locationResolution.kind === 'failed') {
    return {
      kind: 'resolution-failed',
      tier,
      location,
      tempRoot,
      path: locationResolution.path,
      cause: locationResolution.cause,
    };
  }

  const resolvedTempRoot = tempRootResolution.path;
  const resolvedLocation = locationResolution.path;
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
  if (disposition.kind === 'allowed') return;

  db.close();

  if (disposition.kind === 'unrecognized-tier') {
    throw new Error(
      `Test database opened with CORAL_TEST_TIER=${policy.tier ?? '<unset>'}; set it through testEnv(tier) or the standalone simulation entry point before opening ${location ?? ':memory:'}`,
    );
  }

  if (disposition.kind === 'file-forbidden') {
    throw new Error(
      `${disposition.tier} test database resolved to ${disposition.location}; use ':memory:' or move the case to tests/integration`,
    );
  }

  if (disposition.kind === 'outside-temp-root') {
    throw new Error(
      `${disposition.tier} test database resolved to ${disposition.location}; use ':memory:' or a path under the test temp root ${disposition.tempRoot}`,
    );
  }

  throw new Error(
    `${disposition.tier} test database path ${disposition.path} could not be resolved safely; keep the database and test temp root available and accessible`,
    { cause: disposition.cause },
  );
}
