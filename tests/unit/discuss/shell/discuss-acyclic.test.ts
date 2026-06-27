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

const DOMAIN_BUCKET_PREFIXES = [
  'execution/discuss',
  'execution',
  'discuss',
  'client',
  'bridge',
  'cli',
  'infra',
  'shared',
  'types',
  'providers',
  'workflow',
  'kb-daemon',
  'kb',
  'projection-consumers',
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

type DomainBucket = (typeof DOMAIN_BUCKET_PREFIXES)[number];

type EdgeAccumulator = {
  source: string;
  target: string;
  runtimeVia: Set<EdgeSyntax>;
  typeOnlyVia: Set<EdgeSyntax>;
};

type ParsedEdge = EdgeAccumulator & {
  sourceBucket: DomainBucket;
  targetBucket: DomainBucket;
};

const ALLOWED_PROVIDER_SESSION_RUNTIME_EDGES = new Set([
  'src/providers/claude/session-kernel.ts -> src/sessions/fault.ts',
  'src/providers/contract.ts -> src/sessions/fault.ts',
  'src/sessions/entry.ts -> src/providers/artifact-identity.ts',
  'src/sessions/entry.ts -> src/providers/contract.ts',
  'src/sessions/event-bodies.ts -> src/providers/artifact-identity.ts',
  'src/sessions/fault.ts -> src/providers/turn-failure-diagnostic.ts',
  'src/sessions/shell.ts -> src/providers/artifact-identity.ts',
  'src/sessions/shell.ts -> src/providers/catalog.ts',
]);

function classifyDomainBucket(canonicalPath: string): DomainBucket {
  const sourceRelativePath = canonicalPath.slice('src/'.length);
  if (sourceRelativePath === 'engines' || sourceRelativePath.startsWith('engines/')) {
    return 'kb';
  }

  for (const prefix of DOMAIN_BUCKET_PREFIXES) {
    if (sourceRelativePath === prefix || sourceRelativePath.startsWith(`${prefix}/`)) {
      return prefix;
    }
  }

  throw new Error(`No component bucket matched ${canonicalPath}`);
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
      sourceBucket: classifyDomainBucket(edge.source),
      targetBucket: classifyDomainBucket(edge.target),
    }))
    .sort((left, right) => {
      if (left.source !== right.source) {
        return left.source.localeCompare(right.source);
      }

      if (left.target !== right.target) {
        return left.target.localeCompare(right.target);
      }

      return left.sourceBucket.localeCompare(right.sourceBucket);
    });
}

function buildRuntimeDomainGraph(
  nodes: Iterable<DomainBucket>,
  edges: ParsedEdge[],
): Map<DomainBucket, Set<DomainBucket>> {
  const graph = new Map<DomainBucket, Set<DomainBucket>>();

  for (const node of nodes) {
    graph.set(node, new Set<DomainBucket>());
  }

  for (const edge of edges) {
    if (edge.sourceBucket === edge.targetBucket || edge.runtimeVia.size === 0) {
      continue;
    }

    graph.get(edge.sourceBucket)?.add(edge.targetBucket);
  }

  return graph;
}

function findStronglyConnectedComponents(graph: Map<DomainBucket, Set<DomainBucket>>): DomainBucket[][] {
  const indexByNode = new Map<DomainBucket, number>();
  const lowlinkByNode = new Map<DomainBucket, number>();
  const stack: DomainBucket[] = [];
  const onStack = new Set<DomainBucket>();
  const components: DomainBucket[][] = [];
  let nextIndex = 0;

  function strongConnect(node: DomainBucket): void {
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

    const component: DomainBucket[] = [];
    let current: DomainBucket;

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

function edgeKey(edge: ParsedEdge): string {
  return `${edge.source} -> ${edge.target}`;
}

function formatEdge(edge: ParsedEdge): string {
  return `${edgeKey(edge)} (${formatViaKinds(edge)})`;
}

function formatScc(scc: DomainBucket[]): string {
  return scc.join(' <-> ');
}

function isProviderSessionRuntimeEdge(edge: ParsedEdge): boolean {
  return (
    edge.runtimeVia.size > 0 &&
    ((edge.sourceBucket === 'providers' && edge.targetBucket === 'sessions') ||
      (edge.sourceBucket === 'sessions' && edge.targetBucket === 'providers'))
  );
}

function isAllowedProviderSessionRuntimeEdge(edge: ParsedEdge): boolean {
  return isProviderSessionRuntimeEdge(edge) && ALLOWED_PROVIDER_SESSION_RUNTIME_EDGES.has(edgeKey(edge));
}

describe('discuss architecture guard', () => {
  it('enforces discuss domain boundary (runtime + type-only) with a TypeScript-aware component graph', () => {
    const productionFilePaths = listProductionSourceFiles(SRC_ROOT);
    const parsedEdges = buildParsedEdges(productionFilePaths);
    const domainBucketNodes = new Set<DomainBucket>(
      productionFilePaths.map((filePath) => classifyDomainBucket(toCanonicalSrcPath(REPO_ROOT, filePath))),
    );
    const crossDomainEdges = parsedEdges.filter((edge) => edge.sourceBucket !== edge.targetBucket);
    const unexpectedProviderSessionRuntimeEdges = crossDomainEdges.filter((edge) => {
      return isProviderSessionRuntimeEdge(edge) && !isAllowedProviderSessionRuntimeEdge(edge);
    });
    const runtimeDomainGraph = buildRuntimeDomainGraph(
      domainBucketNodes,
      crossDomainEdges.filter((edge) => !isAllowedProviderSessionRuntimeEdge(edge)),
    );
    const runtimeDomainSccs = findStronglyConnectedComponents(runtimeDomainGraph).filter((scc) => scc.length > 1);

    const discussRuntimeImports = crossDomainEdges.filter((edge) => {
      return (
        edge.sourceBucket === 'discuss' &&
        edge.runtimeVia.size > 0 &&
        (edge.targetBucket === 'client' ||
          edge.targetBucket === 'execution' ||
          edge.targetBucket === 'execution/discuss')
      );
    });

    const invalidDiscussExecutionTypeOnlyImports = crossDomainEdges.filter((edge) => {
      return (
        edge.sourceBucket === 'discuss' &&
        edge.runtimeVia.size === 0 &&
        edge.typeOnlyVia.size > 0 &&
        edge.targetBucket === 'execution'
      );
    });

    const deferredDiscussDebt = crossDomainEdges.filter((edge) => {
      return (
        edge.sourceBucket === 'discuss' &&
        edge.runtimeVia.size === 0 &&
        edge.typeOnlyVia.size > 0 &&
        (edge.targetBucket === 'client' || edge.targetBucket === 'execution/discuss')
      );
    });

    console.info(
      runtimeDomainSccs.length === 0
        ? 'Runtime domain SCCs: none'
        : `Runtime domain SCCs:\n${runtimeDomainSccs.map((scc) => `- ${formatScc(scc)}`).join('\n')}`,
    );

    const failures: string[] = [];

    if (runtimeDomainSccs.length > 0) {
      failures.push(
        [
          'production runtime domain graph must be acyclic outside explicitly listed provider/session schema edges:',
          ...runtimeDomainSccs.map((scc) => `- ${formatScc(scc)}`),
        ].join('\n'),
      );
    }

    if (unexpectedProviderSessionRuntimeEdges.length > 0) {
      failures.push(
        [
          'provider/session runtime imports must stay on the explicit schema/artifact allowlist:',
          ...unexpectedProviderSessionRuntimeEdges.map((edge) => `- ${formatEdge(edge)}`),
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
