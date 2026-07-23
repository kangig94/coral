import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const BACKEND_STORE_RESET_PATH = 'src/store/backend-store-reset.ts';
const READ_PORT_PATH = 'src/store/read-port.ts';

type CallHit = {
  relativePath: string;
  line: number;
  callee: string;
  enclosingFunctions: readonly string[];
  text: string;
};

function toRepoPath(path: string): string {
  return relative(REPO_ROOT, path).split('\\').join('/');
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        return listSourceFiles(path);
      }
      return path.endsWith('.ts') ? [path] : [];
    })
    .sort();
}

const sourceFileCache = new Map<string, ts.SourceFile>();

function sourceFile(relativePath: string): ts.SourceFile {
  const cached = sourceFileCache.get(relativePath);
  if (cached !== undefined) return cached;
  const absolutePath = join(REPO_ROOT, relativePath);
  const parsed = ts.createSourceFile(absolutePath, readFileSync(absolutePath, 'utf8'), ts.ScriptTarget.Latest, true);
  sourceFileCache.set(relativePath, parsed);
  return parsed;
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return null;
}

function functionName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node) && node.name) {
    return propertyNameText(node.name);
  }
  if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isVariableDeclaration(node.parent)) {
    return ts.isIdentifier(node.parent.name) ? node.parent.name.text : null;
  }
  return null;
}

function enclosingFunctionNames(node: ts.Node): string[] {
  const names: string[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    const name = functionName(current);
    if (name !== null) {
      names.push(name);
    }
    current = current.parent;
  }
  return names;
}

