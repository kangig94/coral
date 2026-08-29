// Test support must not acquire native SQLite or the production store opener through unsanctioned forms.

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
const SQLITE_DOOR_MODULE = 'tests/helpers/test-db.ts';
const STORE_DOOR_MODULES = new Set(['tests/helpers/store-db.ts', 'tests/helpers/test-db.ts']);
const STORE_DB_NAMESPACE_SPY_MODULE = 'tests/unit/store/active-store-selection-locking.test.ts';

type StoreAcquisition = Readonly<{
  file: string;
  line: number;
  kind:
    | 'node:sqlite acquisition'
    | 'openStoreDatabase acquisition'
    | 'store module acquisition'
    | 'unresolved module specifier';
  text: string;
}>;

type StoreDbResolution = 'store-db' | 'elsewhere' | 'unresolved';

type SourceReader = (file: string) => string;

type StoreModuleAcquisition = Readonly<{
  node: ts.Node;
  kind: 'openStoreDatabase acquisition' | 'store module acquisition';
}>;

type AcquisitionRecorder = (node: ts.Node, kind: StoreAcquisition['kind'], text?: string) => void;

type StoreResolutionRecorder = (
  moduleSpecifier: ts.StringLiteralLike,
  acquisition: ts.Node,
  kind: StoreModuleAcquisition['kind'],
  exemptProtectedModule?: boolean,
) => void;

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

function importedName(specifier: ts.ImportSpecifier | ts.ExportSpecifier): string {
  return specifier.propertyName?.text ?? specifier.name.text;
}

function resolvesToStoreDb(moduleSpecifier: string, containingFile: string): StoreDbResolution {
  if (moduleSpecifier.startsWith('node:')) return 'elsewhere';

  const resolvedModule = ts.resolveModuleName(
    moduleSpecifier,
    resolve(REPO_ROOT, containingFile),
    MODULE_RESOLUTION_OPTIONS,
    ts.sys,
  ).resolvedModule;
  if (resolvedModule === undefined) return 'unresolved';
  return resolve(resolvedModule.resolvedFileName) === STORE_DB_SOURCE ? 'store-db' : 'elsewhere';
}

function hasRuntimeImport(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    (ts.isNamespaceImport(bindings) ||
      bindings.elements.length === 0 ||
      bindings.elements.some((specifier) => !specifier.isTypeOnly))
  );
}

function runtimeOpenStoreImport(statement: ts.ImportDeclaration): StoreModuleAcquisition | null {
  const clause = statement.importClause;
  if (clause === undefined || clause.isTypeOnly) return null;
  if (clause.name !== undefined) return { node: clause.name, kind: 'store module acquisition' };

  const bindings = clause.namedBindings;
  if (bindings === undefined) return null;
  if (ts.isNamespaceImport(bindings)) {
    return { node: bindings, kind: 'store module acquisition' };
  }
  const opener = bindings.elements.find(
    (specifier) => !specifier.isTypeOnly && importedName(specifier) === 'openStoreDatabase',
  );
  return opener === undefined ? null : { node: opener, kind: 'openStoreDatabase acquisition' };
}

function runtimeOpenStoreExport(statement: ts.ExportDeclaration): StoreModuleAcquisition | null {
  if (statement.isTypeOnly) return null;
  const exports = statement.exportClause;
  if (exports === undefined || ts.isNamespaceExport(exports)) {
    return { node: statement, kind: 'store module acquisition' };
  }
  const opener = exports.elements.find(
    (specifier) => !specifier.isTypeOnly && importedName(specifier) === 'openStoreDatabase',
  );
  return opener === undefined ? null : { node: opener, kind: 'openStoreDatabase acquisition' };
}

function hasRuntimeExport(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) return false;
  const exports = statement.exportClause;
  return (
    exports === undefined ||
    ts.isNamespaceExport(exports) ||
    exports.elements.length === 0 ||
    exports.elements.some((specifier) => !specifier.isTypeOnly)
  );
}

function inspectImportDeclaration(
  file: string,
  statement: ts.ImportDeclaration,
  record: AcquisitionRecorder,
  recordStoreResolution: StoreResolutionRecorder,
): void {
  if (!ts.isStringLiteralLike(statement.moduleSpecifier)) return;
  const moduleSpecifier = statement.moduleSpecifier;
  if (moduleSpecifier.text === 'node:sqlite' && file !== SQLITE_DOOR_MODULE && hasRuntimeImport(statement)) {
    record(statement, 'node:sqlite acquisition');
  }
  if (STORE_DOOR_MODULES.has(file)) return;

  const acquisition = runtimeOpenStoreImport(statement);
  if (acquisition === null) return;
  const sanctionedNamespaceSpy = file === STORE_DB_NAMESPACE_SPY_MODULE && ts.isNamespaceImport(acquisition.node);
  recordStoreResolution(moduleSpecifier, acquisition.node, acquisition.kind, sanctionedNamespaceSpy);
}

