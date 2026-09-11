import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE_ROOT = resolve(REPO_ROOT, 'tests/invariants/fixtures/operator-command-rendering');

type OperatorOutputSurface = Readonly<{
  path: string;
  renderers: ReadonlySet<string>;
  functions?: ReadonlySet<string>;
}>;

const OPERATOR_OUTPUT_SURFACES: readonly OperatorOutputSurface[] = [
  {
    path: 'src/cli/format/backend.ts',
    renderers: new Set(['renderBackendOperatorCommand']),
  },
  {
    path: 'src/recovery/provider-operation-remedy.ts',
    renderers: new Set(['renderRecoveryQuarantineCommand']),
  },
  {
    path: 'src/cli/commands/backend.ts',
    renderers: new Set(),
    functions: new Set([
      'clearRecoveryQuarantineWithCoordinator',
      'discardUnreadableProviderOperationWithCoordinator',
      'recoveryCoordinatorRequiredError',
    ]),
  },
];

type CommandLiteral = Readonly<{ functionName: string | null; line: number; text: string }>;

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function containingFunctionName(node: ts.Node): string | null {
  let current = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text ?? null;
    current = current.parent;
  }
  return null;
}

function isLiteralToken(node: ts.Node): boolean {
  return (
    ts.isStringLiteralLike(node) ||
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail
  );
}

function commandLiterals(sourceFile: ts.SourceFile, functions?: ReadonlySet<string>): CommandLiteral[] {
  const literals: CommandLiteral[] = [];
  const visit = (node: ts.Node): void => {
    if (isLiteralToken(node) && node.getText(sourceFile).includes('coral-cli')) {
      literals.push({
        functionName: containingFunctionName(node),
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        text: node.getText(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return functions === undefined
    ? literals
    : literals.filter(({ functionName }) => functionName !== null && functions.has(functionName));
}

function violations(
  sourceFile: ts.SourceFile,
  renderers: ReadonlySet<string>,
  functions?: ReadonlySet<string>,
): CommandLiteral[] {
  return commandLiterals(sourceFile, functions).filter(
    ({ functionName }) => functionName === null || !renderers.has(functionName),
  );
}

function declaredFunctionNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  return new Set(
    sourceFile.statements
      .filter(ts.isFunctionDeclaration)
      .map(({ name }) => name?.text)
      .filter((name): name is string => name !== undefined),
  );
}

function readFixture(name: string): ts.SourceFile {
  const path = resolve(FIXTURE_ROOT, `${name}.ts.txt`);
  return parse(path, readFileSync(path, 'utf8'));
}

describe('operator commands are rendered, not embedded in prose', () => {
  it('keeps coral-cli literals inside the command renderers on the owned output surfaces', () => {
    for (const surface of OPERATOR_OUTPUT_SURFACES) {
      const path = resolve(REPO_ROOT, surface.path);
      const sourceFile = parse(path, readFileSync(path, 'utf8'));
      const literals = commandLiterals(sourceFile, surface.functions);

      expect(violations(sourceFile, surface.renderers, surface.functions), surface.path).toEqual([]);
      expect(new Set(literals.map(({ functionName }) => functionName)), surface.path).toEqual(surface.renderers);
      if (surface.functions !== undefined) {
        const declared = declaredFunctionNames(sourceFile);
        expect(
          [...surface.functions].filter((name) => !declared.has(name)),
          surface.path,
        ).toEqual([]);
      }
    }
  });

  it('rejects command literals in prose strings and templates', () => {
    expect(violations(readFixture('negative'), new Set(['renderBackendOperatorCommand']))).toHaveLength(2);
  });

  it('checks only named branch-owned functions on a grandfathered surface', () => {
    expect(
      violations(readFixture('negative'), new Set(), new Set(['formatStatusRefusal'])).map(
        ({ functionName }) => functionName,
      ),
    ).toEqual(['formatStatusRefusal']);
  });

  it('accepts command construction inside the designated renderer', () => {
    expect(violations(readFixture('positive'), new Set(['renderBackendOperatorCommand']))).toEqual([]);
  });
});
