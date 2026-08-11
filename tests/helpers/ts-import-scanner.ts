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

/**
 * True for the two importable spellings that reach another production
 * src/ file: a relative path (`./foo.js`) or the project's `#src/*`
 * subpath alias (`#src/foo.js`, declared in package.json#imports as
 * `"#src/*.js": "./src/*.ts"`). Checked before the relative-path prefix so
 * a `#src/` specifier is never mistaken for the bare-package-name case
 * that `.`-prefix filtering exists to exclude. A specifier landing outside
 * src/ (a real package name, `#tests/*`, `#tools/*`) is not tracked.
 */
function isTrackedSpecifierText(text: string): boolean {
  if (text.startsWith('#src/')) {
    return true;
  }
  if (!text.startsWith('.')) {
    return false;
  }
  const extension = extname(text);
  return extension === '' || extension === '.js' || extension === '.ts';
}

function getTrackedModuleSpecifier(moduleSpecifier: ts.Expression | undefined): string | null {
  if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) {
    return null;
  }

  return isTrackedSpecifierText(moduleSpecifier.text) ? moduleSpecifier.text : null;
}

export function getTrackedImportTypeSpecifier(node: ts.ImportTypeNode): string | null {
  if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteralLike(node.argument.literal)) {
    return null;
  }

  return isTrackedSpecifierText(node.argument.literal.text) ? node.argument.literal.text : null;
}

/**
 * Resolves a `#src/...` subpath specifier to the canonical `src/...` path
 * that the package.json#imports map points at. Mirrors the mapping
 * `#src/*.js → ./src/*.ts` and `#src/* → ./src/*` so `resolveTrackedSourcePath`
 * can hand back the same target shape that relative-path resolution produces.
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

/**
 * Resolves any specifier `isTrackedSpecifierText` accepts to its canonical
 * `src/...` target — the single resolution path `parseSourceImportEdges`
 * calls, so the edge list it produces is complete for both spellings
 * production code uses to reach another src/ file. A `#src/` specifier
 * resolves by direct package.json#imports mapping rather than by
 * directory-relative lookup, since it is not relative to `sourceFilePath`.
 */
function resolveTrackedSourcePath(
  repoRoot: string,
  sourceFilePath: string,
  sourceCanonicalPath: string,
  specifier: string,
  productionFiles: Set<string>,
): string {
  if (!specifier.startsWith('#src/')) {
    return resolveRelativeSourcePath(repoRoot, sourceFilePath, sourceCanonicalPath, specifier, productionFiles);
  }

  const canonicalCandidate = resolveSubpathSourcePath(specifier);
  if (productionFiles.has(canonicalCandidate)) {
    return canonicalCandidate;
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
      target: resolveTrackedSourcePath(repoRoot, sourceFilePath, sourceCanonicalPath, specifier, productionFiles),
      specifier,
      via,
      runtime: contribution.runtime,
      typeOnly: contribution.typeOnly,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      recordEdge(getTrackedModuleSpecifier(node.moduleSpecifier), 'ImportDeclaration', classifyImportDeclaration(node));
    } else if (ts.isExportDeclaration(node)) {
      recordEdge(getTrackedModuleSpecifier(node.moduleSpecifier), 'ExportDeclaration', classifyExportDeclaration(node));
    } else if (ts.isImportTypeNode(node)) {
      recordEdge(getTrackedImportTypeSpecifier(node), 'ImportTypeNode', { runtime: false, typeOnly: true });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const specifier = node.arguments[0].text;
      recordEdge(isTrackedSpecifierText(specifier) ? specifier : null, 'DynamicImport', {
        runtime: true,
        typeOnly: false,
      });
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