function inspectExportDeclaration(
  file: string,
  statement: ts.ExportDeclaration,
  record: AcquisitionRecorder,
  recordStoreResolution: StoreResolutionRecorder,
): void {
  const moduleSpecifier = statement.moduleSpecifier;
  if (moduleSpecifier === undefined || !ts.isStringLiteralLike(moduleSpecifier)) return;
  if (moduleSpecifier.text === 'node:sqlite' && file !== SQLITE_DOOR_MODULE && hasRuntimeExport(statement)) {
    record(statement, 'node:sqlite acquisition');
  }
  if (STORE_DOOR_MODULES.has(file)) return;

  const acquisition = runtimeOpenStoreExport(statement);
  if (acquisition !== null) recordStoreResolution(moduleSpecifier, acquisition.node, acquisition.kind);
}

function inspectDynamicImports(
  file: string,
  node: ts.Node,
  record: AcquisitionRecorder,
  recordStoreResolution: StoreResolutionRecorder,
): void {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const moduleSpecifier = node.arguments[0];
    if (moduleSpecifier !== undefined && ts.isStringLiteralLike(moduleSpecifier)) {
      if (moduleSpecifier.text === 'node:sqlite' && file !== SQLITE_DOOR_MODULE) {
        record(node, 'node:sqlite acquisition');
      }
      if (!STORE_DOOR_MODULES.has(file)) {
        recordStoreResolution(moduleSpecifier, node, 'store module acquisition');
      }
    }
  }
  ts.forEachChild(node, (child) => inspectDynamicImports(file, child, record, recordStoreResolution));
}

function storeAcquisitionsIn(file: string, sourceText: string): StoreAcquisition[] {
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(resolve(REPO_ROOT, file), sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const acquisitions: StoreAcquisition[] = [];
  const record = (node: ts.Node, kind: StoreAcquisition['kind'], text = node.getText(source)): void => {
    acquisitions.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      kind,
      text,
    });
  };
  const recordStoreResolution = (
    moduleSpecifier: ts.StringLiteralLike,
    acquisition: ts.Node,
    kind: StoreModuleAcquisition['kind'],
    exemptProtectedModule = false,
  ): void => {
    const resolution = resolvesToStoreDb(moduleSpecifier.text, file);
    if (resolution === 'unresolved') record(moduleSpecifier, 'unresolved module specifier', moduleSpecifier.text);
    else if (resolution === 'store-db' && !exemptProtectedModule) record(acquisition, kind);
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      inspectImportDeclaration(file, statement, record, recordStoreResolution);
    } else if (ts.isExportDeclaration(statement)) {
      inspectExportDeclaration(file, statement, record, recordStoreResolution);
    }
  }

  inspectDynamicImports(file, source, record, recordStoreResolution);
  return acquisitions;
}

function scannedSourceFiles(): string[] {
  return STORE_DOOR_SCAN_ROOTS.flatMap(sourceFilesUnder).sort();
}

function testSupportStoreAcquisitions(files: readonly string[], readSource: SourceReader): StoreAcquisition[] {
  return files.flatMap((filePath) => {
    const canonicalPath = relative(REPO_ROOT, filePath).replaceAll('\\', '/');
    return storeAcquisitionsIn(canonicalPath, readSource(filePath));
  });
}

