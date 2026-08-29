// TypeScript under tests and tools/testing, except integration and e2e, must not import or directly access
// DatabaseSync or openStoreDatabase from their defining modules outside the checked doors.
// Computed non-literal access, Reflect.get, and factories returning an opener are intentionally out of scope
// because recognizing them would require inference.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { STORE_DOOR_ACQUISITION_NEGATIVE_CONTROL } from '#tests/fixtures/store-door-bypass-negative-control.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORE_DB_SOURCE = resolve(REPO_ROOT, 'src/store/db.ts');
const MODULE_RESOLUTION_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  resolvePackageJsonImports: true,
};
const STORE_DOOR_SCAN_ROOTS = ['tests', 'tools/testing'] as const;
const STORE_DOOR_SCAN_EXCLUSIONS = new Set([resolve(REPO_ROOT, 'tests/integration'), resolve(REPO_ROOT, 'tests/e2e')]);
const STORE_DOOR_MODULES = new Set(['tests/helpers/store-db.ts', 'tests/helpers/test-db.ts']);

type StoreAcquisition = Readonly<{
  file: string;
  line: number;
  kind: 'DatabaseSync acquisition' | 'openStoreDatabase acquisition';
  text: string;
}>;

type SourceReader = (file: string) => string;

function isTypeScriptSource(fileName: string): boolean {
  return /\.(?:[cm]?ts|tsx)$/u.test(fileName);
}

function sourceFilesUnder(root: string): string[] {
  const files: string[] = [];
  const directories = [resolve(REPO_ROOT, root)];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !STORE_DOOR_SCAN_EXCLUSIONS.has(path)) directories.push(path);
      else if (entry.isFile() && isTypeScriptSource(entry.name)) files.push(path);
    }
  }
  return files;
}

function importedName(specifier: ts.ImportSpecifier): string {
  return specifier.propertyName?.text ?? specifier.name.text;
}

function resolvesToStoreDb(moduleSpecifier: string, containingFile: string): boolean {
  const resolvedModule = ts.resolveModuleName(
    moduleSpecifier,
    resolve(REPO_ROOT, containingFile),
    MODULE_RESOLUTION_OPTIONS,
    ts.sys,
  ).resolvedModule;
  return resolvedModule !== undefined && resolve(resolvedModule.resolvedFileName) === STORE_DB_SOURCE;
}

function namespaceBinding(expression: ts.Expression): ts.Identifier | null {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current : null;
}

function accessedProperty(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
}

function bindingProperty(element: ts.BindingElement): string | null {
  const property = element.propertyName ?? element.name;
  return ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : null;
}

