import { isAbsolute, normalize } from 'node:path';

/**
 * Kept as a closed union rather than a bare string so a role name can never drift from the argv flag that names it.
 */
export type ProviderRole = 'guardian' | 'reaper' | 'proxy';

/**
 * argv flag -> role name, the single source of truth for provider-role dispatch.
 */
export const PROVIDER_ROLE_FLAGS: Readonly<Record<string, ProviderRole>> = Object.freeze({
  '--provider-guardian': 'guardian',
  '--provider-reaper': 'reaper',
  '--provider-proxy': 'proxy',
});

export type ProviderRoleArgv = Readonly<{ role: ProviderRole; capsulePath: string }> | Readonly<{ role: 'none' }>;

function isCanonicalAbsolutePath(path: string): boolean {
  return isAbsolute(path) && normalize(path) === path && !path.includes('\0');
}

/** `indexOf` alone finds only the first occurrence, which is exactly what let a second `--provider-proxy`
 *  silently vanish instead of being refused. */
function allIndicesOf(argv: readonly string[], value: string): number[] {
  const indices: number[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === value) indices.push(index);
  }
  return indices;
}

/**
 * Parses `process.argv` for exactly one provider-role flag.
 *
 * Two flags — including two occurrences of the *same* flag — are refused rather than resolved by precedence:
 * each bootstrap capsule is one-use and consumed by claiming its path, so a process that read one flag
 * occurrence and ignored another would silently destroy the credential of the capsule it did not claim. A
 * relative or non-canonical capsule path is refused up front, before any capsule file is touched.
 */
export function parseProviderRoleArgv(argv: readonly string[]): ProviderRoleArgv {
  const matches: Array<{ role: ProviderRole; index: number }> = [];
  for (const [flag, role] of Object.entries(PROVIDER_ROLE_FLAGS)) {
    const indices = allIndicesOf(argv, flag);
    if (indices.length > 1) {
      throw new Error(`Provider role invocation named ${flag} more than once; each bootstrap capsule is one-use.`);
    }
    if (indices.length === 1) matches.push({ role, index: indices[0] });
  }

  if (matches.length === 0) return { role: 'none' };
  if (matches.length > 1) {
    const named = matches.map((match) => match.role).join(', ');
    throw new Error(
      `Provider role invocation named more than one mode (${named}); a process may become only one role.`,
    );
  }

  const [{ role, index }] = matches;
  const capsulePath = argv[index + 1];
  if (typeof capsulePath !== 'string' || capsulePath.length === 0) {
    throw new Error(`Provider role invocation for ${role} did not name a capsule path.`);
  }
  if (!isCanonicalAbsolutePath(capsulePath)) {
    throw new Error(`Provider role invocation for ${role} named a non-canonical capsule path: ${capsulePath}`);
  }
  return { role, capsulePath };
}
