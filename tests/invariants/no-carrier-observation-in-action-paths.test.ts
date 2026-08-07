import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  listProductionSourceFiles,
  parseProductionImportEdges,
  toCanonicalSrcPath,
  type ParsedImportEdge,
} from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PRODUCTION_FILE_PATHS = listProductionSourceFiles(join(REPO_ROOT, 'src'));
const IMPORT_EDGES: ParsedImportEdge[] = parseProductionImportEdges(REPO_ROOT, PRODUCTION_FILE_PATHS);
const CANONICAL_FILES = new Set(PRODUCTION_FILE_PATHS.map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath)));

/**
 * Carrier observation's authority, and who may hold it.
 *
 * The classifier is pure and local, so asking it costs nothing and health/idle may ask it freely — what they
 * may not do is let the answer authorize a mutation. There is deliberately no network-observer authority
 * alongside it: the bounded network observer that once paired with this classifier
 * (`src/coordinator/live/carrier-observer.ts`) was deleted for having no importer anywhere in `src/` — both
 * of its intended callers never wired it in. A coordinator that probed the network to decide whether hard
 * retirement is safe would have made a remote process the authority over local durable state, which is why,
 * if a network observer returns, it belongs on this list from the moment it gains its first importer.
 */
type ObservationAuthority = {
  readonly module: string;
  readonly what: string;
  /** Modules and directory roots permitted to import it. Everything else is a violation. */
  readonly permittedImporters: readonly string[];
};

const OBSERVATION_AUTHORITIES: readonly ObservationAuthority[] = [
  {
    module: 'src/jobs/carrier-observation.ts',
    what: 'the pure carrier classifier',
    permittedImporters: [
      // The wait stream's local classification path, which reports observation beside stored phase.
      'src/jobs/shell/',
      // Health snapshots are assembled in composition, which is why that root — not a `health.ts` or
      // `coordinator/live/idle.ts` — is what appears here: composition is what may ask the classifier so
      // health/idle never need a network observer to do it.
      'src/coordinator/composition/',
    ],
  },
];

/**
 * Where a carrier verdict must never reach, because everything here decides the fate of durable state.
 *
 * Derived absence is a reading, not a fact: it can be produced by a slow socket or a foreign build, and the
 * whole point of the tri-state is that only the journal ends a job. A recovery walk that filtered its
 * candidates by observation would skip exactly the stored-nonterminal work it exists to settle, and a
 * cleanup pass that deleted on it would delete artifacts belonging to a job still running.
 */
const ACTION_PATH_ROOTS = [
  'src/recovery/',
  'src/coordinator/services/recovery/',
  'src/coordinator/startup-recovery.ts',
  'src/coordinator/shutdown-recovery.ts',
  'src/coordinator/services/terminal-materializer.ts',
  'src/jobs/reconcile/',
] as const;

/** Every production module under an action-path root — the entry points the walk starts from. */
const ACTION_PATH_MODULES: readonly string[] = [...CANONICAL_FILES]
  .filter((file) => ACTION_PATH_ROOTS.some((root) => (root.endsWith('/') ? file.startsWith(root) : file === root)))
  .sort();

function matches(module: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => (entry.endsWith('/') ? module.startsWith(entry) : module === entry));
}

/**
 * Runtime edges only. A `import type` is erased before anything runs, so it can hand no verdict to anyone —
 * and following it would report the module graph rather than the capability. Without this the walk reports
 * `recovery/index.ts -> handoff.ts -> lifecycle.ts -> …`, a chain whose middle two hops are type-only.
 */
const ADJACENCY = new Map<string, string[]>();
for (const edge of IMPORT_EDGES) {
  if (!edge.runtime) continue;
  const existing = ADJACENCY.get(edge.source);
  if (existing === undefined) ADJACENCY.set(edge.source, [edge.target]);
  else existing.push(edge.target);
}

/**
 * Every module reachable from `entry` over runtime imports, with the shortest path that reached each one.
 *
 * Reachability, not direct edges. The property is "an action path must not obtain a carrier verdict", and a
 * direct-edge rule protects that only if no permitted module can hand the verdict on — which any ordinary
 * wrapper function does, without re-exporting anything, so banning re-export closes one hop and leaves the
 * rest.
 */
