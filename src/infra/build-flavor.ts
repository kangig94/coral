export type BuildFlavor = 'prod' | 'dev';

/**
 * Canonical name of the env var that selects the build flavor. This module is
 * the single place allowed to name it (enforced by the `no-ambient-flavor-reads`
 * invariant); other modules that need the key — e.g. to protect it from
 * caller-forwarded env — import this constant instead of repeating the literal.
 */
export const BUILD_FLAVOR_ENV_KEY = 'CORAL_FLAVOR';

export function resolveBuildFlavor(env: NodeJS.ProcessEnv): BuildFlavor {
  return env[BUILD_FLAVOR_ENV_KEY] === 'dev' ? 'dev' : 'prod';
}
