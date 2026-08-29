// Store-opening calls in the unit-tier roots must name `':memory:'` directly, with no exceptions.
// The scanner must not infer variables, imports, aliases, or consequences: only opening-call syntax decides.
// Both the exception ledger and the non-literal site census must remain empty.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { UNIT_TIER_ROOTS } from '#tests/unit-tier-roots.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type StoreDoor = 'newRawDatabase' | 'openStoreDatabase' | 'openTestStoreDb';
type StoreCall = Readonly<{
  file: string;
  line: number;
  door: StoreDoor;
  pathIsMemoryLiteral: boolean;
  text: string;
}>;

const STORE_DOORS = new Set<StoreDoor>(['newRawDatabase', 'openStoreDatabase', 'openTestStoreDb']);

const REAL_STORE_MIGRATION_LEDGER = new Map<string, string>();

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

function calledStoreDoor(call: ts.CallExpression): StoreDoor | null {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
  return name !== null && STORE_DOORS.has(name as StoreDoor) ? (name as StoreDoor) : null;
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}

function storePathArgument(call: ts.CallExpression, door: StoreDoor): ts.Expression | undefined {
  if (door === 'newRawDatabase') return call.arguments[0];
  if (door === 'openTestStoreDb') return call.arguments[1];

  const options = call.arguments[0];
  if (!ts.isObjectLiteralExpression(options)) return undefined;
  if (options.properties.some(ts.isSpreadAssignment)) return undefined;
  const path = options.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyName(property.name) === 'path',
  );
  return path?.initializer;
}

function isMemoryLiteral(expression: ts.Expression | undefined): boolean {
  return expression !== undefined && ts.isStringLiteral(expression) && expression.text === ':memory:';
}

function storeCallsIn(file: string, sourceText: string): StoreCall[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const calls: StoreCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const door = calledStoreDoor(node);
      if (door !== null) {
        calls.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          door,
          pathIsMemoryLiteral: isMemoryLiteral(storePathArgument(node, door)),
          text: node.getText(source),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function unitTierStoreCalls(): StoreCall[] {
  return UNIT_TIER_ROOTS.flatMap((root) =>
    sourceFilesUnder(root).flatMap((filePath) => {
      const file = relative(REPO_ROOT, filePath).replaceAll('\\', '/');
      return storeCallsIn(file, readFileSync(filePath, 'utf-8'));
    }),
  );
}

const UNIT_TIER_STORE_CALLS = unitTierStoreCalls();
const REAL_STORE_SITES = UNIT_TIER_STORE_CALLS.filter((call) => !call.pathIsMemoryLiteral);

describe('unit-tier store paths are explicit memory literals', () => {
  it('contains no non-literal store-opening call', () => {
    expect(REAL_STORE_SITES).toEqual([]);
  });

  it('keeps the migration ledger empty', () => {
    expect([...REAL_STORE_MIGRATION_LEDGER]).toEqual([]);
  });

  it('finds store-opening calls in the scanned roots', () => {
    expect(UNIT_TIER_STORE_CALLS.length).toBeGreaterThan(0);
  });

  it.each([
    ['an openTestStoreDb variable', 'openTestStoreDb(runtime, dbPath);'],
    ['an openStoreDatabase variable', 'openStoreDatabase({ path: dbPath, storage, storeFormat });'],
    ['an openStoreDatabase spread', "openStoreDatabase({ path: ':memory:', storage, storeFormat, ...options });"],
    ['a newRawDatabase expression', "newRawDatabase(join(root, 'store.db'));"],
    ['an omitted newRawDatabase path', 'newRawDatabase();'],
  ])('rejects %s', (_label, source) => {
    expect(storeCallsIn('fixture.ts', source).filter((call) => !call.pathIsMemoryLiteral)).not.toHaveLength(0);
  });

  it('allows literal memory paths and unrelated mentions', () => {
    const source = `
      openTestStoreDb(runtime, ':memory:');
      openStoreDatabase({ path: ':memory:', storage, storeFormat });
      newRawDatabase(':memory:');
      body.indexOf('openStoreDatabase(');
    `;
    expect(storeCallsIn('fixture.ts', source).filter((call) => !call.pathIsMemoryLiteral)).toEqual([]);
  });
});
