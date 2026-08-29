// Every tier the location policy restricts to memory — unit, invariants, simulation — and the support closure
// they share must use checked database doors. Integration and e2e stay outside this scan because direct
// opening is often the behavior under test there. No Vitest config covers
// `npm run simulate`, so the standalone entry point itself must stamp the simulation tier before loading its runner.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { OUTSIDE_ROOT_STORE_BYPASS } from '#tests/fixtures/store-door-bypass-negative-control.js';
import { UNIT_TIER_ROOTS } from '../../vitest/tiers.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORE_DOOR_SCAN_ROOTS = [
  ...UNIT_TIER_ROOTS,
  'tests/simulation',
  'tests/helpers',
  'tests/fixtures',
  'tools/testing',
] as const;
const STORE_DOOR_MODULES = new Set(['tests/helpers/store-db.ts', 'tests/helpers/test-db.ts']);
const NEGATIVE_CONTROL = resolve(REPO_ROOT, 'tests/fixtures/store-door-bypass-negative-control.ts');
const SIMULATOR_ENTRY = resolve(REPO_ROOT, 'tools/simulation/cli.ts');

type StoreBypass = Readonly<{
  file: string;
  line: number;
  kind: 'DatabaseSync construction' | 'openStoreDatabase call';
  text: string;
}>;

function sourceFilesUnder(root: string): string[] {
  const files: string[] = [];
  const directories = [resolve(REPO_ROOT, root)];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
    }
  }
  return files;
}

function importedName(specifier: ts.ImportSpecifier): string {
  return specifier.propertyName?.text ?? specifier.name.text;
}

function expressionName(expression: ts.Expression): string | null {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)) {
    return current.argumentExpression.text;
  }
  return null;
}

