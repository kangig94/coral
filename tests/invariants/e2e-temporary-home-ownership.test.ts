import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = join(__dirname, '..', '..');
const E2E_ROOT = join(REPO_ROOT, 'tests', 'e2e');

type Violation = Readonly<{ file: string; line: number; text: string }>;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const directories = [root];
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

function propertyName(name: ts.PropertyName | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return null;
}

function assignedEnvironmentName(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined) {
    return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
  }
  return null;
}

function directHomeBindings(file: string, sourceText: string): Violation[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: Violation[] = [];

  function record(node: ts.Node): void {
    violations.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      text: node.getText(source),
    });
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      propertyName(node.name) === 'HOME'
    ) {
      record(node);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      assignedEnvironmentName(node.left) === 'HOME'
    ) {
      record(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return violations;
}

describe('e2e temporary HOME ownership', () => {
  it('routes every e2e HOME binding through the lifecycle owner', () => {
    const violations = sourceFiles(E2E_ROOT).flatMap((path) => {
      const file = relative(REPO_ROOT, path).replace(/\\/gu, '/');
      return directHomeBindings(file, readFileSync(path, 'utf-8'));
    });
    expect(violations).toEqual([]);
  });

  it.each([
    ['an object property', "const env = { HOME: mkdtempSync('/tmp/coral-') };"],
    ['a shorthand property', "const HOME = mkdtempSync('/tmp/coral-'); const env = { HOME };"],
    ['an ambient assignment', "process.env.HOME = mkdtempSync('/tmp/coral-');"],
    ['an element assignment', "process.env['HOME'] = mkdtempSync('/tmp/coral-');"],
  ])('rejects %s', (_label, source) => {
    expect(directHomeBindings('fixture.ts', source)).not.toHaveLength(0);
  });

  it('allows unrelated temporary directories and owner-routed HOME values', () => {
    const source = `
      const pluginRoot = mkdtempSync('/tmp/coral-plugin-');
      const env = { ...temporaryHomes.environment(home), TMPDIR: pluginRoot };
    `;
    expect(directHomeBindings('fixture.ts', source)).toEqual([]);
  });
});
