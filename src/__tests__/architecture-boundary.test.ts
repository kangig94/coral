/*
Architectural boundary guard for seams established by:
- 9fb8faa: execution/ and client/ were split so backend runtime code and client-side lifecycle code do not couple back together.
- e34d8d8: workflow/ may depend on provider discovery only through src/providers/catalog.ts, not provider implementations or provider internals.
This test enforces those boundaries with the TypeScript compiler API and treats import type, export ... from, typeof import('...'), and relative dynamic import('...') as boundary-crossing imports.
Known non-goals: computed import(variableName) and relative require('...') are intentionally not covered.
*/

// Phase 1 decision: extracted shared scanning helpers to src/__tests__/__helpers__/ts-import-scanner.ts because the reused resolver and AST import scanner exceed the inline duplication threshold.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createProductionFileIndex,
  findStronglyConnectedComponents,
  listProductionSourceFiles,
  parseSourceImportEdges,
  toCanonicalSrcPath,
  type ParsedImportEdge,
} from './__helpers__/ts-import-scanner.js';

const __filename = fileURLToPath(import.meta.url);
const SRC_ROOT = resolve(dirname(__filename), '..');
const REPO_ROOT = resolve(SRC_ROOT, '..');

const EXECUTION_ROOT = 'src/execution';
const EXECUTION_LIFECYCLE_ROOT = 'src/execution/lifecycle';
const EXECUTION_LIFECYCLE_FACADE = 'src/execution/lifecycle.ts';
const CLIENT_ROOT = 'src/client';
const WORKFLOW_ROOT = 'src/workflow';
const PROVIDERS_ROOT = 'src/providers';
const WORKFLOW_PROVIDER_ALLOWLIST_TARGET = 'src/providers/catalog.ts';

const PRODUCTION_FILE_PATHS = listProductionSourceFiles(SRC_ROOT);
const PRODUCTION_SOURCE_FILES = PRODUCTION_FILE_PATHS.map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath));
const PRODUCTION_FILE_INDEX = createProductionFileIndex(REPO_ROOT, PRODUCTION_FILE_PATHS);
const PARSED_IMPORT_EDGES = PRODUCTION_FILE_PATHS.flatMap((filePath) =>
  parseSourceImportEdges(REPO_ROOT, filePath, PRODUCTION_FILE_INDEX),
);
const PARSED_IMPORT_EDGES_BY_SOURCE = new Map<string, ParsedImportEdge[]>();

for (const edge of PARSED_IMPORT_EDGES) {
  const edgesForSource = PARSED_IMPORT_EDGES_BY_SOURCE.get(edge.source) ?? [];
  edgesForSource.push(edge);
  PARSED_IMPORT_EDGES_BY_SOURCE.set(edge.source, edgesForSource);
}

type BoundaryViolation = {
  source: string;
  specifier: string;
  target: string;
  via: ParsedImportEdge['via'];
  ruleName: string;
  remediationHint: string;
};

function isWithinPath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function collectViolations(
  sourceRoot: string,
  ruleName: string,
  remediationHint: string,
  isForbiddenTarget: (target: string) => boolean,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  for (const sourceFile of PRODUCTION_SOURCE_FILES) {
    if (!isWithinPath(sourceFile, sourceRoot)) {
      continue;
    }

    for (const edge of PARSED_IMPORT_EDGES_BY_SOURCE.get(sourceFile) ?? []) {
      if (!isForbiddenTarget(edge.target)) {
        continue;
      }

      violations.push({
        source: edge.source,
        specifier: edge.specifier,
        target: edge.target,
        via: edge.via,
        ruleName,
        remediationHint,
      });
    }
  }

  return violations.sort((left, right) => {
    if (left.source !== right.source) {
      return left.source.localeCompare(right.source);
    }

    if (left.specifier !== right.specifier) {
      return left.specifier.localeCompare(right.specifier);
    }

    if (left.target !== right.target) {
      return left.target.localeCompare(right.target);
    }

    return left.via.localeCompare(right.via);
  });
}

function assertNoViolations(violations: BoundaryViolation[]): void {
  if (violations.length === 0) {
    return;
  }

  expect.fail(
    violations
      .map((violation) =>
        [
          `Forbidden import: ${violation.source} imports ${violation.specifier} via ${violation.via}.`,
          `Rule: ${violation.ruleName}.`,
          `Resolved target: ${violation.target}.`,
          `Remediation: ${violation.remediationHint}.`,
        ].join('\n'),
      )
      .join('\n\n'),
  );
}