function collectAliases(source: ts.SourceFile): {
  databaseConstructors: ReadonlySet<string>;
  storeOpeners: ReadonlySet<string>;
} {
  const databaseConstructors = new Set(['DatabaseSync']);
  const storeOpeners = new Set(['openStoreDatabase']);

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const imports = statement.importClause?.namedBindings;
    if (!imports || !ts.isNamedImports(imports)) continue;
    for (const specifier of imports.elements) {
      if (statement.moduleSpecifier.text === 'node:sqlite' && importedName(specifier) === 'DatabaseSync') {
        databaseConstructors.add(specifier.name.text);
      }
      if (statement.moduleSpecifier.text.endsWith('/store/db.js') && importedName(specifier) === 'openStoreDatabase') {
        storeOpeners.add(specifier.name.text);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        const initializerName = expressionName(node.initializer);
        if (
          initializerName !== null &&
          databaseConstructors.has(initializerName) &&
          !databaseConstructors.has(node.name.text)
        ) {
          databaseConstructors.add(node.name.text);
          changed = true;
        }
        if (initializerName !== null && storeOpeners.has(initializerName) && !storeOpeners.has(node.name.text)) {
          storeOpeners.add(node.name.text);
          changed = true;
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const sourceName = element.propertyName?.getText(source) ?? element.name.text;
          if (databaseConstructors.has(sourceName) && !databaseConstructors.has(element.name.text)) {
            databaseConstructors.add(element.name.text);
            changed = true;
          }
          if (storeOpeners.has(sourceName) && !storeOpeners.has(element.name.text)) {
            storeOpeners.add(element.name.text);
            changed = true;
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const sourceName = expressionName(node.right);
        if (sourceName !== null && databaseConstructors.has(sourceName) && !databaseConstructors.has(node.left.text)) {
          databaseConstructors.add(node.left.text);
          changed = true;
        }
        if (sourceName !== null && storeOpeners.has(sourceName) && !storeOpeners.has(node.left.text)) {
          storeOpeners.add(node.left.text);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return { databaseConstructors, storeOpeners };
}

function storeBypassesIn(file: string, sourceText: string): StoreBypass[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const { databaseConstructors, storeOpeners } = collectAliases(source);
  const bypasses: StoreBypass[] = [];
  const record = (node: ts.Node, kind: StoreBypass['kind']): void => {
    bypasses.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      kind,
      text: node.getText(source),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const name = expressionName(node.expression);
      if (name !== null && databaseConstructors.has(name)) record(node, 'DatabaseSync construction');
    }
    if (ts.isCallExpression(node)) {
      const name = expressionName(node.expression);
      if (name !== null && storeOpeners.has(name)) record(node, 'openStoreDatabase call');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bypasses;
}

function scannedSourceFiles(): ReadonlyArray<Readonly<{ root: string; files: string[] }>> {
  return STORE_DOOR_SCAN_ROOTS.map((root) => ({ root, files: sourceFilesUnder(root) }));
}

function testSupportStoreBypasses(scan: ReturnType<typeof scannedSourceFiles>): StoreBypass[] {
  return scan.flatMap(({ files }) =>
    files.flatMap((filePath) => {
      const canonicalPath = relative(REPO_ROOT, filePath).replaceAll('\\', '/');
      return STORE_DOOR_MODULES.has(canonicalPath)
        ? []
        : storeBypassesIn(canonicalPath, readFileSync(filePath, 'utf-8'));
    }),
  );
}

describe('test-support database doors', () => {
  it('contains no direct database-opening bypass', () => {
    expect(testSupportStoreBypasses(scannedSourceFiles())).toEqual([]);
  });

  it('finds source files in every configured root', () => {
    const scan = scannedSourceFiles();

    expect(scan).not.toHaveLength(0);
    for (const { root, files } of scan) {
      expect(files, `${root} yielded no TypeScript source files`).not.toHaveLength(0);
    }
  });

  it('rejects direct and aliased bypasses', () => {
    const source = `
      import { DatabaseSync as Sqlite } from 'node:sqlite';
      import { openStoreDatabase as openStore } from '#src/store/db.js';
      const openAgain = openStore;
      new Sqlite(path);
      openAgain({ path, storage, storeFormat });
    `;
    expect(storeBypassesIn('fixture.ts', source).map((bypass) => bypass.kind)).toEqual([
      'DatabaseSync construction',
      'openStoreDatabase call',
    ]);
  });

  it('accepts door calls and openStoreDatabase spies', () => {
    const source = `
      openTestStoreDb(runtime, path);
      openKbTestStoreDb(path);
      newRawDatabase(path);
      vi.spyOn(dbModule, 'openStoreDatabase');
    `;
    expect(storeBypassesIn('fixture.ts', source)).toEqual([]);
  });

  it('detects a bypass in a support module outside the concurrent-tier roots', () => {
    const scan = scannedSourceFiles();
    const fixtureFiles = scan.find(({ root }) => root === 'tests/fixtures')?.files ?? [];

    expect(fixtureFiles).toContain(NEGATIVE_CONTROL);
    expect(storeBypassesIn('tests/fixtures/store-door-bypass-negative-control.ts', OUTSIDE_ROOT_STORE_BYPASS)).toEqual([
      expect.objectContaining({
        file: 'tests/fixtures/store-door-bypass-negative-control.ts',
        kind: 'DatabaseSync construction',
      }),
    ]);
  });

  it('keeps the standalone simulator tier stamp ahead of its runtime graph', () => {
    const source = readFileSync(SIMULATOR_ENTRY, 'utf-8');
    const parsed = ts.createSourceFile(SIMULATOR_ENTRY, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const tierStamp = source.indexOf("process.env.CORAL_TEST_TIER ??= 'simulation'");
    const runnerLoad = source.indexOf("await import('./runner.js')");
    const eagerRunnerImports = parsed.statements.filter(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === './runner.js' &&
        statement.importClause?.isTypeOnly !== true,
    );

    expect(tierStamp).toBeGreaterThanOrEqual(0);
    expect(runnerLoad).toBeGreaterThan(tierStamp);
    expect(eagerRunnerImports).toEqual([]);
  });
});