function typeCheckerFor(source: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { ...MODULE_RESOLUTION_OPTIONS, noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(fileName) === source.fileName
      ? source
      : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  return ts.createProgram([source.fileName], options, host).getTypeChecker();
}

function storeAcquisitionsIn(file: string, sourceText: string): StoreAcquisition[] {
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(resolve(REPO_ROOT, file), sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const sqliteNamespaceImports: ts.NamespaceImport[] = [];
  const storeNamespaceImports: ts.NamespaceImport[] = [];
  const acquisitions: StoreAcquisition[] = [];
  const record = (node: ts.Node, kind: StoreAcquisition['kind']): void => {
    acquisitions.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      kind,
      text: node.getText(source),
    });
  };

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    const imports = statement.importClause?.namedBindings;
    if (imports === undefined) continue;

    if (ts.isNamedImports(imports)) {
      for (const specifier of imports.elements) {
        if (moduleSpecifier === 'node:sqlite' && importedName(specifier) === 'DatabaseSync') {
          record(specifier, 'DatabaseSync acquisition');
        }
        if (importedName(specifier) === 'openStoreDatabase' && resolvesToStoreDb(moduleSpecifier, file)) {
          record(specifier, 'openStoreDatabase acquisition');
        }
      }
      continue;
    }

    if (moduleSpecifier === 'node:sqlite') sqliteNamespaceImports.push(imports);
    if (resolvesToStoreDb(moduleSpecifier, file)) storeNamespaceImports.push(imports);
  }

  const checker =
    sqliteNamespaceImports.length > 0 || storeNamespaceImports.length > 0 ? typeCheckerFor(source) : undefined;
  const sqliteNamespaces = new Set(
    sqliteNamespaceImports.flatMap((namespaceImport) => checker?.getSymbolAtLocation(namespaceImport.name) ?? []),
  );
  const storeNamespaces = new Set(
    storeNamespaceImports.flatMap((namespaceImport) => checker?.getSymbolAtLocation(namespaceImport.name) ?? []),
  );

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined) {
      const binding = namespaceBinding(node.initializer);
      const bindingSymbol = binding === null ? undefined : checker?.getSymbolAtLocation(binding);
      for (const element of node.name.elements) {
        const property = bindingProperty(element);
        if (bindingSymbol !== undefined && sqliteNamespaces.has(bindingSymbol) && property === 'DatabaseSync') {
          record(element, 'DatabaseSync acquisition');
        }
        if (bindingSymbol !== undefined && storeNamespaces.has(bindingSymbol) && property === 'openStoreDatabase') {
          record(element, 'openStoreDatabase acquisition');
        }
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const moduleSpecifier = node.arguments[0];
      if (moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier)) {
        if (moduleSpecifier.text === 'node:sqlite') record(node, 'DatabaseSync acquisition');
        if (resolvesToStoreDb(moduleSpecifier.text, file)) record(node, 'openStoreDatabase acquisition');
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const binding = namespaceBinding(node.expression);
      const bindingSymbol = binding === null ? undefined : checker?.getSymbolAtLocation(binding);
      const property = accessedProperty(node);
      if (bindingSymbol !== undefined && sqliteNamespaces.has(bindingSymbol) && property === 'DatabaseSync') {
        record(node, 'DatabaseSync acquisition');
      }
      if (bindingSymbol !== undefined && storeNamespaces.has(bindingSymbol) && property === 'openStoreDatabase') {
        record(node, 'openStoreDatabase acquisition');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return acquisitions;
}

function scannedSourceFiles(): string[] {
  return STORE_DOOR_SCAN_ROOTS.flatMap(sourceFilesUnder).sort();
}

function testSupportStoreAcquisitions(files: readonly string[], readSource: SourceReader): StoreAcquisition[] {
  return files.flatMap((filePath) => {
    const canonicalPath = relative(REPO_ROOT, filePath).replaceAll('\\', '/');
    const acquisitions = storeAcquisitionsIn(canonicalPath, readSource(filePath));
    return STORE_DOOR_MODULES.has(canonicalPath) ? [] : acquisitions;
  });
}

describe('test-support database doors', () => {
  it('contains no store-opening acquisition outside the checked doors', () => {
    expect(testSupportStoreAcquisitions(scannedSourceFiles(), (file) => readFileSync(file, 'utf-8'))).toEqual([]);
  });

  it('scans support and door modules while excluding integration and e2e', () => {
    const files = scannedSourceFiles();

    expect(files).toContain(resolve(REPO_ROOT, 'tests/support/control-exchange.ts'));
    expect(files).toContain(resolve(REPO_ROOT, 'tests/helpers/store-db.ts'));
    expect(files).toContain(resolve(REPO_ROOT, 'tests/helpers/test-db.ts'));
    expect(files.some((file) => file.startsWith(resolve(REPO_ROOT, 'tests/integration')))).toBe(false);
    expect(files.some((file) => file.startsWith(resolve(REPO_ROOT, 'tests/e2e')))).toBe(false);
  });

  it('recognizes every TypeScript source extension', () => {
    expect(['case.ts', 'case.tsx', 'case.mts', 'case.cts'].filter(isTypeScriptSource)).toEqual([
      'case.ts',
      'case.tsx',
      'case.mts',
      'case.cts',
    ]);
    expect(isTypeScriptSource('case.js')).toBe(false);
  });

  it('rejects named and namespace acquisitions from the exact modules', () => {
    const source = `
      import { DatabaseSync as Sqlite } from 'node:sqlite';
      import * as sqlite from 'node:sqlite';
      import { openStoreDatabase as openStore } from '../src/store/db.js';
      import * as store from '#src/store/db.js';
      const api = { open: store.openStoreDatabase };
      Reflect.construct(sqlite.DatabaseSync, [path]);
      (store satisfies typeof store).openStoreDatabase;
      ((<typeof sqlite>sqlite).DatabaseSync);
    `;

    expect(storeAcquisitionsIn('tests/fixture.ts', source).map((acquisition) => acquisition.kind)).toEqual([
      'DatabaseSync acquisition',
      'openStoreDatabase acquisition',
      'openStoreDatabase acquisition',
      'DatabaseSync acquisition',
      'openStoreDatabase acquisition',
      'DatabaseSync acquisition',
    ]);
  });

  it('rejects plain and renamed destructuring from namespace bindings', () => {
    const source = `
      import * as sqlite from 'node:sqlite';
      import * as store from '#src/store/db.js';
      const { DatabaseSync } = sqlite;
      const { DatabaseSync: Sqlite } = sqlite;
      const { openStoreDatabase } = store;
      const { openStoreDatabase: openStore } = store;
    `;

    expect(storeAcquisitionsIn('tests/fixture.ts', source).map((acquisition) => acquisition.kind)).toEqual([
      'DatabaseSync acquisition',
      'DatabaseSync acquisition',
      'openStoreDatabase acquisition',
      'openStoreDatabase acquisition',
    ]);
  });

  it('rejects literal dynamic imports of the exact modules', () => {
    const source = `
      const sqlite = await import('node:sqlite');
      const store = await import('../src/store/db.js');
    `;

    expect(storeAcquisitionsIn('tests/fixture.ts', source).map((acquisition) => acquisition.kind)).toEqual([
      'DatabaseSync acquisition',
      'openStoreDatabase acquisition',
    ]);
  });

  it('accepts unrelated names, checked doors, and namespace spies', () => {
    const source = `
      import { DatabaseSync } from 'unrelated-sqlite';
      import { openStoreDatabase } from 'unrelated-store';
      import * as sqlite from 'node:sqlite';
      import * as dbModule from '#src/store/db.js';
      function useAdapter(DatabaseSync) {
        new DatabaseSync(path);
        adapter.openStoreDatabase();
        openStoreDatabase();
      }
      function useShadowedNamespaces(sqlite, dbModule) {
        sqlite.DatabaseSync;
        dbModule.openStoreDatabase;
      }
      openTestStoreDb(runtime, path);
      openKbTestStoreDb(path);
      newRawDatabase(path);
      vi.spyOn(sqlite, 'DatabaseSync');
      vi.spyOn(dbModule, 'openStoreDatabase');
    `;

    expect(storeAcquisitionsIn('tests/fixture.ts', source)).toEqual([]);
  });

  it('drives the integrated scan and reader over a violating synthetic entry', () => {
    const syntheticFile = resolve(REPO_ROOT, 'tests/support/store-door-negative-control.ts');

    expect(testSupportStoreAcquisitions([syntheticFile], () => STORE_DOOR_ACQUISITION_NEGATIVE_CONTROL)).toEqual([
      expect.objectContaining({
        file: 'tests/support/store-door-negative-control.ts',
        kind: 'DatabaseSync acquisition',
      }),
    ]);
  });
});
