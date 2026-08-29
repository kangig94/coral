// Unit-tier tests open databases through test helpers, never DatabaseSync or openStoreDatabase directly.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { UNIT_TIER_ROOTS } from '../../vitest/tiers.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

function unitTierStoreBypasses(): StoreBypass[] {
  return UNIT_TIER_ROOTS.flatMap((root) =>
    sourceFilesUnder(root).flatMap((filePath) =>
      storeBypassesIn(relative(REPO_ROOT, filePath).replaceAll('\\', '/'), readFileSync(filePath, 'utf-8')),
    ),
  );
}

describe('unit-tier database doors', () => {
  it('contains no direct database-opening bypass', () => {
    expect(unitTierStoreBypasses()).toEqual([]);
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
});
