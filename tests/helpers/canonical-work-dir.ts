import type { CanonicalWorkDir } from '#src/runtime/canonical-work-dir.js';

/**
 * Mint a branded work directory for fixtures that do not exercise canonicalization.
 * Boundary tests must use canonicalizeWorkDir with a real directory instead.
 */
export function fixtureCanonicalWorkDir(path: string): CanonicalWorkDir {
  return path as CanonicalWorkDir;
}