function collectCalls(relativePath: string): CallHit[] {
  const source = sourceFile(relativePath);
  const hits: CallHit[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      if (callee !== null) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        hits.push({
          relativePath,
          line: position.line + 1,
          callee,
          enclosingFunctions: enclosingFunctionNames(node),
          text: node.getText(source),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return hits;
}

function findFunction(relativePath: string, name: string): ts.FunctionDeclaration {
  const source = sourceFile(relativePath);
  let match: ts.FunctionDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (match === null) {
    throw new Error(`Missing function ${name} in ${relativePath}`);
  }
  return match;
}

let allSourcePathsCache: string[] | null = null;
let allSourcePathSetCache: Set<string> | null = null;

function allSourcePaths(): string[] {
  allSourcePathsCache ??= listSourceFiles(SRC_ROOT).map(toRepoPath);
  return allSourcePathsCache;
}

function allSourcePathSet(): Set<string> {
  allSourcePathSetCache ??= new Set(allSourcePaths());
  return allSourcePathSetCache;
}

function resolveSourceImport(from: string, specifier: string): string | null {
  let candidate: string;
  if (specifier.startsWith('#src/')) {
    candidate = join(REPO_ROOT, 'src', specifier.slice('#src/'.length));
  } else if (specifier.startsWith('.')) {
    candidate = resolve(REPO_ROOT, dirname(from), specifier);
  } else {
    return null;
  }
  const normalized = normalize(candidate).replace(/\.js$/u, '.ts').replaceAll('\\', '/');
  const repoPath = toRepoPath(normalized);
  const sourcePaths = allSourcePathSet();
  if (repoPath.startsWith('src/') && sourcePaths.has(repoPath)) return repoPath;
  const indexPath = repoPath.replace(/\/?$/u, '/index.ts');
  return sourcePaths.has(indexPath) ? indexPath : null;
}

function sourceImports(relativePath: string): string[] {
  const source = sourceFile(relativePath);
  return source.statements.filter(ts.isImportDeclaration).flatMap((statement) => {
    const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
    const resolved = resolveSourceImport(relativePath, specifier);
    return resolved === null ? [] : [resolved];
  });
}

function importClosure(roots: readonly string[]): Set<string> {
  const visited = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || visited.has(next)) continue;
    visited.add(next);
    pending.push(...sourceImports(next));
  }
  return visited;
}

describe('store reset discipline invariants', () => {
  // Note: these invariants check direct call sites within the named function
  // body - transitive calls (helper-of-helper invoking a forbidden symbol)
  // are not flagged. The import-list check provides a coarser net catching
  // module-level introduction of the forbidden symbols.
  it('keeps the read-only opener free of schema execution, reset authority, and store-file quarantine', () => {
    const source = sourceFile(READ_PORT_PATH);
    const calls = collectCalls(READ_PORT_PATH).filter((call) =>
      call.enclosingFunctions.includes('openReadOnlyStoreDatabase'),
    );
    const forbiddenCalls = calls
      .filter((call) =>
        [
          'applyBundledStoreSchema',
          'openOrResetBackendStoreDb',
          'createBackendStoreResetAuthority',
          'quarantineStoreFiles',
          'rmSync',
          'unlinkSync',
        ].includes(call.callee),
      )
      .map((call) => `${call.relativePath}:${call.line} ${call.text}`);
    const forbiddenImports = source.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => statement.getText(source))
      .filter((text) =>
        /openOrResetBackendStoreDb|createBackendStoreResetAuthority|quarantineStoreFiles|applyBundledStoreSchema/.test(
          text,
        ),
      );

    expect(forbiddenImports).toEqual([]);
    expect(forbiddenCalls).toEqual([]);
  });

  it('keeps store file quarantine in openOrResetBackendStoreDb behind BackendStoreResetAuthority', () => {
    const resetFunction = findFunction(BACKEND_STORE_RESET_PATH, 'openOrResetBackendStoreDb');
    const authorityParam = resetFunction.parameters[1];
    const calls = collectCalls(BACKEND_STORE_RESET_PATH);
    const quarantineStoreFileCalls = calls
      .filter((call) => call.callee === 'publishIncident')
      .map((call) => `${call.relativePath}:${call.line}:${call.enclosingFunctions[0] ?? '<top>'}`);
    const directStoreUnlinks = allSourcePaths()
      .flatMap((relativePath) =>
        collectCalls(relativePath)
          .filter((call) => call.callee === 'rmSync' || call.callee === 'unlinkSync')
          .filter((call) => /store\.db|walFile|shmFile|coral\.store/.test(call.text))
          .map((call) => `${call.relativePath}:${call.line} ${call.text}`),
      )
      .sort();

    expect(authorityParam?.name.getText(sourceFile(BACKEND_STORE_RESET_PATH))).toBe('authority');
    expect(authorityParam?.type?.getText(sourceFile(BACKEND_STORE_RESET_PATH))).toBe('BackendStoreResetAuthority');
    expect(quarantineStoreFileCalls).toEqual([
      expect.stringMatching(/^src\/store\/backend-store-reset\.ts:\d+:openOrResetBackendStoreDb$/),
    ]);
    expect(directStoreUnlinks).toEqual([]);
  });

  it('keeps publishIncident ordered after reset-lock acquisition', () => {
    const source = sourceFile(BACKEND_STORE_RESET_PATH);
    const resetFunction = findFunction(BACKEND_STORE_RESET_PATH, 'openOrResetBackendStoreDb');
    const body = resetFunction.body;
    expect(body).toBeDefined();
    const bodyText = body?.getText(source) ?? '';
    const lockIndex = bodyText.indexOf('acquireDirectoryLockSync(');
    const quarantineIndex = bodyText.indexOf('publishIncident(');

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(quarantineIndex).toBeGreaterThan(lockIndex);
  });

  it('keeps every store-reset support import closure outside reset authority and generic DB openers', () => {
    const supportRoots = [
      'src/cli/store-reset.ts',
      'src/cli/format/store-reset.ts',
      'src/store/reset-incident-reader.ts',
      'src/store/reset-incident-diagnostic.ts',
      'src/store/reset-incident-inspection-fs.ts',
      'src/infra/store-reset-inspection-fs.ts',
      'src/infra/store-reset-diagnostic-supervisor.ts',
    ];
    const supportClosure = importClosure(supportRoots);
    const cliClosure = importClosure(['src/cli/bootstrap.ts']);

    expect(supportClosure.has(BACKEND_STORE_RESET_PATH)).toBe(false);
    expect(supportClosure.has('src/store/db.ts')).toBe(false);
    expect(cliClosure.has(BACKEND_STORE_RESET_PATH)).toBe(false);
  });

  it('keeps lifecycle as the sole production importer of the backend reset boundary', () => {
    const importers = allSourcePaths()
      .filter((path) => sourceImports(path).includes(BACKEND_STORE_RESET_PATH))
      .sort();
    expect(importers).toEqual(['src/coordinator/lifecycle.ts']);

    const symbolAllowlist = new Set([BACKEND_STORE_RESET_PATH, 'src/coordinator/lifecycle.ts']);
    const forbiddenReferences = allSourcePaths()
      .filter((path) => !symbolAllowlist.has(path))
      .flatMap((path) => {
        const source = readFileSync(join(REPO_ROOT, path), 'utf8');
        return /createBackendStoreResetAuthority|openOrResetBackendStoreDb|publishIncident/u.test(source) ? [path] : [];
      });
    expect(forbiddenReferences).toEqual([]);
  });
});