describe('test-support database doors', () => {
  it('contains no unsanctioned store-opening acquisition', () => {
    expect(testSupportStoreAcquisitions(scannedSourceFiles(), (file) => readFileSync(file, 'utf-8'))).toEqual([]);
  });

  it('scans every configured root while excluding integration and e2e', () => {
    const files = scannedSourceFiles();

    expect(files).toContain(resolve(REPO_ROOT, 'tests/support/control-exchange.ts'));
    expect(files).toContain(resolve(REPO_ROOT, 'tests/helpers/store-db.ts'));
    expect(files).toContain(resolve(REPO_ROOT, 'tests/helpers/test-db.ts'));
    expect(files).toContain(resolve(REPO_ROOT, 'tools/testing/store-db-location.ts'));
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

  it('rejects every runtime acquisition form of node:sqlite', () => {
    const source = `
      import sqlite from 'node:sqlite';
      import * as sqliteNamespace from 'node:sqlite';
      import { DatabaseSync as Sqlite } from 'node:sqlite';
      import {} from 'node:sqlite';
      import 'node:sqlite';
      export { DatabaseSync } from 'node:sqlite';
      export {} from 'node:sqlite';
      export * from 'node:sqlite';
      const dynamic = import(\`node:sqlite\`);
    `;

    expect(storeAcquisitionsIn('tests/fixture.ts', source).map((acquisition) => acquisition.kind)).toEqual(
      Array.from({ length: 9 }, () => 'node:sqlite acquisition'),
    );
  });

  it('rejects the store opener and every whole-module acquisition', () => {
    const source = `
      import { openStoreDatabase as openStore } from '#src/store/db.js';
      import store from '#src/store/db.js';
      import * as storeNamespace from '#src/store/db.js';
      export { openStoreDatabase as openStore } from '#src/store/db.js';
      export * from '#src/store/db.js';
      export * as storeNamespaceExport from '#src/store/db.js';
      const dynamic = import(\`#src/store/db.js\`);
    `;

    expect(storeAcquisitionsIn('tests/fixture.ts', source).map((acquisition) => acquisition.kind)).toEqual([
      'openStoreDatabase acquisition',
      'store module acquisition',
      'store module acquisition',
      'openStoreDatabase acquisition',
      'store module acquisition',
      'store module acquisition',
      'store module acquisition',
    ]);
  });

  it('accepts type-only forms and named imports owned by the store module', () => {
    const source = `
      import type { Database, openStoreDatabase } from '#src/store/db.js';
      import { type openStoreDatabase, applyBundledStoreSchema, withImmediate } from '#src/store/db.js';
      export type { openStoreDatabase } from '#src/store/db.js';
      import type { DatabaseSync } from 'node:sqlite';
      import { type DatabaseSync as Sqlite } from 'node:sqlite';
      export type { DatabaseSync } from 'node:sqlite';
    `;

    expect(storeAcquisitionsIn('tests/fixture.ts', source)).toEqual([]);
  });

  it('exempts only the sanctioned doors and namespace mocking site', () => {
    const sqlite = `import sqlite from 'node:sqlite';`;
    const storeNamespace = `import * as dbModule from '#src/store/db.js';`;
    const storeOpener = `import { openStoreDatabase } from '#src/store/db.js';`;

    expect(storeAcquisitionsIn('tests/helpers/test-db.ts', sqlite)).toEqual([]);
    expect(storeAcquisitionsIn('tests/helpers/store-db.ts', sqlite)).toHaveLength(1);
    expect(storeAcquisitionsIn('tests/helpers/store-db.ts', storeOpener)).toEqual([]);
    expect(storeAcquisitionsIn('tests/helpers/test-db.ts', storeNamespace)).toEqual([]);
    expect(storeAcquisitionsIn(STORE_DB_NAMESPACE_SPY_MODULE, storeNamespace)).toEqual([]);
    expect(storeAcquisitionsIn(STORE_DB_NAMESPACE_SPY_MODULE, storeOpener)).toHaveLength(1);
    expect(
      storeAcquisitionsIn(STORE_DB_NAMESPACE_SPY_MODULE, `import * as missing from './missing-store-module.js';`),
    ).toEqual([
      expect.objectContaining({
        kind: 'unresolved module specifier',
        text: './missing-store-module.js',
      }),
    ]);
  });

  it('refuses module-handing forms whose specifier cannot be resolved', () => {
    const source = `import missing from './missing-store-module.js';`;

    expect(storeAcquisitionsIn('tests/fixture.ts', source)).toEqual([
      expect.objectContaining({
        file: 'tests/fixture.ts',
        kind: 'unresolved module specifier',
        text: './missing-store-module.js',
      }),
    ]);
  });

  it('drives the real traversal and reader over a violating fixture', () => {
    const negativeControl = resolve(REPO_ROOT, 'tests/fixtures/store-door-bypass-negative-control.ts');

    expect(
      testSupportStoreAcquisitions(scannedSourceFiles(), (file) =>
        file === negativeControl ? STORE_DOOR_ACQUISITION_NEGATIVE_CONTROL : readFileSync(file, 'utf-8'),
      ),
    ).toEqual([
      expect.objectContaining({
        file: 'tests/fixtures/store-door-bypass-negative-control.ts',
        kind: 'node:sqlite acquisition',
      }),
    ]);
  });
});
