import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  createProductionFileIndex,
  listProductionSourceFiles,
  parseSourceImportEdges,
  toCanonicalSrcPath,
  type ParsedImportEdge,
} from '../__helpers__/ts-import-scanner.js';

// CG7 lands before CG8 deletes src/execution/, so this test enforces the
// current layering seams plus the explicitly retained transitional surfaces.

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '../../../');
const SRC_ROOT = resolve(REPO_ROOT, 'src');

const PRODUCTION_FILE_PATHS = listProductionSourceFiles(SRC_ROOT);
const PRODUCTION_SOURCE_FILES = PRODUCTION_FILE_PATHS.map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath));
const PRODUCTION_FILE_INDEX = createProductionFileIndex(REPO_ROOT, PRODUCTION_FILE_PATHS);
const PARSED_IMPORT_EDGES = PRODUCTION_FILE_PATHS.flatMap((filePath) =>
  parseSourceImportEdges(REPO_ROOT, filePath, PRODUCTION_FILE_INDEX),
);
const PARSED_IMPORT_EDGES_BY_SOURCE = new Map<string, ParsedImportEdge[]>();

for (const edge of PARSED_IMPORT_EDGES) {
  const existing = PARSED_IMPORT_EDGES_BY_SOURCE.get(edge.source) ?? [];
  existing.push(edge);
  PARSED_IMPORT_EDGES_BY_SOURCE.set(edge.source, existing);
}

const DOMAIN_ROOTS = [
  'src/jobs',
  'src/sessions',
  'src/discuss',
  'src/workflow',
  'src/kb',
  'src/providers',
] as const;
const GENERIC_ROOT_FILENAMES = new Set(['utils.ts', 'types.ts', 'schemas.ts']);
const SHARED_GENERIC_ROOT_ALLOWLIST = ['src/shared/schemas.ts', 'src/shared/utils.ts'];
const RUNTIME_INFRA_TRANSITION_ALLOWLIST: Record<string, readonly string[]> = {
  'src/runtime/real.ts': ['src/coordinator/paths.ts'],
  'src/infra/coral-paths.ts': [
    'src/coordinator/paths.ts',
    'src/jobs/exports/paths.ts',
    'src/kb/corpus/paths.ts',
  ],
};
const TRANSPORT_LAYER_ALLOWLIST = [
  'src/transport',
  'src/shared',
  'src/runtime',
  'src/infra',
  'src/store',
] as const;
const TRANSPORT_DOMAIN_ALLOWLIST = new Set([
  'src/discuss/views.ts',
  'src/jobs/launch.ts',
  'src/jobs/phase.ts',
  'src/jobs/records.ts',
  'src/jobs/wait.ts',
  'src/kb/entry-types.ts',
  'src/kb/frontmatter.ts',
  'src/kb/ops/delete.ts',
  'src/kb/ops/memo.ts',
  'src/kb/ops/promote.ts',
  'src/kb/ops/reindex.ts',
  'src/kb/ops/search.ts',
  'src/kb/ops/source-store.ts',
  'src/kb/ops/update.ts',
  'src/kb/paths.ts',
  'src/kb/subsystem.ts',
  'src/kb/validation.ts',
]);
const COORDINATOR_BROAD_SURFACE_ALLOWLIST = new Set([
  'src/coordinator/api.ts',
  'src/coordinator/bootstrap.ts',
  'src/coordinator/control.ts',
  'src/coordinator/coordinator.ts',
  'src/coordinator/lock.ts',
  'src/coordinator/shutdown/sequence.ts',
]);
const NON_BREADTH_DOMAIN_TARGETS = new Set(['src/jobs/exports/paths.ts', 'src/kb/corpus/paths.ts']);

function isWithinPath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function domainRootOf(path: string): string | null {
  return DOMAIN_ROOTS.find((root) => isWithinPath(path, root)) ?? null;
}

function effectiveDomainRootOf(path: string): string | null {
  if (NON_BREADTH_DOMAIN_TARGETS.has(path)) {
    return null;
  }

  return domainRootOf(path);
}

function isLegacyCoordinatorSurface(path: string): boolean {
  return path.startsWith('src/execution/') || path.includes('/shell/') || path.startsWith('src/jobs/reconcile/');
}

function edgeContribution(edge: ParsedImportEdge): string {
  const contribution = [
    edge.runtime ? 'runtime' : null,
    edge.typeOnly ? 'type-only' : null,
  ].filter((value): value is string => value !== null);

  return contribution.length > 0 ? contribution.join(' + ') : 'unknown';
}

function formatEdge(edge: ParsedImportEdge): string {
  return `${edge.source} -> ${edge.target} (${edge.specifier}; ${edge.via}; ${edgeContribution(edge)})`;
}

function assertNoViolations(label: string, violations: ParsedImportEdge[]): void {
  if (violations.length === 0) {
    return;
  }

  expect.fail(`${label}\n${violations.map((edge) => `- ${formatEdge(edge)}`).join('\n')}`);
}

