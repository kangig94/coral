import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const SRC_ROOT = resolve(dirname(__filename), '../..');
const REPO_ROOT = resolve(SRC_ROOT, '..');

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
  'coral',
  'hooks',
  'skills',
] as const;

type Subsystem = (typeof SUBSYSTEM_PREFIXES)[number];
type EdgeSyntax = 'ImportDeclaration' | 'ExportDeclaration' | 'ImportTypeNode';

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

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join('/');
}

function toCanonicalSrcPath(filePath: string): string {
  const canonical = toPosixPath(relative(REPO_ROOT, filePath));
  if (!canonical.startsWith('src/')) {
    throw new Error(`Expected a src/ path, got ${canonical}`);
  }
  return canonical;
}

function listProductionSourceFiles(dirPath: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === '__tests__') {
        continue;
      }
      files.push(...listProductionSourceFiles(entryPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
      continue;
    }

    files.push(entryPath);
  }

  return files.sort();
}

function classifySubsystem(canonicalPath: string): Subsystem {
  const sourceRelativePath = canonicalPath.slice('src/'.length);

  for (const prefix of SUBSYSTEM_PREFIXES) {
    if (sourceRelativePath === prefix || sourceRelativePath.startsWith(`${prefix}/`)) {
      return prefix;
    }
  }

  throw new Error(`No subsystem bucket matched ${canonicalPath}`);
}

function getRelativeModuleSpecifier(moduleSpecifier: ts.Expression | undefined): string | null {
  if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) {
    return null;
  }

  return moduleSpecifier.text.startsWith('.') ? moduleSpecifier.text : null;
}

function getRelativeImportTypeSpecifier(node: ts.ImportTypeNode): string | null {
  if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteralLike(node.argument.literal)) {
    return null;
  }

  return node.argument.literal.text.startsWith('.') ? node.argument.literal.text : null;
}

function resolveRelativeSourcePath(
  sourceFilePath: string,
  sourceCanonicalPath: string,
  specifier: string,
  productionFiles: Set<string>,
): string {
  const resolvedBase = resolve(dirname(sourceFilePath), specifier);
  const extension = extname(resolvedBase);
  const candidates =
    extension === '.js'
      ? [resolvedBase.slice(0, -3) + '.ts']
      : extension === '.ts'
        ? [resolvedBase]
        : extension === ''
          ? [`${resolvedBase}.ts`, join(resolvedBase, 'index.ts')]
          : [];

  for (const candidate of candidates) {
    const canonicalCandidate = toCanonicalSrcPath(candidate);
    if (productionFiles.has(canonicalCandidate)) {
      return canonicalCandidate;
    }
  }

  throw new Error(`Unable to resolve ${specifier} from ${sourceCanonicalPath} to a production src/*.ts file`);
}

function classifyImportDeclaration(node: ts.ImportDeclaration): { runtime: boolean; typeOnly: boolean } {
  const clause = node.importClause;

  if (!clause) {
    return { runtime: true, typeOnly: false };
  }

  if (clause.isTypeOnly) {
    return { runtime: false, typeOnly: true };
  }

  let runtime = Boolean(clause.name);
  let typeOnly = false;

  const bindings = clause.namedBindings;
  if (!bindings) {
    return { runtime, typeOnly };
  }

  if (ts.isNamespaceImport(bindings)) {
    return { runtime: true, typeOnly };
  }

  if (bindings.elements.length === 0) {
    return { runtime: true, typeOnly };
  }

  runtime ||= bindings.elements.some((element) => !element.isTypeOnly);
  typeOnly ||= bindings.elements.some((element) => element.isTypeOnly);

  return { runtime, typeOnly };
}

function classifyExportDeclaration(node: ts.ExportDeclaration): { runtime: boolean; typeOnly: boolean } {
  if (node.isTypeOnly) {
    return { runtime: false, typeOnly: true };
  }

  const clause = node.exportClause;
  if (!clause) {
    return { runtime: true, typeOnly: false };
  }

  if (ts.isNamespaceExport(clause)) {
    return { runtime: true, typeOnly: false };
  }

  if (clause.elements.length === 0) {
    return { runtime: true, typeOnly: false };
  }

  return {
    runtime: clause.elements.some((element) => !element.isTypeOnly),
    typeOnly: clause.elements.some((element) => element.isTypeOnly),
  };
}

