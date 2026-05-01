import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  listProductionSourceFiles,
  parseProductionImportEdges,
  toCanonicalSrcPath,
  type EdgeSyntax,
} from '#tests/helpers/ts-import-scanner.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '../../../..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');

const SUBSYSTEM_PREFIXES = [
  'execution/discuss',
  'execution',
  'discuss',
  'client',
  'bridge',
  'cli',
  'infra',
  'shared',
  'providers',
  'workflow',
  'kb',
  'runtime',
  'causality',
  'read-model',
  'coral',
  'hooks',
  'skills',
  'store',
  'coordinator',
  'jobs',
  'sessions',
  'transport/http',
  'transport/ipc',
  'transport',
  'testing',
  'simulation',
  'expansion',
] as const;

type Subsystem = (typeof SUBSYSTEM_PREFIXES)[number];

type EdgeAccumulator = {
  source: string;
  target: string;
  runtimeVia: Set<EdgeSyntax>;
  typeOnlyVia: Set<EdgeSyntax>;
};

type ParsedEdge = EdgeAccumulator & {
  sourceSubsystem: Subsystem;
  targetSubsystem: Subsystem;
};

function classifySubsystem(canonicalPath: string): Subsystem {
  const sourceRelativePath = canonicalPath.slice('src/'.length);
  if (sourceRelativePath === 'engines' || sourceRelativePath.startsWith('engines/')) {
    return 'kb';
  }

  for (const prefix of SUBSYSTEM_PREFIXES) {
    if (sourceRelativePath === prefix || sourceRelativePath.startsWith(`${prefix}/`)) {
      return prefix;
    }
  }

  throw new Error(`No subsystem bucket matched ${canonicalPath}`);
}

function buildParsedEdges(productionFilePaths: string[]): ParsedEdge[] {
  const parsedEdgesByTarget = new Map<string, EdgeAccumulator>();

  for (const edge of parseProductionImportEdges(REPO_ROOT, productionFilePaths)) {
    const key = `${edge.source}\u0000${edge.target}`;
    const accumulated = parsedEdgesByTarget.get(key) ?? {
      source: edge.source,
      target: edge.target,
      runtimeVia: new Set<EdgeSyntax>(),
      typeOnlyVia: new Set<EdgeSyntax>(),
    };

    if (edge.runtime) {
      accumulated.runtimeVia.add(edge.via);
    }

    if (edge.typeOnly) {
      accumulated.typeOnlyVia.add(edge.via);
    }

    parsedEdgesByTarget.set(key, accumulated);
  }

  return [...parsedEdgesByTarget.values()]
    .map((edge) => ({
      ...edge,
      sourceSubsystem: classifySubsystem(edge.source),
      targetSubsystem: classifySubsystem(edge.target),
    }))
    .sort((left, right) => {
      if (left.source !== right.source) {
        return left.source.localeCompare(right.source);
      }

      if (left.target !== right.target) {
        return left.target.localeCompare(right.target);
      }

      return left.sourceSubsystem.localeCompare(right.sourceSubsystem);
    });
}

function buildRuntimeSubsystemGraph(nodes: Iterable<Subsystem>, edges: ParsedEdge[]): Map<Subsystem, Set<Subsystem>> {
  const graph = new Map<Subsystem, Set<Subsystem>>();

  for (const node of nodes) {
    graph.set(node, new Set<Subsystem>());
  }

  for (const edge of edges) {
    if (edge.sourceSubsystem === edge.targetSubsystem || edge.runtimeVia.size === 0) {
      continue;
    }

    graph.get(edge.sourceSubsystem)?.add(edge.targetSubsystem);
  }

  return graph;
}

function findStronglyConnectedComponents(graph: Map<Subsystem, Set<Subsystem>>): Subsystem[][] {
  const indexByNode = new Map<Subsystem, number>();
  const lowlinkByNode = new Map<Subsystem, number>();
  const stack: Subsystem[] = [];
  const onStack = new Set<Subsystem>();
  const components: Subsystem[][] = [];
  let nextIndex = 0;

  function strongConnect(node: Subsystem): void {
    const currentIndex = nextIndex++;
    indexByNode.set(node, currentIndex);
    lowlinkByNode.set(node, currentIndex);
    stack.push(node);
    onStack.add(node);

    const neighbors = [...(graph.get(node) ?? [])].sort();
    for (const neighbor of neighbors) {
      if (!indexByNode.has(neighbor)) {
        strongConnect(neighbor);
        lowlinkByNode.set(node, Math.min(lowlinkByNode.get(node)!, lowlinkByNode.get(neighbor)!));
      } else if (onStack.has(neighbor)) {
        lowlinkByNode.set(node, Math.min(lowlinkByNode.get(node)!, indexByNode.get(neighbor)!));
      }
    }

    if (lowlinkByNode.get(node) !== indexByNode.get(node)) {
      return;
    }

    const component: Subsystem[] = [];
    let current: Subsystem;

    do {
      current = stack.pop()!;
      onStack.delete(current);
      component.push(current);
    } while (current !== node);

    components.push(component.sort());
  }

  for (const node of [...graph.keys()].sort()) {
    if (!indexByNode.has(node)) {
      strongConnect(node);
    }
  }

  return components.sort((left, right) => left.join(',').localeCompare(right.join(',')));
}

