import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { oramaIndexMetadataPath, oramaIndexPath } from '#src/engines/orama/paths.js';
import type { KbQueryContext } from '#src/kb/query-runtime.js';
import {
  createProductionFileIndex,
  listProductionSourceFiles,
  parseProductionImportEdges,
  type ParsedImportEdge,
} from '#tests/helpers/ts-import-scanner.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome || actual.homedir(),
  };
});

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const READ_PORT_ENTRY = 'src/kb/read-port.ts';
const FORBIDDEN_READ_PORT_IMPORT_GRAPH_SYMBOLS = new Set([
  'ensureCorpusFreshness',
  'persist',
  'removeSnapshot',
  'loadIfPresent',
]);
const FORBIDDEN_READONLY_DB_MEMBERS = new Set([
  'aggregate',
  'backup',
  'defaultSafeIntegers',
  'exec',
  'function',
  'loadExtension',
  'pragma',
  'serialize',
  'transaction',
]);

const tempRoots: string[] = [];

// Type-level claims (KbReadPort.db is a constrained ReadonlyDatabase, not a
// writable Database; `exec`/`pragma`/`transaction`/etc. are unreachable) live
// at tests/types/kb-read-port-shape.test-d.ts and are typechecked by
// `tsc -p tests/types/tsconfig.json` during `npm test`. `@ts-expect-error`
// directives placed here would be dead text — vitest does not typecheck.

