import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { isFunctionScope } from '../helpers/ts-function-scope.js';

const SOURCE_ROOT = join(process.cwd(), 'src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

function parseSource(path: string, source = readFileSync(path, 'utf8')): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function functionName(node: ts.FunctionLikeDeclaration): string | null {
  if ('name' in node && node.name !== undefined) return node.name.getText(node.getSourceFile());
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) {
    return parent.name.getText(node.getSourceFile());
  }
  return null;
}

function descendants(node: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (current: ts.Node): void => {
    if (current !== node && ts.isFunctionLike(current)) return;
    found.push(current);
    ts.forEachChild(current, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function callsMethod(node: ts.Node, name: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name
  );
}

function requestsCancellation(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const expression = node.expression;
  const name = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : ts.isIdentifier(expression)
      ? expression.text
      : '';
  return name === 'abort' || /^(?:abort|cancel).*(?:attempt|cleanup|reap)/iu.test(name);
}

function returnsDisposition(node: ts.Node, kinds: ReadonlySet<string>): boolean {
  if (!ts.isReturnStatement(node) || node.expression === undefined) return false;
  const expression = ts.isParenthesizedExpression(node.expression) ? node.expression.expression : node.expression;
  if (!ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      property.name.getText(node.getSourceFile()) === 'kind' &&
      ts.isStringLiteral(property.initializer) &&
      kinds.has(property.initializer.text),
  );
}

function returnsSettlementHold(node: ts.Node): boolean {
  if (!ts.isReturnStatement(node) || node.expression === undefined) return false;
  const expression = ts.isParenthesizedExpression(node.expression) ? node.expression.expression : node.expression;
  if (!ts.isObjectLiteralExpression(expression)) return false;
  const kind = expression.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText(node.getSourceFile()) === 'kind',
  );
  return (
    kind !== undefined &&
    ts.isStringLiteral(kind.initializer) &&
    kind.initializer.text === 'held' &&
    expression.properties.some((property) => property.name?.getText(node.getSourceFile()) === 'settlement')
  );
}

function abandonmentSettlementViolations(source: ts.SourceFile): string[] {
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionScope(node)) {
      const name = functionName(node);
      if (name !== null && /abandon/iu.test(name)) {
        const body = descendants(node);
        const aborts = body.some(requestsCancellation);
        const releasesOwnership =
          body.some((candidate) => callsMethod(candidate, 'delete')) ||
          body.some((candidate) => returnsDisposition(candidate, new Set(['abandoned', 'operator-abandoned']))) ||
          body.some(
            (candidate) =>
              ts.isReturnStatement(candidate) &&
              candidate.expression !== undefined &&
              /abandonment/iu.test(candidate.expression.getText(source)),
          );
        if (aborts && releasesOwnership) {
          const joinsSettlement = body.some(
            (candidate) => ts.isAwaitExpression(candidate) && /settlement/iu.test(candidate.expression.getText(source)),
          );
          const returnsPending =
            body.some((candidate) => returnsDisposition(candidate, new Set(['retained', 'transfer-pending']))) ||
            body.some(returnsSettlementHold);
          if (!joinsSettlement && !returnsPending) {
            violations.push(`${source.fileName} :: ${name}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

describe('operator abandonment settles destructive attempts before release', () => {
  it('joins an aborted attempt or returns a transfer-pending hold', () => {
    const violations = sourceFiles(SOURCE_ROOT).flatMap((path) => abandonmentSettlementViolations(parseSource(path)));
    expect(violations).toEqual([]);
  });

  it.each([
    `function abandonCleanupOwnership() {
      cleanupAttemptToken += 1;
      cleanupAbort.abort();
      cleanupHandles.delete(cleanupKey);
      return { kind: 'abandoned' };
    }`,
    `function abandonHeldRecovery() {
      cancelHeldRecoveryReap(jobId);
      cleanupHandles.delete(cleanupKey);
      return { kind: 'abandoned' };
    }`,
  ])('rejects callback suppression followed by ownership release', (fixture) => {
    const source = parseSource('callback-suppression.ts', fixture);
    expect(abandonmentSettlementViolations(source)).toHaveLength(1);
  });

  it.each([
    `async function abandonCleanupOwnership() {
      cleanupAbort.abort();
      await cleanupSettlement;
      cleanupHandles.delete(cleanupKey);
      return { kind: 'abandoned' };
    }`,
    `function abandonCleanupOwnership() {
      cleanupAbort.abort();
      if (cleanupInFlight) return { kind: 'transfer-pending' };
      cleanupHandles.delete(cleanupKey);
      return { kind: 'abandoned' };
    }`,
    `function abandonCleanupOwnership() {
      cancelCleanupAttempt();
      if (cleanupInFlight) {
        return { kind: 'held', settlement: cleanupSettlement };
      }
      cleanupHandles.delete(cleanupKey);
      return { kind: 'abandoned' };
    }`,
  ])('accepts a settlement-bearing exit', (fixture) => {
    expect(abandonmentSettlementViolations(parseSource('settled-abandonment.ts', fixture))).toEqual([]);
  });
});