function reachableFrom(entry: string): Map<string, readonly string[]> {
  const paths = new Map<string, readonly string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const path = paths.get(current) as readonly string[];
    for (const next of ADJACENCY.get(current) ?? []) {
      if (paths.has(next)) continue;
      paths.set(next, [...path, next]);
      queue.push(next);
    }
  }
  return paths;
}

/** Roots naming nothing. A directory root matches by prefix, a file root by identity. */
function unmatchedRoots(roots: readonly string[]): string[] {
  return roots.filter((root) =>
    root.endsWith('/') ? ![...CANONICAL_FILES].some((file) => file.startsWith(root)) : !CANONICAL_FILES.has(root),
  );
}

describe('carrier observation never reaches mutation or recovery paths', () => {
  it.each(OBSERVATION_AUTHORITIES.map((authority) => [authority.module, authority] as const))(
    '%s exists, so this invariant cannot pass by naming nothing',
    (module, authority) => {
      // A declared authority that does not exist would make every check below vacuously true — the exact
      // failure mode an invariant is supposed to rule out rather than exhibit.
      expect(CANONICAL_FILES).toContain(module);
      expect(authority.permittedImporters.length).toBeGreaterThan(0);
      // A permitted importer naming nothing is the opposite failure: it silently widens the ban instead of
      // narrowing it, and it hides that the module it was written for has moved or gone.
      expect(unmatchedRoots(authority.permittedImporters)).toEqual([]);
    },
  );

  it.each(OBSERVATION_AUTHORITIES.map((authority) => [authority.module, authority] as const))(
    '%s is actually imported, so this invariant is not vacuously green over an empty set',
    (module, authority) => {
      const importers = IMPORT_EDGES.filter((edge) => edge.target === module).map((edge) => edge.source);
      // An authority nobody imports is not being guarded by any check in this file — reachability,
      // permission, and re-export all pass trivially over an empty edge set. That is exactly how a module
      // with no importer anywhere in `src/` (the deleted `coordinator/live/carrier-observer.ts`) stayed
      // declared here with every check green: the checks below all ran, and all passed, over nothing.
      expect(importers.length).toBeGreaterThan(0);

      // The same failure at finer grain: a permitted-importer entry nothing imports through is a permission
      // nobody exercises, and an unexercised permission is indistinguishable from one that no longer applies.
      const unexercised = authority.permittedImporters.filter(
        (entry) => !importers.some((source) => matches(source, [entry])),
      );
      expect(unexercised).toEqual([]);
    },
  );

  it.each(OBSERVATION_AUTHORITIES.map((authority) => [authority.what, authority] as const))(
    '%s is reachable from no action path, at any import depth',
    (_what, authority) => {
      const violations = ACTION_PATH_MODULES.flatMap((entry) => {
        const path = reachableFrom(entry).get(authority.module);
        // The whole path, not just the endpoint: a transitive violation is only actionable if you can see
        // which hop introduced it.
        return path === undefined ? [] : [path.join(' -> ')];
      });

      expect(violations).toEqual([]);
    },
  );

  it.each(OBSERVATION_AUTHORITIES.map((authority) => [authority.what, authority] as const))(
    '%s is imported only where it is permitted',
    (_what, authority) => {
      const violations = IMPORT_EDGES.filter(
        (edge) => edge.target === authority.module && !matches(edge.source, authority.permittedImporters),
      ).map((edge) => `${edge.source} imports ${edge.specifier} (${edge.via}) from ${authority.module}`);

      expect(violations).toEqual([]);
    },
  );

  it.each(OBSERVATION_AUTHORITIES.map((authority) => [authority.what, authority] as const))(
    '%s is never re-exported, so no module can launder it past the import rules above',
    (_what, authority) => {
      // Independent of the reachability walk above, and kept because it protects a different thing: a
      // re-export makes the importing module a second canonical home for the symbol, which
      // design-philosophy forbids outright regardless of who ends up reaching it.
      const reexports = IMPORT_EDGES.filter(
        (edge) => edge.target === authority.module && edge.via === 'ExportDeclaration',
      ).map((edge) => `${edge.source} re-exports ${edge.specifier} from ${authority.module}`);

      expect(reexports).toEqual([]);
    },
  );

  it('names action paths that all exist', () => {
    // A root that matches nothing silently narrows the ban — the module it was written for was renamed or
    // deleted, and the rule quietly stopped covering anything.
    expect(unmatchedRoots(ACTION_PATH_ROOTS)).toEqual([]);
  });
});
