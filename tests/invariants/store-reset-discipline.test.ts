import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isGarbageStoreEpoch } from '#src/store/epoch.js';

const ROOT = process.cwd();
const STORE_ROOT = join(ROOT, 'src/store');

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf-8');
}

function storeSources(): readonly string[] {
  return readdirSync(STORE_ROOT)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/store/${name}`);
}

function enclosingFunctionName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) return current.name.text;
    current = current.parent;
  }
  return null;
}

function storeSemanticRefusalCount(): number {
  const paths = new Set(storeSources());
  const parsed = new Map<string, ts.SourceFile>();
  const sourceFile = (path: string): ts.SourceFile => {
    const cached = parsed.get(path);
    if (cached !== undefined) return cached;
    const value = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true);
    parsed.set(path, value);
    return value;
  };
  const resolveImport = (from: string, specifier: string): string | null => {
    if (!specifier.startsWith('.')) return null;
    const candidate = relative(ROOT, normalize(resolve(ROOT, dirname(from), specifier)))
      .replace(/\.js$/u, '.ts')
      .replaceAll('\\', '/');
    if (paths.has(candidate)) return candidate;
    const index = candidate.replace(/\/?$/u, '/index.ts');
    return paths.has(index) ? index : null;
  };
  const closure = new Set<string>();
  const pending = ['src/store/active-store-selection-coordination.ts'];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || closure.has(path)) continue;
    closure.add(path);
    for (const statement of sourceFile(path).statements.filter(ts.isImportDeclaration)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const imported = resolveImport(path, statement.moduleSpecifier.text);
      if (imported?.startsWith('src/store/')) pending.push(imported);
    }
  }

  let count = 0;
  for (const path of closure) {
    const parsedSource = sourceFile(path);
    const visit = (node: ts.Node): void => {
      if (ts.isThrowStatement(node)) {
        let catchClause: ts.Node | undefined = node.parent;
        while (catchClause !== undefined && !ts.isCatchClause(catchClause)) catchClause = catchClause.parent;
        const rethrowsCaughtValue =
          ts.isIdentifier(node.expression) &&
          catchClause !== undefined &&
          ts.isCatchClause(catchClause) &&
          catchClause.variableDeclaration !== undefined &&
          ts.isIdentifier(catchClause.variableDeclaration.name) &&
          catchClause.variableDeclaration.name.text === node.expression.text;
        if (!rethrowsCaughtValue) count += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(parsedSource);
  }
  return count;
}

describe('write-once store epoch invariants', () => {
  it('publishes an epoch directory only by renaming a private mint', () => {
    const parsed = ts.createSourceFile(
      'src/store/epoch.ts',
      source('src/store/epoch.ts'),
      ts.ScriptTarget.Latest,
      true,
    );
    const publications: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'renameSync' &&
        /epochDirectory|epoch-/u.test(node.arguments[1]?.getText(parsed) ?? '')
      ) {
        publications.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);

    expect(publications).toHaveLength(1);
    expect(publications[0]?.arguments[0]?.getText(parsed)).toBe('mint');
    expect(enclosingFunctionName(publications[0])).toBe('mintNextEpoch');
    expect(source('src/store/epoch.ts')).toContain("const MINT_DIRECTORY_PREFIX = '.mint-'");
  });

  it('keeps epoch deletion inside the sweep implementation', () => {
    for (const path of storeSources()) {
      if (path === 'src/store/epoch.ts') continue;
      expect(source(path), path).not.toMatch(/(?:rmSync|unlinkSync)\([^\n]*epoch-/u);
    }
    const parsed = ts.createSourceFile(
      'src/store/epoch.ts',
      source('src/store/epoch.ts'),
      ts.ScriptTarget.Latest,
      true,
    );
    const deletionOwners: Array<string | null> = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'removeDuringSweep'
      ) {
        deletionOwners.push(enclosingFunctionName(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(deletionOwners.length).toBeGreaterThan(0);
    expect(new Set(deletionOwners)).toEqual(new Set(['sweepStoreEpochs']));
  });

  it('classifies exactly K <= current - 2 as garbage', () => {
    for (let current = 0; current < 100; current += 1) {
      for (let candidate = 0; candidate < 100; candidate += 1) {
        expect(isGarbageStoreEpoch(String(current), String(candidate))).toBe(candidate <= current - 2);
      }
    }
  });

  it('does not retain the deleted reset authority and resume mechanisms', () => {
    expect(storeSources().map((path) => path.split('/').at(-1))).not.toEqual(
      expect.arrayContaining([
        'backend-store-reset.ts',
        'reset-active-evidence.ts',
        'reset-retention.ts',
        'settlement-authority.ts',
      ]),
    );
    const all = storeSources().map(source).join('\n');
    expect(all).not.toMatch(/WriterExclusion|store_reset_lock_contended|store_reset_interrupted_/u);
  });

  it('counts each inlined settlement refusal in the semantic ratchet (target: 0)', () => {
    expect(source('src/store/epoch.ts')).not.toContain('failStoreEpoch');
    expect(storeSemanticRefusalCount()).toBe(65);
  });

  it('keeps legacy_source_not_quiescent producers off the startup adoption path', () => {
    const activeSelection = source('src/store/active-store-selection-coordination.ts');
    expect(activeSelection).toContain('tryAcquireGenerationAdoptionLock(runtime)');
    expect(activeSelection).not.toMatch(/\bacquireGenerationAdoptionLock\b/u);

    const coordination = source('src/store/generation-mutation-coordination.ts');
    const start = coordination.indexOf('export async function tryAcquireGenerationAdoptionLock');
    const end = coordination.indexOf('export async function acquireGenerationAdoptionLease', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(coordination.slice(start, end)).not.toContain('generationNotQuiescentError');
  });
});