describe('architecture layering invariant (AC11)', () => {
  it('#27 runtime/ and infra/ stay below domain, transport, coordinator, and cli layers', () => {
    const disallowedRoots = [...DOMAIN_ROOTS, 'src/transport', 'src/coordinator', 'src/cli'];
    const violations = PARSED_IMPORT_EDGES.filter((edge) => {
      if (!isWithinPath(edge.source, 'src/runtime') && !isWithinPath(edge.source, 'src/infra')) {
        return false;
      }

      const disallowedRoot = disallowedRoots.find((root) => isWithinPath(edge.target, root));
      if (!disallowedRoot) {
        return false;
      }

      return !(RUNTIME_INFRA_TRANSITION_ALLOWLIST[edge.source] ?? []).includes(edge.target);
    }).sort((left, right) => formatEdge(left).localeCompare(formatEdge(right)));

    assertNoViolations(
      '#27 violation: runtime/infra imported a higher-layer or domain surface outside the path-composition transition allowlist.',
      violations,
    );
  });

  it('#28 transport/ stays on transport-local, shared/runtime/infra/store, and the explicit domain contract surface', () => {
    const violations = PARSED_IMPORT_EDGES.filter((edge) => {
      if (!isWithinPath(edge.source, 'src/transport')) {
        return false;
      }

      if (TRANSPORT_LAYER_ALLOWLIST.some((root) => isWithinPath(edge.target, root))) {
        return false;
      }

      const domainRoot = domainRootOf(edge.target);
      if (domainRoot !== null) {
        return !TRANSPORT_DOMAIN_ALLOWLIST.has(edge.target);
      }

      return true;
    }).sort((left, right) => formatEdge(left).localeCompare(formatEdge(right)));

    assertNoViolations(
      '#28 violation: transport imported a non-contract domain surface or a forbidden upper-layer module.',
      violations,
    );
  });

  it('#29 coordinator is the only control-plane layer allowed broad legacy and cross-domain seams', () => {
    const nonCoordinatorViolations = PARSED_IMPORT_EDGES.filter((edge) => {
      if (
        !isWithinPath(edge.source, 'src/runtime')
        && !isWithinPath(edge.source, 'src/infra')
        && !isWithinPath(edge.source, 'src/transport')
      ) {
        return false;
      }

      return isLegacyCoordinatorSurface(edge.target);
    }).sort((left, right) => formatEdge(left).localeCompare(formatEdge(right)));

    assertNoViolations(
      '#29 violation: a non-coordinator layering root imported a legacy execution/domain-shell surface.',
      nonCoordinatorViolations,
    );

    const disallowedCoordinatorSeams = PARSED_IMPORT_EDGES.filter((edge) => {
      if (!isWithinPath(edge.source, 'src/coordinator')) {
        return false;
      }

      if (COORDINATOR_BROAD_SURFACE_ALLOWLIST.has(edge.source)) {
        return false;
      }

      return isLegacyCoordinatorSurface(edge.target);
    }).sort((left, right) => formatEdge(left).localeCompare(formatEdge(right)));

    assertNoViolations(
      '#29 violation: a restricted coordinator file reached a legacy execution/domain-shell surface.',
      disallowedCoordinatorSeams,
    );

    const coordinatorBreadthViolations = PRODUCTION_SOURCE_FILES.filter((source) => isWithinPath(source, 'src/coordinator'))
      .flatMap((source) => {
        const domainRoots = new Set<string>();

        for (const edge of PARSED_IMPORT_EDGES_BY_SOURCE.get(source) ?? []) {
          const domainRoot = effectiveDomainRootOf(edge.target);
          if (domainRoot !== null) {
            domainRoots.add(domainRoot);
          }
        }

        if (domainRoots.size <= 1 || COORDINATOR_BROAD_SURFACE_ALLOWLIST.has(source)) {
          return [];
        }

        const breadthSummary = [...domainRoots].sort().join(', ');
        return [`${source} crosses ${domainRoots.size} domain roots: ${breadthSummary}`];
      });

    if (coordinatorBreadthViolations.length > 0) {
      expect.fail(
        '#29 violation: only the coordinator control-plane allowlist may span multiple domain roots.\n'
          + coordinatorBreadthViolations.map((violation) => `- ${violation}`).join('\n'),
      );
    }
  });

  it('#30 production source never imports src/testing/', () => {
    const violations = PARSED_IMPORT_EDGES.filter((edge) => isWithinPath(edge.target, 'src/testing')).sort((left, right) =>
      formatEdge(left).localeCompare(formatEdge(right)),
    );

    assertNoViolations('#30 violation: production code imported src/testing/.', violations);
  });

  it('#31 bans generic filenames at top-level src/* roots except the shared allowlist', () => {
    const genericRootFiles = PRODUCTION_SOURCE_FILES.filter((file) => {
      const pathFromSrc = file.slice('src/'.length);
      const parts = pathFromSrc.split('/');
      return parts.length === 2 && GENERIC_ROOT_FILENAMES.has(parts[1]);
    }).sort();

    expect(genericRootFiles).toEqual(SHARED_GENERIC_ROOT_ALLOWLIST);
  });
});
