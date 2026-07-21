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
const ALLOWLIST = new Set(['src/store/body-codec.ts']);

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function decodeEventBodyAliases(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const aliases = new Set<string>(['decodeEventBody']);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
    if (!ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName ?? element.name).text === 'decodeEventBody') aliases.add(element.name.text);
    }
  }
  return aliases;
}

function isDecodeEventBodyCall(expression: ts.Expression, aliases: ReadonlySet<string>): boolean {
  const current = unwrapExpression(expression);
  return ts.isCallExpression(current) && ts.isIdentifier(current.expression) && aliases.has(current.expression.text);
}

function isParseCall(node: ts.CallExpression): node is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
  return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'parse';
}

function resolvesToDecodedBody(expression: ts.Expression, aliases: ReadonlySet<string>): boolean {
  const current = unwrapExpression(expression);
  if (isDecodeEventBodyCall(current, aliases)) {
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
        return isDecodeEventBodyCall(declaration.initializer, aliases);
      }
      return false;
    }) ?? false
  );
}

function localVariableInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | undefined {
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node): void {
    if (
      initializer === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return initializer;
}

function isRawBodyExpression(expression: ts.Expression, sourceFile: ts.SourceFile): boolean {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current) && current.name.text === 'body') return true;
  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression !== undefined &&
    ts.isStringLiteral(current.argumentExpression) &&
    current.argumentExpression.text === 'body'
  ) {
    return true;
  }
  if (!ts.isIdentifier(current)) return false;
  const localInitializer = localVariableInitializer(sourceFile, current.text);
  if (localInitializer !== undefined && isRawBodyExpression(localInitializer, sourceFile)) return true;
  const symbol = CHECKER.getSymbolAtLocation(current);
  return (
    symbol?.declarations?.some(
      (declaration) =>
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        isRawBodyExpression(declaration.initializer, sourceFile),
    ) ?? false
  );
}

function isRawJsonParse(node: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'JSON' &&
    node.expression.name.text === 'parse' &&
    node.arguments[0] !== undefined &&
    isRawBodyExpression(node.arguments[0], sourceFile)
  );
}

function isRawBodyDecode(node: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'decode' &&
    node.arguments[0] !== undefined &&
    isRawBodyExpression(node.arguments[0], sourceFile)
  );
}

function formatViolation(sourceFile: ts.SourceFile, node: ts.Node, detail: string): string {
  const canonical = toCanonicalSrcPath(ROOT, sourceFile.fileName);
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${canonical}:${line + 1} ${detail}`;
}

function collectViolations(sourceFile: ts.SourceFile): string[] {
  const violations: string[] = [];
  const aliases = decodeEventBodyAliases(sourceFile);
  const rawSqlBodyRead = /(?:json_extract\s*\([^)]*\b(?:[a-z]+\.)?body\b|CAST\s*\(\s*(?:[a-z]+\.)?body\s+AS\s+TEXT)/iu;

  function visit(node: ts.Node): void {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) &&
      rawSqlBodyRead.test(node.getText(sourceFile))
    ) {
      violations.push(formatViolation(sourceFile, node, 'SQL reads events.body outside the current event body codec'));
    }

    if (
      (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) &&
      isDecodeEventBodyCall(node.expression, aliases)
    ) {
      const detail = ts.isAsExpression(node)
        ? 'decodeEventBody(...) as ... bypasses EventBodyCodec'
        : 'decodeEventBody(...) satisfies ... bypasses EventBodyCodec';
      violations.push(formatViolation(sourceFile, node, detail));
    }

    if (ts.isCallExpression(node)) {
      const [firstArgument] = node.arguments;
      if (isParseCall(node) && firstArgument && resolvesToDecodedBody(firstArgument, aliases)) {
        const detail = isDecodeEventBodyCall(firstArgument, aliases)
          ? '.parse(decodeEventBody(...)) bypasses EventBodyCodec'
          : '.parse(...) on a value sourced from decodeEventBody(...) bypasses EventBodyCodec';
        violations.push(formatViolation(sourceFile, node, detail));
      }
      if (isRawJsonParse(node, sourceFile)) {
        violations.push(formatViolation(sourceFile, node, 'JSON.parse reads a raw .body outside EventBodyCodec'));
      }
      if (isRawBodyDecode(node, sourceFile)) {
        violations.push(formatViolation(sourceFile, node, '.decode reads a raw .body outside EventBodyCodec'));
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

describe('event body codec routing invariant', () => {
  it('forbids raw read-side decode/parse bypasses outside the store codec allowlist', () => {
    const violations = FILES.flatMap((filePath) => {
      const canonical = toCanonicalSrcPath(ROOT, filePath);
      if (ALLOWLIST.has(canonical)) {
        return [];
      }

      const sourceFile =
        PROGRAM.getSourceFile(filePath) ??
        ts.createSourceFile(filePath, readFileSync(filePath, 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      return collectViolations(sourceFile);
    });

    expect(violations, 'Read-side event bodies must route through the current event body codec').toEqual([]);
  });

  it.each([
    ['JSON.parse', 'const decoded = JSON.parse(row.body);'],
    ['TextDecoder.decode', 'const decoded = new TextDecoder().decode(row.body);'],
    ['local raw-body alias', 'const raw = row.body;\nconst decoded = JSON.parse(raw);'],
    [
      'aliased decodeEventBody parse',
      "import { decodeEventBody as rawDecode } from './body-codec.js';\nconst decoded = schema.parse(rawDecode(row.body));",
    ],
  ])('detects the %s bypass mutation', (_label, source) => {
    const sourceFile = ts.createSourceFile('src/mutation.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(collectViolations(sourceFile)).not.toEqual([]);
  });
});
