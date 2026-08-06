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
 * The two halves of carrier observation, and who may hold each.
 *
 * They are separated because the questions differ. The classifier is pure and local, so asking it costs
 * nothing and health/idle may ask it freely — what they may not do is let the answer authorize a mutation.
 * The network observer goes and asks a foreign process, which is why even reading it is confined to the
 * read-model and the composition that assembles it: a coordinator that probed the network to decide whether
 * hard retirement is safe would have made a remote process the authority over local durable state.
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
      // Read surfaces and the wait/follow path, which report observation beside stored phase.
      'src/read-model/',
      'src/jobs/shell/',
      'src/cli/',
      'src/transport/http/',
      // Health and idle: permitted the classifier precisely so they never need the network observer.
      // Health snapshots are assembled in composition, which is why that root — not a `health.ts` — is
      // what appears here.
      'src/coordinator/live/idle.ts',
      'src/coordinator/composition/',
      // The observer shares the verdict vocabulary it produces; the two halves must agree on what
      // `live | absent | unknown` means or the tri-state has no single owner.
      'src/coordinator/live/carrier-observer.ts',
    ],
  },
  {
    module: 'src/coordinator/live/carrier-observer.ts',
    what: 'the bounded network observer',
    permittedImporters: [
      // Strictly narrower than the classifier's. Going and asking a foreign process is only ever done to
      // render a read; letting it reach anywhere else is how a remote answer would end up deciding the
      // fate of local durable state.
      'src/read-model/',
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

function matches(module: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => (entry.endsWith('/') ? module.startsWith(entry) : module === entry));
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

  it.each(OBSERVATION_AUTHORITIES.map((authority) => [authority.what, authority] as const))(
    '%s is imported by no action path',
    (_what, authority) => {
      const violations = IMPORT_EDGES.filter(
        (edge) => edge.target === authority.module && matches(edge.source, ACTION_PATH_ROOTS),
      ).map((edge) => `${edge.source} imports ${edge.specifier} (${edge.via}) from ${authority.module}`);

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
      // The rules above are stated over direct edges, which a single re-export hop would defeat: an action
      // path importing a wrapper would name the wrapper, not the authority. Banning the re-export outright
      // is what keeps the direct-edge check equivalent to a use check.
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