function formatViaKinds(edge: ParsedEdge): string {
  const parts: string[] = [];

  if (edge.runtimeVia.size > 0) {
    parts.push(`runtime via ${[...edge.runtimeVia].sort().join(', ')}`);
  }

  if (edge.typeOnlyVia.size > 0) {
    parts.push(`type-only via ${[...edge.typeOnlyVia].sort().join(', ')}`);
  }

  return parts.join('; ');
}

function formatEdge(edge: ParsedEdge): string {
  return `${edge.source} -> ${edge.target} (${formatViaKinds(edge)})`;
}

function formatScc(scc: Subsystem[]): string {
  return scc.join(' <-> ');
}

describe('discuss architecture guard', () => {
  it('enforces discuss domain boundary (runtime + type-only) with a TypeScript-aware subsystem graph', () => {
    const productionFilePaths = listProductionSourceFiles(SRC_ROOT);
    const parsedEdges = buildParsedEdges(productionFilePaths);
    const subsystemNodes = new Set<Subsystem>(
      productionFilePaths.map((filePath) => classifySubsystem(toCanonicalSrcPath(REPO_ROOT, filePath))),
    );
    const crossSubsystemEdges = parsedEdges.filter((edge) => edge.sourceSubsystem !== edge.targetSubsystem);
    const runtimeSubsystemGraph = buildRuntimeSubsystemGraph(subsystemNodes, crossSubsystemEdges);
    const runtimeSubsystemSccs = findStronglyConnectedComponents(runtimeSubsystemGraph).filter((scc) => scc.length > 1);

    const discussRuntimeImports = crossSubsystemEdges.filter((edge) => {
      return (
        edge.sourceSubsystem === 'discuss' &&
        edge.runtimeVia.size > 0 &&
        (edge.targetSubsystem === 'client' ||
          edge.targetSubsystem === 'execution' ||
          edge.targetSubsystem === 'execution/discuss')
      );
    });

    const invalidDiscussExecutionTypeOnlyImports = crossSubsystemEdges.filter((edge) => {
      return (
        edge.sourceSubsystem === 'discuss' &&
        edge.runtimeVia.size === 0 &&
        edge.typeOnlyVia.size > 0 &&
        edge.targetSubsystem === 'execution'
      );
    });

    const deferredDiscussDebt = crossSubsystemEdges.filter((edge) => {
      return (
        edge.sourceSubsystem === 'discuss' &&
        edge.runtimeVia.size === 0 &&
        edge.typeOnlyVia.size > 0 &&
        (edge.targetSubsystem === 'client' || edge.targetSubsystem === 'execution/discuss')
      );
    });

    console.info(
      runtimeSubsystemSccs.length === 0
        ? 'Runtime subsystem SCCs: none'
        : `Runtime subsystem SCCs:\n${runtimeSubsystemSccs.map((scc) => `- ${formatScc(scc)}`).join('\n')}`,
    );

    const failures: string[] = [];

    if (runtimeSubsystemSccs.length > 0) {
      failures.push(
        [
          'production runtime subsystem graph must be acyclic:',
          ...runtimeSubsystemSccs.map((scc) => `- ${formatScc(scc)}`),
        ].join('\n'),
      );
    }

    if (discussRuntimeImports.length > 0) {
      failures.push(
        [
          'src/discuss must not runtime-import the removed client tree or src/execution/*:',
          ...discussRuntimeImports.map((edge) => `- ${formatEdge(edge)}`),
        ].join('\n'),
      );
    }

    if (invalidDiscussExecutionTypeOnlyImports.length > 0) {
      failures.push(
        [
          'src/discuss type-only imports from src/execution/* must target src/execution/discuss/*:',
          ...invalidDiscussExecutionTypeOnlyImports.map((edge) => `- ${formatEdge(edge)}`),
        ].join('\n'),
      );
    }

    if (deferredDiscussDebt.length > 0) {
      failures.push(
        [
          'src/discuss must not type-only-import the removed client tree or src/execution/discuss/* (deferred debt must be zero):',
          ...deferredDiscussDebt.map((edge) => `- ${formatEdge(edge)}`),
        ].join('\n'),
      );
    }

    if (failures.length > 0) {
      expect.fail(['Discuss architecture boundary violations:', ...failures].join('\n\n'));
    }
  });
});
