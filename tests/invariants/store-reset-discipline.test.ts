import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { garbageStoreEpochs } from '#src/store/epoch.js';

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
    expect(source('src/store/epoch.ts')).not.toContain('replaceEpoch');
  });

  it('makes descriptor and WAL-path binding race cells unreachable', () => {
    const epoch = source('src/store/epoch.ts');
    const ports = source('src/infra/port-types.ts');
    const runtime = source('src/runtime/real.ts');

    expect(epoch).not.toMatch(
      /openProvenStoreDescriptor|provenPathStillNamesObject|verifiedObservations|settledObservations|\/proc\/self\/fd|\/dev\/fd/u,
    );
    expect(ports).not.toContain('openNoFollowSync');
    expect(runtime).not.toMatch(/openNoFollowSync|O_NOFOLLOW/u);
    expect(epoch).toContain('A same-user process actively replacing entries inside ~/.coral');
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
    expect(new Set(deletionOwners)).toEqual(
      new Set(['removeEpochEntry', 'removeWhileExclusivelyLocked', 'sweepStoreEpochs']),
    );
  });

  it('retains exactly the highest two proven epochs across numbering gaps', () => {
    for (let mask = 0; mask < 1 << 8; mask += 1) {
      const proven = Array.from({ length: 8 }, (_, epoch) => String(epoch + 1)).filter(
        (_epoch, index) => mask & (1 << index),
      );
      const retained = new Set([...proven].sort((left, right) => Number(left) - Number(right)).slice(-2));
      expect(garbageStoreEpochs(proven)).toEqual(new Set(proven.filter((epoch) => !retained.has(epoch))));
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

  it('replaces the swept-mint refusal with holder-publication safety in the semantic-refusal ratchet', () => {
    expect(source('src/store/epoch.ts')).not.toContain('failStoreEpoch');
    expect(storeSemanticRefusalCount()).toBe(64);
  });

  it('uses file-lock acquisition rather than bare pid observation for holder liveness', () => {
    const epoch = source('src/store/epoch.ts');
    expect(epoch).not.toContain('observeLiveness');
    expect(epoch).toContain('tryAcquireExclusiveFileLockSync');
  });

  it('keeps every store lock inside its store directory', () => {
    const epoch = source('src/store/epoch.ts');
    expect(epoch).toContain("export const STORE_LOCK_FILE_NAME = '.lock'");
    expect(epoch).not.toMatch(/\.epoch-lock-|\.mint-lock-|removeOrphanedEpochLock|removeLockFile/u);
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