function formatEdgeContribution(edge: ParsedImportEdge): string {
  const participation = [
    edge.runtime ? 'runtime' : null,
    edge.typeOnly ? 'type-only' : null,
  ].filter((value): value is string => value !== null);
  return participation.length > 0 ? participation.join(' + ') : 'no contribution flags';
}

function findCyclePath(component: string[], componentEdges: ParsedImportEdge[]): string[] {
  const componentMembers = new Set(component);
  const adjacency = new Map<string, string[]>();

  for (const member of component) {
    adjacency.set(member, []);
  }

  for (const edge of componentEdges) {
    if (!componentMembers.has(edge.source) || !componentMembers.has(edge.target)) {
      continue;
    }
    adjacency.get(edge.source)?.push(edge.target);
  }

  for (const targets of adjacency.values()) {
    targets.sort((left, right) => left.localeCompare(right));
  }

  function visit(start: string, current: string, path: string[], pathMembers: Set<string>): string[] | null {
    for (const target of adjacency.get(current) ?? []) {
      if (target === start) {
        return [...path, start];
      }
      if (pathMembers.has(target)) {
        continue;
      }

      pathMembers.add(target);
      const cyclePath = visit(start, target, [...path, target], pathMembers);
      pathMembers.delete(target);
      if (cyclePath !== null) {
        return cyclePath;
      }
    }

    return null;
  }

  for (const start of component) {
    const cyclePath = visit(start, start, [start], new Set([start]));
    if (cyclePath !== null) {
      return cyclePath;
    }
  }

  return component;
}

