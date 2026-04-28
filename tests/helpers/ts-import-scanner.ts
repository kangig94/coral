import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export type EdgeSyntax = 'ImportDeclaration' | 'ExportDeclaration' | 'ImportTypeNode' | 'DynamicImport';

export type ParsedImportEdge = {
  source: string;
  target: string;
  specifier: string;
  via: EdgeSyntax;
  runtime: boolean;
  typeOnly: boolean;
};

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join('/');
}

export function toCanonicalSrcPath(repoRoot: string, filePath: string): string {
  const canonical = toPosixPath(relative(repoRoot, filePath));
  if (!canonical.startsWith('src/')) {
    throw new Error(`Expected a src/ path, got ${canonical}`);
  }
  return canonical;
}

export function listProductionSourceFiles(dirPath: string): string[] {
  // Test files and test directories are forbidden inside src; the
  // architecture-boundary invariant 'test code and test support must stay
  // out of src' is the canonical guard. This helper is therefore allowed
  // to assume it walks production sources only — it does not need to skip
  // any directory by name.
  const files: string[] = [];

  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...listProductionSourceFiles(entryPath));
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue;
    }

    files.push(entryPath);
  }

  return files.sort();
}

export function createProductionFileIndex(repoRoot: string, productionFilePaths: string[]): Set<string> {
  return new Set(productionFilePaths.map((filePath) => toCanonicalSrcPath(repoRoot, filePath)));
}

function getRelativeModuleSpecifier(moduleSpecifier: ts.Expression | undefined): string | null {
  if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) {
    return null;
  }

  return moduleSpecifier.text.startsWith('.') ? moduleSpecifier.text : null;
}

export function getRelativeImportTypeSpecifier(node: ts.ImportTypeNode): string | null {
  if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteralLike(node.argument.literal)) {
    return null;
  }

  return node.argument.literal.text.startsWith('.') ? node.argument.literal.text : null;
}

/**
 * Returns specifiers that match the project's `#src/*` subpath imports
 * (declared in package.json#imports as `"#src/*.js": "./src/*.ts"`).
 * Used by engine-blindness invariants to catch leaks of the form
 * `import { ... } from '#src/engines/...'` outside the documented wiring
 * points; complements `getRelativeModuleSpecifier`'s `.`-prefix coverage.
 */
export function getSubpathModuleSpecifier(specifier: string): string | undefined {
  return specifier.startsWith('#src/') ? specifier : undefined;
}

/**
 * Resolves a `#src/...` subpath specifier to the canonical `src/...` path
 * that the package.json#imports map points at. Mirrors the mapping
 * `#src/*.js → ./src/*.ts` and `#src/* → ./src/*` so import-graph
 * consumers see the same target shape that relative-path resolution
 * produces.
 */
export function resolveSubpathSourcePath(specifier: string): string {
  if (!specifier.startsWith('#src/')) {
    throw new Error(`Expected a #src/ specifier, got ${specifier}`);
  }

  const tail = specifier.slice('#src/'.length);
  return tail.endsWith('.js') ? `src/${tail.slice(0, -'.js'.length)}.ts` : `src/${tail}`;
}

export function resolveRelativeSourcePath(
  repoRoot: string,
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
    const canonicalCandidate = toCanonicalSrcPath(repoRoot, candidate);
    if (productionFiles.has(canonicalCandidate)) {
      return canonicalCandidate;
    }
  }

  throw new Error(`Unable to resolve ${specifier} from ${sourceCanonicalPath} to a production src/*.ts file`);
}

