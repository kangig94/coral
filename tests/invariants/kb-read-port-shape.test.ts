import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const STORE_READ_PORT_ENTRY = 'src/store/read-port.ts';
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
        if ((ts.isPropertySignature(member) || ts.isMethodSignature(member)) && member.name !== undefined) {
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
    expect(reachable).not.toContain('src/engines/orama/base-projection.ts');
    expect(reachable).not.toContain('src/engines/orama/insert-batching.ts');
    expect(reachable).not.toContain('src/engines/orama/snapshot.ts');
    expect(violations).toEqual([]);
  });

  it('exposes KbReadPort as a read-only DB shape, not writable better-sqlite3 Database', () => {
    const kbReadPortText = sourceText(READ_PORT_ENTRY);
    const kbReadPortSource = sourceFile(READ_PORT_ENTRY, kbReadPortText);
    const storeReadPortText = sourceText(STORE_READ_PORT_ENTRY);
    const storeReadPortSource = sourceFile(STORE_READ_PORT_ENTRY, storeReadPortText);

    const kbReadPortMembers = interfaceMemberNames(READ_PORT_ENTRY, 'KbReadPort');
    const readonlyDbMembers = interfaceMemberNames(STORE_READ_PORT_ENTRY, 'ReadonlyDatabase');
    const forbiddenMembers = readonlyDbMembers.filter((member) => FORBIDDEN_READONLY_DB_MEMBERS.has(member));
    const writableDatabaseLeaks: string[] = [];

    const checkInterface = (source: ts.SourceFile, name: string): void => {
      const visit = (node: ts.Node): void => {
        if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
          const rendered = node.getText(source);
          if (/\bBetterSqlite3\s*\.\s*Database\b/.test(rendered)) {
            writableDatabaseLeaks.push(name);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    };
    checkInterface(kbReadPortSource, 'KbReadPort');
    checkInterface(storeReadPortSource, 'ReadonlyDatabase');

    expect(kbReadPortMembers).toEqual(['db']);
    expect(readonlyDbMembers).toContain('prepare');
    expect(forbiddenMembers).toEqual([]);
    expect(writableDatabaseLeaks).toEqual([]);
  });

  it('does not expose library-direct KB search or read-side bundled search loading', () => {
    expect(sourceText('src/kb/queries.ts')).not.toContain('searchKnowledgeBase');
    expect(sourceText('src/read-model/coral-store.ts')).not.toContain('searchKnowledgeBase');
    expect(sourceText('src/read-model/coral-store.ts')).not.toMatch(/\bsearch:\s*\(/);

    const queryRuntimeText = sourceText('src/read-model/kb-query-runtime.ts');
    expect(queryRuntimeText).not.toContain('ensureBundledEnginesLoaded');
    expect(queryRuntimeText).not.toContain('ensureBundledEngines');
    expect(queryRuntimeText).not.toContain('loadBundledEngine');
    expect(queryRuntimeText).not.toContain('engines/kiwi');
  });
});