describe('architecture boundary guard', () => {
  it('execution/ must not import from client/ (production only)', () => {
    // Established by 9fb8faa.
    const violations = collectViolations(
      EXECUTION_ROOT,
      'execution/ must not import from client/ (production only)',
      'use src/discuss/shell/discuss-sources-catalog.ts instead.',
      (target) => isWithinPath(target, CLIENT_ROOT),
    );

    assertNoViolations(violations);
  });

  it('client/ must not import from execution/ (production only)', () => {
    // Established by 9fb8faa.
    const violations = collectViolations(
      CLIENT_ROOT,
      'client/ must not import from execution/ (production only)',
      'move the shared contract to src/shared/ or src/infra/ instead.',
      (target) => isWithinPath(target, EXECUTION_ROOT),
    );

    assertNoViolations(violations);
  });

  it('workflow/ may only import from providers/catalog (allowlist of exactly one path)', () => {
    // Established by e34d8d8.
    const violations = collectViolations(
      WORKFLOW_ROOT,
      'workflow/ may only import from providers/catalog (allowlist of exactly one path)',
      'depend on src/providers/catalog.ts instead.',
      (target) => isWithinPath(target, PROVIDERS_ROOT) && target !== WORKFLOW_PROVIDER_ALLOWLIST_TARGET,
    );

    assertNoViolations(violations);
  });

  it('src/execution/lifecycle/ must not import the lifecycle facade and must stay internally acyclic', () => {
    const facadeViolations = collectViolations(
      EXECUTION_LIFECYCLE_ROOT,
      'src/execution/lifecycle/ must not import src/execution/lifecycle.ts',
      'move the shared helper or type into src/execution/lifecycle/ or inject it from lifecycle.ts instead.',
      (target) => target === EXECUTION_LIFECYCLE_FACADE,
    );

    assertNoViolations(facadeViolations);

    const lifecycleNodes = PRODUCTION_SOURCE_FILES.filter((file) => isWithinPath(file, EXECUTION_LIFECYCLE_ROOT));
    const lifecycleEdges = PARSED_IMPORT_EDGES.filter(
      (edge) => isWithinPath(edge.source, EXECUTION_LIFECYCLE_ROOT) && isWithinPath(edge.target, EXECUTION_LIFECYCLE_ROOT),
    );
    const stronglyConnectedComponents = findStronglyConnectedComponents(lifecycleNodes, lifecycleEdges).filter(
      (component) => component.length > 1,
    );
    const selfLoops = lifecycleEdges
      .filter((edge) => edge.source === edge.target)
      .sort((left, right) => left.source.localeCompare(right.source) || left.specifier.localeCompare(right.specifier));

    if (stronglyConnectedComponents.length === 0 && selfLoops.length === 0) {
      return;
    }

    const cycleMessages = stronglyConnectedComponents.map((component, index) => {
      const componentMembers = new Set(component);
      const componentEdges = component
        .flatMap((node) => PARSED_IMPORT_EDGES_BY_SOURCE.get(node) ?? [])
        .filter((edge) => componentMembers.has(edge.target))
        .sort((left, right) => {
          if (left.source !== right.source) {
            return left.source.localeCompare(right.source);
          }
          if (left.target !== right.target) {
            return left.target.localeCompare(right.target);
          }
          if (left.specifier !== right.specifier) {
            return left.specifier.localeCompare(right.specifier);
          }
          return left.via.localeCompare(right.via);
        });
      const cyclePath = findCyclePath(component, componentEdges);

      return [
        `Cycle ${index + 1}: ${cyclePath.join(' -> ')}`,
        `Members: ${component.join(', ')}`,
        'Edges:',
        ...componentEdges.map(
          (edge) =>
            `- ${edge.source} -> ${edge.target} via ${edge.specifier} (${edge.via}; ${formatEdgeContribution(edge)})`,
        ),
      ].join('\n');
    });

    const selfLoopMessage =
      selfLoops.length === 0
        ? []
        : [
            'Self-loops:',
            ...selfLoops.map(
              (edge) =>
                `- ${edge.source} -> ${edge.target} via ${edge.specifier} (${edge.via}; ${formatEdgeContribution(edge)})`,
            ),
          ];

    expect.fail(
      ['Detected import cycle(s) within src/execution/lifecycle/.', ...cycleMessages, ...selfLoopMessage].join('\n\n'),
    );
  });

  it('src/shared/ must be internally acyclic', () => {
    const sharedNodes = PRODUCTION_SOURCE_FILES.filter((file) => isWithinPath(file, 'src/shared'));
    const sharedEdges = PARSED_IMPORT_EDGES.filter(
      (edge) => isWithinPath(edge.source, 'src/shared') && isWithinPath(edge.target, 'src/shared'),
    );
    const stronglyConnectedComponents = findStronglyConnectedComponents(sharedNodes, sharedEdges).filter(
      (component) => component.length > 1,
    );
    const selfLoops = sharedEdges
      .filter((edge) => edge.source === edge.target)
      .sort((left, right) => left.source.localeCompare(right.source) || left.specifier.localeCompare(right.specifier));

    if (stronglyConnectedComponents.length === 0 && selfLoops.length === 0) {
      return;
    }

    const cycleMessages = stronglyConnectedComponents.map((component, index) => {
      const componentMembers = new Set(component);
      const componentEdges = component
        .flatMap((node) => PARSED_IMPORT_EDGES_BY_SOURCE.get(node) ?? [])
        .filter((edge) => componentMembers.has(edge.target))
        .sort((left, right) => {
          if (left.source !== right.source) {
            return left.source.localeCompare(right.source);
          }
          if (left.target !== right.target) {
            return left.target.localeCompare(right.target);
          }
          if (left.specifier !== right.specifier) {
            return left.specifier.localeCompare(right.specifier);
          }
          return left.via.localeCompare(right.via);
        });
      const cyclePath = findCyclePath(component, componentEdges);

      return [
        `Cycle ${index + 1}: ${cyclePath.join(' -> ')}`,
        `Members: ${component.join(', ')}`,
        'Edges:',
        ...componentEdges.map(
          (edge) =>
            `- ${edge.source} -> ${edge.target} via ${edge.specifier} (${edge.via}; ${formatEdgeContribution(edge)})`,
        ),
      ].join('\n');
    });

    const selfLoopMessage =
      selfLoops.length === 0
        ? []
        : [
            'Self-loops:',
            ...selfLoops.map(
              (edge) =>
                `- ${edge.source} -> ${edge.target} via ${edge.specifier} (${edge.via}; ${formatEdgeContribution(edge)})`,
            ),
          ];

    expect.fail(['Detected import cycle(s) within src/shared/.', ...cycleMessages, ...selfLoopMessage].join('\n\n'));
  });
});