function parseSourceEdges(sourceFilePath: string, productionFiles: Set<string>): EdgeAccumulator[] {
  const sourceCanonicalPath = toCanonicalSrcPath(sourceFilePath);
  const sourceText = readFileSync(sourceFilePath, 'utf-8');
  const sourceFile = ts.createSourceFile(sourceFilePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges = new Map<string, EdgeAccumulator>();

  function recordEdge(
    specifier: string | null,
    via: EdgeSyntax,
    contribution: { runtime: boolean; typeOnly: boolean },
  ): void {
    if (!specifier) {
      return;
    }

    const target = resolveRelativeSourcePath(sourceFilePath, sourceCanonicalPath, specifier, productionFiles);
    const edge = edges.get(target) ?? {
      source: sourceCanonicalPath,
      target,
      runtimeVia: new Set<EdgeSyntax>(),
      typeOnlyVia: new Set<EdgeSyntax>(),
    };

    if (contribution.runtime) {
      edge.runtimeVia.add(via);
    }

    if (contribution.typeOnly) {
      edge.typeOnlyVia.add(via);
    }

    edges.set(target, edge);
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      recordEdge(getRelativeModuleSpecifier(node.moduleSpecifier), 'ImportDeclaration', classifyImportDeclaration(node));
    } else if (ts.isExportDeclaration(node)) {
      recordEdge(getRelativeModuleSpecifier(node.moduleSpecifier), 'ExportDeclaration', classifyExportDeclaration(node));
    } else if (ts.isImportTypeNode(node)) {
      recordEdge(getRelativeImportTypeSpecifier(node), 'ImportTypeNode', { runtime: false, typeOnly: true });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return [...edges.values()].sort((left, right) => {
    if (left.source !== right.source) {
      return left.source.localeCompare(right.source);
    }
    return left.target.localeCompare(right.target);
  });
}

function buildParsedEdges(productionFilePaths: string[]): ParsedEdge[] {
  const productionFiles = new Set(productionFilePaths.map((filePath) => toCanonicalSrcPath(filePath)));
  const parsedEdges: ParsedEdge[] = [];

  for (const sourceFilePath of productionFilePaths) {
    for (const edge of parseSourceEdges(sourceFilePath, productionFiles)) {
      parsedEdges.push({
        ...edge,
        sourceSubsystem: classifySubsystem(edge.source),
        targetSubsystem: classifySubsystem(edge.target),
      });
    }
  }

  return parsedEdges.sort((left, right) => {
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
  it('enforces Batch A discuss runtime boundaries with a TypeScript-aware subsystem graph', () => {
    const productionFilePaths = listProductionSourceFiles(SRC_ROOT);
    const parsedEdges = buildParsedEdges(productionFilePaths);
    const subsystemNodes = new Set<Subsystem>(
      productionFilePaths.map((filePath) => classifySubsystem(toCanonicalSrcPath(filePath))),
    );
    const crossSubsystemEdges = parsedEdges.filter((edge) => edge.sourceSubsystem !== edge.targetSubsystem);
    const runtimeSubsystemGraph = buildRuntimeSubsystemGraph(subsystemNodes, crossSubsystemEdges);
    const runtimeSubsystemSccs = findStronglyConnectedComponents(runtimeSubsystemGraph).filter((scc) => scc.length > 1);

    const discussRuntimeImports = crossSubsystemEdges.filter((edge) => {
      return edge.sourceSubsystem === 'discuss'
        && edge.runtimeVia.size > 0
        && (edge.targetSubsystem === 'client'
          || edge.targetSubsystem === 'execution'
          || edge.targetSubsystem === 'execution/discuss');
    });

    const invalidDiscussExecutionTypeOnlyImports = crossSubsystemEdges.filter((edge) => {
      return edge.sourceSubsystem === 'discuss'
        && edge.runtimeVia.size === 0
        && edge.typeOnlyVia.size > 0
        && edge.targetSubsystem === 'execution';
    });

    const deferredDiscussDebt = crossSubsystemEdges.filter((edge) => {
      return edge.sourceSubsystem === 'discuss'
        && edge.runtimeVia.size === 0
        && edge.typeOnlyVia.size > 0
        && (edge.targetSubsystem === 'client' || edge.targetSubsystem === 'execution/discuss');
    });

    const discussRuntimeSccViolations = runtimeSubsystemSccs.filter((scc) => {
      return scc.includes('discuss')
        && (scc.includes('client') || scc.includes('execution') || scc.includes('execution/discuss'));
    });

    const nonDiscussRuntimeSccs = runtimeSubsystemSccs.filter((scc) => !scc.includes('discuss'));

    console.info(
      runtimeSubsystemSccs.length === 0
        ? 'AC6 runtime subsystem SCCs: none'
        : `AC6 runtime subsystem SCCs:\n${runtimeSubsystemSccs.map((scc) => `- ${formatScc(scc)}`).join('\n')}`,
    );

    console.info(
      nonDiscussRuntimeSccs.length === 0
        ? 'AC6 informational non-discuss runtime SCCs: none'
        : `AC6 informational non-discuss runtime SCCs:\n${nonDiscussRuntimeSccs.map((scc) => `- ${formatScc(scc)}`).join('\n')}`,
    );

    console.info(
      deferredDiscussDebt.length === 0
        ? 'AC6 deferred architecture debt: none'
        : [
          'AC6 deferred architecture debt outside Batch A runtime enforcement:',
          ...deferredDiscussDebt.map((edge) => `- ${formatEdge(edge)}`),
        ].join('\n'),
    );

    const failures: string[] = [];

    if (discussRuntimeSccViolations.length > 0) {
      failures.push([
        'src/discuss participates in a forbidden runtime subsystem SCC:',
        ...discussRuntimeSccViolations.map((scc) => `- ${formatScc(scc)}`),
      ].join('\n'));
    }

    if (discussRuntimeImports.length > 0) {
      failures.push([
        'src/discuss must not runtime-import src/client/* or src/execution/*:',
        ...discussRuntimeImports.map((edge) => `- ${formatEdge(edge)}`),
      ].join('\n'));
    }

    if (invalidDiscussExecutionTypeOnlyImports.length > 0) {
      failures.push([
        'src/discuss type-only imports from src/execution/* must target src/execution/discuss/*:',
        ...invalidDiscussExecutionTypeOnlyImports.map((edge) => `- ${formatEdge(edge)}`),
      ].join('\n'));
    }

    if (failures.length > 0) {
      expect.fail([
        'Batch A discuss runtime boundary violations:',
        ...failures,
      ].join('\n\n'));
    }
  });
});
