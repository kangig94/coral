// Unit-tier store opens must name `':memory:'` directly. A test that requires a filesystem-backed store must
// move to tests/integration; this ledger is migration work, never permission to keep unit-tier I/O.
// The scanner must not infer variables, aliases, or consequences: only syntax at the opening call decides.
// Ledger and site-census ratchets may only fall.

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

const REAL_STORE_MIGRATION_LEDGER = new Map<string, string>([
  [
    'tests/unit/cli/backend-recovery-quarantine.test.ts',
    'openStoreDatabase: daemon-down reads reopen seeded rows and classify older or unsupported stores from disk',
  ],
  [
    'tests/unit/cli/coral-store-read-parity.test.ts',
    'openStoreDatabase: production readers reopen the seeded runtime store for CLI parity assertions',
  ],
  [
    'tests/unit/cli/follow.test.ts',
    'openStoreDatabase: follow rendering reopens persisted cause-chain events beneath a temporary HOME',
  ],
  [
    'tests/unit/cli/kb-diagnose.test.ts',
    'openStoreDatabase: the diagnose command reopens persisted retry-queue rows at the runtime store path',
  ],
  [
    'tests/unit/cli/main-routing.test.ts',
    'openStoreDatabase: CLI wait routing reads persisted cause-chain events through production path resolution',
  ],
  [
    'tests/unit/cli/store-reset.test.ts',
    'openTestStoreDb: discard refusal requires a compatible store file and an unchanged filesystem tree',
  ],
  [
    'tests/unit/coordinator/corpus-notify-crash.test.ts',
    'newRawDatabase: crash replay requires another connection to the same persisted snapshot and cursor state',
  ],
  [
    'tests/unit/coordinator/service-composition.test.ts',
    'openTestStoreDb: progress and session services open independent handles to the production-resolved store',
  ],
  [
    'tests/unit/discuss/cross-connection-launch.test.ts',
    'newRawDatabase: competing-launch serialization requires two connections to the same database file',
  ],
  [
    'tests/unit/expansion/activate.test.ts',
    'openStoreDatabase: activation discovers and classifies the current store at the runtime path',
  ],
  [
    'tests/unit/kb-daemon/runtime-host.test.ts',
    'openTestStoreDb: the owned runtime host reopens the seeded store while dispose waits on its handle',
  ],
  [
    'tests/unit/kb/runtime-test-helpers.ts',
    'openStoreDatabase: callers with a runtime directory need another component to reopen that store file',
  ],
  [
    'tests/unit/sessions/shell.test.ts',
    'openStoreDatabase: continuity CAS ordering requires two concurrent handles to the same store file',
  ],
  [
    'tests/unit/store/db-pragma.test.ts',
    "newRawDatabase: WAL and synchronous pragma behavior cannot be observed on ':memory:'",
  ],
  [
    'tests/unit/store/format-classification.test.ts',
    'openStoreDatabase: classification, readonly reopening, sidecars, and product versions require store files',
  ],
  [
    'tests/unit/store/generation-readiness.test.ts',
    'openStoreDatabase: readable legacy history must remain on disk while a new generation opens beside it',
  ],
  [
    'tests/unit/store/open-or-reset.test.ts',
    'openStoreDatabase: reset and readonly cases assert creation, absence, replacement, and preservation by path',
  ],
  [
    'tests/unit/store/schemas.idempotent.test.ts',
    "newRawDatabase: nothing would stop being exercised on ':memory:', so this is direct migration debt",
  ],
  [
    'tests/unit/testing/persistence-readers.test.ts',
    'openStoreDatabase: the readers under test reopen data seeded at the resolved production store path',
  ],
]);

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
  it('opens no unrecorded filesystem-backed store', () => {
    expect(REAL_STORE_SITES.filter((site) => !REAL_STORE_MIGRATION_LEDGER.has(site.file))).toEqual([]);
  });

  it('every ledger file still has a non-literal store path', () => {
    const filesWithRealStoreSites = new Set(REAL_STORE_SITES.map((site) => site.file));
    expect([...REAL_STORE_MIGRATION_LEDGER.keys()].filter((file) => !filesWithRealStoreSites.has(file))).toEqual([]);
  });

  it('keeps the migration ledger and site census on a shrinking ratchet', () => {
    expect({
      ledgerFiles: REAL_STORE_MIGRATION_LEDGER.size,
      realStoreSites: REAL_STORE_SITES.length,
    }).toEqual({
      ledgerFiles: 19,
      realStoreSites: 37,
    });
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