export function classifyImportDeclaration(node: ts.ImportDeclaration): { runtime: boolean; typeOnly: boolean } {
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

export function classifyExportDeclaration(node: ts.ExportDeclaration): { runtime: boolean; typeOnly: boolean } {
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

export function parseSourceImportEdges(
  repoRoot: string,
  sourceFilePath: string,
  productionFiles: Set<string>,
): ParsedImportEdge[] {
  const sourceCanonicalPath = toCanonicalSrcPath(repoRoot, sourceFilePath);
  const sourceText = readFileSync(sourceFilePath, 'utf-8');
  const sourceFile = ts.createSourceFile(sourceFilePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges: ParsedImportEdge[] = [];

  function recordEdge(
    specifier: string | null,
    via: EdgeSyntax,
    contribution: { runtime: boolean; typeOnly: boolean },
  ): void {
    if (!specifier) {
      return;
    }

    edges.push({
      source: sourceCanonicalPath,
      target: resolveRelativeSourcePath(repoRoot, sourceFilePath, sourceCanonicalPath, specifier, productionFiles),
      specifier,
      via,
      runtime: contribution.runtime,
      typeOnly: contribution.typeOnly,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      recordEdge(
        getRelativeModuleSpecifier(node.moduleSpecifier),
        'ImportDeclaration',
        classifyImportDeclaration(node),
      );
    } else if (ts.isExportDeclaration(node)) {
      recordEdge(
        getRelativeModuleSpecifier(node.moduleSpecifier),
        'ExportDeclaration',
        classifyExportDeclaration(node),
      );
    } else if (ts.isImportTypeNode(node)) {
      recordEdge(getRelativeImportTypeSpecifier(node), 'ImportTypeNode', { runtime: false, typeOnly: true });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const specifier = node.arguments[0].text;
      recordEdge(specifier.startsWith('.') ? specifier : null, 'DynamicImport', { runtime: true, typeOnly: false });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return edges.sort((left, right) => {
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
}

export type SubpathImportEdge = {
  source: string;
  target: string;
  specifier: string;
  via: EdgeSyntax;
};

/**
 * Walks the AST for `#src/...` subpath specifiers (static, type, and
 * dynamic imports). Returns one edge per occurrence with the resolved
 * `src/...` target path. Sibling collector to `parseSourceImportEdges`
 * — additive, does not reshape the existing relative-edge stream.
 */
export function parseSourceSubpathImportEdges(repoRoot: string, sourceFilePath: string): SubpathImportEdge[] {
  const sourceCanonicalPath = toCanonicalSrcPath(repoRoot, sourceFilePath);
  const sourceText = readFileSync(sourceFilePath, 'utf-8');
  const sourceFile = ts.createSourceFile(sourceFilePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges: SubpathImportEdge[] = [];

  function recordEdge(specifier: string | undefined, via: EdgeSyntax): void {
    if (!specifier) {
      return;
    }
    edges.push({
      source: sourceCanonicalPath,
      target: resolveSubpathSourcePath(specifier),
      specifier,
      via,
    });
  }

  function readStringLiteral(expression: ts.Expression | undefined): string | undefined {
    return expression && ts.isStringLiteralLike(expression) ? expression.text : undefined;
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      recordEdge(getSubpathModuleSpecifier(readStringLiteral(node.moduleSpecifier) ?? ''), 'ImportDeclaration');
    } else if (ts.isExportDeclaration(node)) {
      recordEdge(getSubpathModuleSpecifier(readStringLiteral(node.moduleSpecifier) ?? ''), 'ExportDeclaration');
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      recordEdge(getSubpathModuleSpecifier(node.argument.literal.text), 'ImportTypeNode');
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      recordEdge(getSubpathModuleSpecifier(node.arguments[0].text), 'DynamicImport');
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return edges;
}

export function parseProductionImportEdges(
  repoRoot: string,
  productionFilePaths: string[],
  resolutionFilePaths: string[] = productionFilePaths,
): ParsedImportEdge[] {
  const productionFiles = createProductionFileIndex(repoRoot, resolutionFilePaths);
  const parsedEdges: ParsedImportEdge[] = [];

  for (const sourceFilePath of productionFilePaths) {
    parsedEdges.push(...parseSourceImportEdges(repoRoot, sourceFilePath, productionFiles));
  }

  return parsedEdges.sort((left, right) => {
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
}

export function findStronglyConnectedComponents(nodes: string[], edges: ParsedImportEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    adjacency.set(node, []);
  }

  for (const edge of edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) {
      continue;
    }
    adjacency.get(edge.source)?.push(edge.target);
  }

  const indexByNode = new Map<string, number>();
  const lowLinkByNode = new Map<string, number>();
  const activeStack: string[] = [];
  const activeNodes = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  function visit(node: string): void {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;
    activeStack.push(node);
    activeNodes.add(node);

    for (const target of adjacency.get(node) ?? []) {
      if (!indexByNode.has(target)) {
        visit(target);
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node) ?? 0, lowLinkByNode.get(target) ?? 0));
      } else if (activeNodes.has(target)) {
        lowLinkByNode.set(node, Math.min(lowLinkByNode.get(node) ?? 0, indexByNode.get(target) ?? 0));
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) {
      return;
    }

    const component: string[] = [];
    let current: string | undefined;
    do {
      current = activeStack.pop();
      if (current === undefined) {
        throw new Error(`Tarjan traversal underflow while visiting ${node}`);
      }
      activeNodes.delete(current);
      component.push(current);
    } while (current !== node);

    components.push(component.sort((left, right) => left.localeCompare(right)));
  }

  for (const node of nodes) {
    if (!indexByNode.has(node)) {
      visit(node);
    }
  }

  return components.sort((left, right) => left[0].localeCompare(right[0]));
}
