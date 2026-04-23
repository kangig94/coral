import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { listProductionSourceFiles, toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = join(ROOT, 'src');
const FILES = listProductionSourceFiles(SRC_ROOT);
const PROGRAM = ts.createProgram(FILES, {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
});
const CHECKER = PROGRAM.getTypeChecker();
const ALLOWLIST = new Set([
  'src/store/body-codec.ts',
  'src/store/append.ts',
  'src/store/rebuild.ts',
  'src/store/envelope.ts',
]);

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isDecodeEventBodyCall(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression);
  return ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'decodeEventBody';
}

function isParseCall(node: ts.CallExpression): node is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
  return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'parse';
}

function resolvesToDecodedBody(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression);
  if (isDecodeEventBodyCall(current)) {
    return true;
  }

  if (!ts.isIdentifier(current)) {
    return false;
  }

  const symbol = CHECKER.getSymbolAtLocation(current);
  if (!symbol) {
    return false;
  }

  return (
    symbol.declarations?.some((declaration) => {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return isDecodeEventBodyCall(declaration.initializer);
      }
      return false;
    }) ?? false
  );
}

function formatViolation(sourceFile: ts.SourceFile, node: ts.Node, detail: string): string {
  const canonical = toCanonicalSrcPath(ROOT, sourceFile.fileName);
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${canonical}:${line + 1} ${detail}`;
}

function collectViolations(sourceFile: ts.SourceFile): string[] {
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if ((ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) && isDecodeEventBodyCall(node.expression)) {
      const detail = ts.isAsExpression(node)
        ? 'decodeEventBody(...) as ... bypasses UpcasterRegistry'
        : 'decodeEventBody(...) satisfies ... bypasses UpcasterRegistry';
      violations.push(formatViolation(sourceFile, node, detail));
    }

    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'rowToCoralEvent' && node.arguments.length === 1) {
        violations.push(
          formatViolation(sourceFile, node, 'rowToCoralEvent(row) uses the raw-body overload outside the allowlist'),
        );
      }

      const [firstArgument] = node.arguments;
      if (isParseCall(node) && firstArgument && resolvesToDecodedBody(firstArgument)) {
        const detail = isDecodeEventBodyCall(firstArgument)
          ? '.parse(decodeEventBody(...)) bypasses UpcasterRegistry'
          : '.parse(...) on a value sourced from decodeEventBody(...) bypasses UpcasterRegistry';
        violations.push(formatViolation(sourceFile, node, detail));
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

describe('upcast routing invariant (AC12)', () => {
  it('forbids raw read-side decode/parse bypasses outside the store codec allowlist', () => {
    const violations = FILES.flatMap((filePath) => {
      const canonical = toCanonicalSrcPath(ROOT, filePath);
      if (ALLOWLIST.has(canonical)) {
        return [];
      }

      const sourceFile =
        PROGRAM.getSourceFile(filePath)
        ?? ts.createSourceFile(filePath, readFileSync(filePath, 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      return collectViolations(sourceFile);
    });

    expect(violations, 'Read-side event bodies must route through upcast-aware decoding helpers').toEqual([]);
  });
});
