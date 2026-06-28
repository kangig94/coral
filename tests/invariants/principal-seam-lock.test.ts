import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { listProductionSourceFiles, toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');

const SCANNED_ROOTS = ['src/transport', 'src/kb-daemon'] as const;
const SCANNED_FILES = new Set([
  'src/kb/ops/source/import.ts',
  'src/coordinator/composition/index.ts',
  'src/coordinator/lifecycle.ts',
  'src/discuss/shell/runtime-services.ts',
  'src/cli/dispatch.ts',
]);
const REQUEST_AUTHORITY_LITERALS = new Set(['admin', 'user']);
const EXECUTE_CATALOG_REQUEST_AUTHORITY_ARG_INDEX = 3;

const PRODUCTION_FILE_PATHS = listProductionSourceFiles(SRC_ROOT);

type PrincipalSeamViolation = {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly literal: string;
  readonly shape: 'authority property' | 'executeCatalogRequest authority argument';
};

function isWithinPath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function isScannedFile(canonicalPath: string): boolean {
  return SCANNED_FILES.has(canonicalPath) || SCANNED_ROOTS.some((root) => isWithinPath(canonicalPath, root));
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  return null;
}

function expressionNameText(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

type LiteralHit = {
  readonly literal: string;
  readonly node: ts.Node;
};

function collectAuthorityLiterals(expression: ts.Expression): LiteralHit[] {
  const hits: LiteralHit[] = [];

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node) && REQUEST_AUTHORITY_LITERALS.has(node.text)) {
      hits.push({ literal: node.text, node });
      return;
    }

    if (
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isParenthesizedExpression(node)
    ) {
      visit(node.expression);
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(unwrapExpression(expression));
  return hits;
}

function formatLocation(sourceFile: ts.SourceFile, node: ts.Node): Pick<PrincipalSeamViolation, 'line' | 'column'> {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: location.line + 1, column: location.character + 1 };
}

function collectPrincipalSeamViolations(): string[] {
  const canonicalFiles = PRODUCTION_FILE_PATHS.map((filePath) => ({
    filePath,
    canonicalPath: toCanonicalSrcPath(REPO_ROOT, filePath),
  }));
  const scannedFiles = canonicalFiles.filter(({ canonicalPath }) => isScannedFile(canonicalPath));
  const missingScannedFiles = [...SCANNED_FILES]
    .filter((filePath) => !canonicalFiles.some(({ canonicalPath }) => canonicalPath === filePath))
    .map((filePath) => `${filePath}: expected seam file is missing`);
  const violations: PrincipalSeamViolation[] = [];

  for (const { filePath, canonicalPath } of scannedFiles) {
    const sourceText = readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    function visit(node: ts.Node): void {
      if (ts.isPropertyAssignment(node) && propertyNameText(node.name) === 'authority') {
        for (const { literal, node: literalNode } of collectAuthorityLiterals(node.initializer)) {
          violations.push({
            filePath: canonicalPath,
            ...formatLocation(sourceFile, literalNode),
            literal,
            shape: 'authority property',
          });
        }
      }

      if (ts.isCallExpression(node) && expressionNameText(node.expression) === 'executeCatalogRequest') {
        const authorityArgument = node.arguments[EXECUTE_CATALOG_REQUEST_AUTHORITY_ARG_INDEX];
        if (authorityArgument) {
          for (const { literal, node: literalNode } of collectAuthorityLiterals(authorityArgument)) {
            violations.push({
              filePath: canonicalPath,
              ...formatLocation(sourceFile, literalNode),
              literal,
              shape: 'executeCatalogRequest authority argument',
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return [
    ...missingScannedFiles,
    ...violations
      .sort((left, right) => {
        if (left.filePath !== right.filePath) {
          return left.filePath.localeCompare(right.filePath);
        }
        if (left.line !== right.line) {
          return left.line - right.line;
        }
        return left.column - right.column;
      })
      .map(
        (violation) =>
          `${violation.filePath}:${violation.line}:${violation.column}: request authority literal '${violation.literal}' in ${violation.shape}`,
      ),
  ];
}

describe('principal authorization seam lock', () => {
  it('forbids request-authority admin/user literals at transport and daemon seams', () => {
    expect(collectPrincipalSeamViolations()).toEqual([]);
  });
});