function sourceFile(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function sourceText(relativePath: string): string {
  return ts.sys.readFile(join(REPO_ROOT, relativePath), 'utf-8') ?? '';
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function collectReachableProductionFiles(entry: string): string[] {
  const productionFilePaths = listProductionSourceFiles(SRC_ROOT);
  const productionIndex = createProductionFileIndex(REPO_ROOT, productionFilePaths);
  expect(productionIndex.has(entry)).toBe(true);

  const edgesBySource = new Map<string, ParsedImportEdge[]>();
  for (const edge of parseProductionImportEdges(REPO_ROOT, productionFilePaths)) {
    const edges = edgesBySource.get(edge.source) ?? [];
    edges.push(edge);
    edgesBySource.set(edge.source, edges);
  }

  const reachable = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    for (const edge of edgesBySource.get(current) ?? []) {
      stack.push(edge.target);
    }
  }

  return [...reachable].sort();
}

function collectForbiddenSymbolHits(relativePath: string): string[] {
  const text = sourceText(relativePath);
  const source = sourceFile(relativePath, text);
  const hits: string[] = [];

  const record = (name: string, node: ts.Node): void => {
    if (!FORBIDDEN_READ_PORT_IMPORT_GRAPH_SYMBOLS.has(name)) {
      return;
    }
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    hits.push(`${relativePath}:${position.line + 1}: ${name}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        record(callee.text, callee);
      } else if (ts.isPropertyAccessExpression(callee)) {
        record(callee.name.text, callee.name);
      }
    } else if (
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node)
    ) {
      const name = propertyNameText(node.name);
      if (name !== null) {
        record(name, node.name);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return hits;
}

function interfaceMemberNames(relativePath: string, interfaceName: string): string[] {
  const text = sourceText(relativePath);
  const source = sourceFile(relativePath, text);
  const members: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      for (const member of node.members) {
        if (
          (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
          member.name !== undefined
        ) {
          const name = propertyNameText(member.name);
          if (name !== null) {
            members.push(name);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return members.sort();
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-kb-read-port-'));
  tempRoots.push(root);
  return root;
}

function writeNote(noteDir: string, slug: string, title: string, body: string): void {
  mkdirSync(noteDir, { recursive: true });
  writeFileSync(
    join(noteDir, `${slug}.md`),
    `---
tags: []
principles: []
source:
  - kangig94/coral
createdAt: 2026-04-01
updatedAt: 2026-04-01
entrySeq: 1
---
# ${title}

${body}
`,
    'utf-8',
  );
}

async function createWritableKbRuntime() {
  const [{ createRealRuntime }, { openStoreDatabase }, { ensureStoreSchemasDir }, { createKbRuntime }, { kbRuntimeDir }] =
    await Promise.all([
      import('#src/runtime/real.js'),
      import('#src/store/db.js'),
      import('#src/store/schema-loader.js'),
      import('#src/kb/runtime.js'),
      import('#src/kb/paths.js'),
    ]);

  const runtime = createRealRuntime('prod');
  const db = openStoreDatabase({
    path: runtime.paths.coral.store.dbFile,
    storage: runtime.storage,
    schemasDir: ensureStoreSchemasDir(runtime.storage),
  });
  const kb = createKbRuntime({
    markdownRoot: runtime.paths.coral.corpus.kbRoot,
    runtimeDir: kbRuntimeDir('prod'),
    db,
    time: runtime.time,
    envPort: runtime.env,
    ids: runtime.ids,
    storage: runtime.storage,
    spawnCli: async () => ({
      stdout: '',
      stderr: '',
      code: 0,
      aborted: false,
    }),
    processPort: runtime.process,
  });

  return { runtime, db, kb };
}

describe('KB read port shape', () => {
  beforeEach(() => {
    mockState.tmpHome = tempRoot();
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.CORAL_KB_PATH;
    mockState.tmpHome = '';
    vi.resetModules();
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop()!, { recursive: true, force: true });
    }
  });

  it('keeps writable/rebuild Orama paths unreachable from src/kb/read-port.ts', () => {
    const reachable = collectReachableProductionFiles(READ_PORT_ENTRY);
    const violations = reachable.flatMap(collectForbiddenSymbolHits);

    expect(reachable).not.toContain('src/kb/runtime.ts');
    expect(reachable).not.toContain('src/engines/orama/backend.ts');
    expect(reachable).not.toContain('src/engines/orama/snapshot.ts');
    expect(violations).toEqual([]);
  });

  it('exposes KbReadPort as a read-only DB shape, not writable better-sqlite3 Database', () => {
    const readPortText = sourceText(READ_PORT_ENTRY);
    const readPortSource = sourceFile(READ_PORT_ENTRY, readPortText);
    const kbReadPortMembers = interfaceMemberNames(READ_PORT_ENTRY, 'KbReadPort');
    const readonlyDbMembers = interfaceMemberNames(READ_PORT_ENTRY, 'ReadonlyDatabase');
    const forbiddenMembers = readonlyDbMembers.filter((member) => FORBIDDEN_READONLY_DB_MEMBERS.has(member));
    const writableDatabaseLeaks: string[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && (node.name.text === 'KbReadPort' || node.name.text === 'ReadonlyDatabase')) {
        const rendered = node.getText(readPortSource);
        if (/\bBetterSqlite3\s*\.\s*Database\b/.test(rendered)) {
          writableDatabaseLeaks.push(node.name.text);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(readPortSource);

    expect(kbReadPortMembers).toEqual(['db']);
    expect(readonlyDbMembers).toContain('prepare');
    expect(forbiddenMembers).toEqual([]);
    expect(writableDatabaseLeaks).toEqual([]);
  });

  it('searchKnowledgeBase degrades on a missing read-side snapshot without writing and consumer apply materializes it', async () => {
    const [
      { searchKnowledgeBase },
      { reindex },
      { applyBoundCorpusConsumerForTest },
      { bindOramaFtsForTest },
      { notesDir },
    ] = await Promise.all([
      import('#src/kb/queries.js'),
      import('#src/kb/ops/reindex.js'),
      import('#tests/helpers/kb-test-runtime.js'),
      import('#tests/unit/kb/expansion-test-helpers.js'),
      import('#src/kb/paths.js'),
    ]);
    const { runtime, db, kb } = await createWritableKbRuntime();
    const runtimeDir = kb.runtimeDir;
    const context: KbQueryContext = { pluginRoot: REPO_ROOT, runtime };

    writeNote(notesDir(runtime.paths.coral.corpus.kbRoot), 'read-port-note', 'Read Port Note', 'Read-side search probe.');
    await reindex(kb);

    const artifactPath = oramaIndexPath(runtimeDir);
    const metadataPath = oramaIndexMetadataPath(runtimeDir);
    expect(existsSync(artifactPath)).toBe(false);
    expect(existsSync(metadataPath)).toBe(false);
    bindOramaFtsForTest(kb);
    expect(kb.fts.read().read().warnings()).toContain('fts_index_uninitialized');

    const degraded = await searchKnowledgeBase({ query: 'read-side', mode: 'text' }, context);

    expect(degraded).toEqual({
      mode: 'text',
      results: [],
      warnings: ['kb_search_degraded_until_coordinator_rebuild'],
    });
    expect(existsSync(artifactPath)).toBe(false);
    expect(existsSync(metadataPath)).toBe(false);

    await applyBoundCorpusConsumerForTest(kb, db);

    expect(existsSync(artifactPath)).toBe(true);
    expect(existsSync(metadataPath)).toBe(true);

    const ready = await searchKnowledgeBase({ query: 'probe', mode: 'text' }, context);
    expect(ready.warnings).toBeUndefined();
    expect(ready.results.map((result) => result.note)).toEqual(['read-port-note']);

    db.close();
  });
});
